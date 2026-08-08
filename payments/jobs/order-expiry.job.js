/**
 * Job — Expiration des commandes non acceptées (délai 15 minutes)
 *
 * Le commerce a 15 minutes (commandes.acceptation_limite_at, armé à la
 * confirmation du paiement) pour accepter la commande. Passé ce délai :
 *
 *   1. les sous-commandes encore « en_attente » passent à « remboursee » via un
 *      update conditionnel (CAS sur `statut = 'en_attente'`) : une commande
 *      acceptée entre-temps n'est JAMAIS écrasée ;
 *   2. la commande est synchronisée (remboursee / partiellement_acceptee) ;
 *   3. remboursement automatique :
 *        - expiration TOTALE → refund PawaPay du dépôt (retour Mobile Money ;
 *          le webhook libère l'escrow) avec repli sûr sur le solde GoLivra ;
 *        - expiration PARTIELLE → remboursement ciblé des escrows des seules
 *          sous-commandes non acceptées, crédité sur le solde GoLivra ;
 *   4. le client est notifié : « Votre remboursement est en cours. »
 *
 * Idempotence : updates CAS, escrows par statut, refundId PawaPay déterministe
 * (`golivra-refund-<paiementId>`), crédits wallet par referenceId, et
 * `expiree_at` posé en dernier → un crash intermédiaire est repris au tick suivant.
 */

const paymentRepo = require('../repositories/payment.repository');
const escrowService = require('../services/escrow.service');
const pawapay = require('../services/pawapay.service');
const { getDb } = require('../../config/db');
const { info: logInfo, error: logError, warn: logWarn } = require('../../utils/logger');

const ENABLED = process.env.ORDER_EXPIRY_ENABLED !== '0';
const MOTIF = 'Commande non confirmée par le commerce dans le délai de 5 minutes';
/** Rappel envoyé au commerce quand il reste <= 3 minutes pour répondre. */
const RAPPEL_AVANT_MIN = 3;
/** Motif d'annulation quand le client ne paie pas dans le délai imparti. */
const MOTIF_PAIEMENT_EXPIRE = "Le client n'a pas effectué le paiement dans le délai imparti";

async function insertRemboursement(db, { commandeId, paiementId, montant }) {
  try {
    const { data, error } = await db
      .from('remboursements')
      .insert({
        commande_id: commandeId,
        paiement_id: paiementId || null,
        montant: montant || 0,
        raison: MOTIF,
        statut: 'en_attente',
      })
      .select('id')
      .maybeSingle();
    if (error) return null;
    return data?.id || null;
  } catch {
    return null; // table absente : le remboursement continue sans trace
  }
}

async function updateRemboursement(db, id, patch) {
  if (!id) return;
  try {
    await db
      .from('remboursements')
      .update({ ...patch, traite_le: new Date().toISOString() })
      .eq('id', id);
  } catch {
    /* best-effort */
  }
}

async function latestRemboursementStatut(db, commandeId) {
  try {
    const { data } = await db
      .from('remboursements')
      .select('statut')
      .eq('commande_id', commandeId)
      .order('cree_le', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data?.statut || null;
  } catch {
    return null;
  }
}

/** Repli sûr : libère les escrows et crédite le solde GoLivra du client. */
async function refundEscrowsToWallet(db, commandeId, remboursementId, montant) {
  try {
    await escrowService.refundAllForCommande(db, commandeId, {
      motif: MOTIF,
      payoutClient: false, // crédite le wallet interne du client
    });
    await updateRemboursement(db, remboursementId, { statut: 'termine' });
    return montant;
  } catch (err) {
    logError({ msg: 'orderExpiryJob_refund_wallet_echec', commandeId, error: err.message });
    await updateRemboursement(db, remboursementId, { statut: 'echoue' });
    return 0;
  }
}

/** Expiration partielle : rembourse uniquement les escrows des sous-commandes non acceptées. */
async function refundPartialToWallet(db, commandeId, enAttenteIds) {
  const { data: escrows, error } = await db
    .from('escrows')
    .select('*')
    .eq('commande_id', commandeId);
  if (error) throw error;

  const ids = new Set(enAttenteIds);
  let total = 0;
  for (const e of escrows || []) {
    if (!ids.has(e.metadata?.sousCommandeId)) continue;
    if (e.statut !== 'bloque' && e.statut !== 'en_attente') continue;
    try {
      const r = await escrowService.refund(db, e.id, { motif: MOTIF, payoutClient: false });
      total += Number(r.montantFcfa || 0);
    } catch (err) {
      logWarn({ msg: 'orderExpiryJob_refund_partiel', escrowId: e.id, error: err.message });
    }
  }
  return total;
}

/** Après coup : plus aucune sous-commande en attente (acceptées ou déjà traitées). */
async function finalizeAlreadyHandled(db, commande) {
  const now = new Date().toISOString();
  const { data: cmd } = await db.from('commandes').select('statut').eq('id', commande.id).maybeSingle();

  if (cmd && (cmd.statut === 'remboursee' || cmd.statut === 'annulee')) {
    // Reprise après un crash : aucun escrow ne doit rester bloqué — sauf si un
    // refund PawaPay est déjà en vol (le webhook s'en charge).
    const statut = await latestRemboursementStatut(db, commande.id);
    if (statut !== 'en_cours') {
      await refundEscrowsToWallet(db, commande.id, null, Number(commande.total || 0));
    }
  }

  await db.from('commandes').update({ expiree_at: now, updated_at: now }).eq('id', commande.id);
  return { expirees: 0, remboursees: 0, dejaTraitee: true };
}

async function expireCommande(db, commande) {
  const now = new Date().toISOString();

  const { data: scs, error: scErr } = await db
    .from('sous_commandes')
    .select('id, statut')
    .eq('commande_id', commande.id);
  if (scErr) throw scErr;

  const enAttente = (scs || []).filter((s) => s.statut === 'en_attente');
  if (enAttente.length === 0) {
    return finalizeAlreadyHandled(db, commande);
  }

  const fullExpiry = enAttente.length === (scs || []).length;

  // 1. CAS : 'en_attente' → 'remboursee'. Une sous-commande acceptée entre le
  //    select et l'update (le vendeur a cliqué dans le délai) n'est pas écrasée.
  let expirees = 0;
  for (const sc of enAttente) {
    const { data, error } = await db
      .from('sous_commandes')
      .update({ statut: 'remboursee', expiree_at: now, updated_at: now })
      .eq('id', sc.id)
      .eq('statut', 'en_attente')
      .select('id')
      .maybeSingle();
    if (!error && data) expirees += 1;
  }
  if (expirees === 0) {
    return finalizeAlreadyHandled(db, commande);
  }

  // 2. Synchronise le statut de la commande parente.
  const { syncCommandeStatutFromSousCommandes } = require('../../services/order.service');
  await syncCommandeStatutFromSousCommandes(db, commande.id).catch((err) =>
    logWarn({ msg: 'orderExpiryJob_sync', commandeId: commande.id, error: err.message }),
  );

  // 3. Remboursement automatique (idempotent).
  let rembourse = false;
  const paiement = await paymentRepo.findLatestForCommande(db, commande.id);
  if (paiement && String(paiement.statut).trim() === 'valide') {
    if (fullExpiry) {
      // Toute la commande a expiré → refund PawaPay complet (retour Mobile Money).
      const montant = Number(paiement.montantFcfa ?? commande.total ?? 0);
      const remboursementId = await insertRemboursement(db, {
        commandeId: commande.id,
        paiementId: paiement.id,
        montant,
      });

      if (paiement.pawapayDepositId) {
        // refundId déterministe : un éventuel retry ne crée pas de double refund.
        const refundId = `golivra-refund-${paiement.id}`;
        const res = await pawapay.initiateRefund({
          refundId,
          depositId: paiement.pawapayDepositId,
          montantFcfa: montant,
          motif: MOTIF,
          metadata: [{ fieldName: 'commandeId', fieldValue: commande.id }],
        });
        if (res && res.ok) {
          // En cours : le webhook PawaPay confirmera le retour sur le numéro du
          // client et libérera l'escrow (payoutClient: true).
          await updateRemboursement(db, remboursementId, {
            statut: 'en_cours',
            pawapay_refund_id: refundId,
            reference_externe: refundId,
          });
          rembourse = true;
        } else {
          // Repli sûr si PawaPay refuse le refund (aucune double-émission : escrow idempotent).
          logWarn({ msg: 'orderExpiryJob_refund_init_echec', commandeId: commande.id, error: res?.error });
          const r = await refundEscrowsToWallet(db, commande.id, remboursementId, montant);
          rembourse = r > 0;
        }
      } else {
        // Pas de dépôt PawaPay traçable : remboursement sur le solde GoLivra.
        const r = await refundEscrowsToWallet(db, commande.id, remboursementId, montant);
        rembourse = r > 0;
      }
    } else {
      // Expiration partielle : seuls les commerces n'ayant pas accepté sont
      // remboursés (les escrows des sous-commandes acceptées restent bloqués et
      // seront libérés à la livraison, comme prévu).
      const total = await refundPartialToWallet(
        db,
        commande.id,
        enAttente.map((s) => s.id),
      );
      const remboursementId = await insertRemboursement(db, {
        commandeId: commande.id,
        paiementId: paiement.id,
        montant: total || 0,
      });
      await updateRemboursement(db, remboursementId, { statut: total > 0 ? 'termine' : 'echoue' });
      rembourse = total > 0;
    }
  }

  // 4. Notifications (client + vendeurs).
  try {
    const { notifyOrderExpired } = require('../../services/order-notify.service');
    await notifyOrderExpired(db, commande.id, { remboursementEnCours: rembourse });
  } catch (err) {
    logWarn({ msg: 'orderExpiryJob_notify', commandeId: commande.id, error: err.message });
  }

  // 5. Fige l'expiration EN DERNIER : toutes les étapes ci-dessus sont
  //    idempotentes, un crash intermédiaire est donc repris au tick suivant.
  await db.from('commandes').update({ expiree_at: now, updated_at: now }).eq('id', commande.id);

  return { expirees, remboursees: rembourse ? 1 : 0 };
}

/**
 * Rappel d'acceptation : quand il reste <= 3 min au commerce pour répondre,
 * on notifie le vendeur UNE SEULE FOIS (gardé par acceptation_rappel_at).
 */
async function sendAcceptanceReminders(db) {
  const nowIso = new Date().toISOString();
  const seuil = new Date(Date.now() + RAPPEL_AVANT_MIN * 60 * 1000).toISOString();
  const { data: rows, error } = await db
    .from('commandes')
    .select('id')
    .in('statut', ['en_attente', 'partiellement_acceptee'])
    .is('acceptation_rappel_at', null)
    .gt('acceptation_limite_at', nowIso)
    .lt('acceptation_limite_at', seuil)
    .limit(20);
  if (error) throw error;

  let rappels = 0;
  for (const cmd of rows || []) {
    try {
      const { notifyAcceptanceReminder } = require('../../services/order-notify.service');
      await notifyAcceptanceReminder(db, cmd.id);
      await db
        .from('commandes')
        .update({ acceptation_rappel_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', cmd.id);
      rappels += 1;
    } catch (err) {
      logError({ msg: 'orderExpiryJob_rappel', commandeId: cmd.id, error: err.message });
    }
  }
  return rappels;
}

/**
 * Délai de paiement expiré (5 min après acceptation) : le client n'a pas payé
 * → la commande est annulée (rien n'a été débité, aucun remboursement requis)
 * et chaque commerce concerné retrouve ses activités.
 */
async function expireCommandesNonPayees(db) {
  const { data: rows, error } = await db
    .from('commandes')
    .select('id')
    .in('statut', ['acceptee', 'partiellement_acceptee'])
    .not('paiement_limite_at', 'is', null)
    .lt('paiement_limite_at', new Date().toISOString())
    .limit(20);
  if (error) throw error;

  let expirees = 0;
  for (const cmd of rows || []) {
    try {
      const { data: paiement } = await db
        .from('paiements')
        .select('statut, pawapay_deposit_id')
        .eq('commande_id', cmd.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (paiement?.statut === 'valide') continue; // payé juste avant : on ne touche à rien
      // Grâce anti-course : un dépôt PawaPay initié (en_attente avec id dépôt)
      // signifie que le client a payé et que le webhook va confirmer — on ne
      // doit PAS annuler la commande entre-temps, sinon le paiement arriverait
      // sur une commande annulée (remboursé ensuite, mais commande perdue à tort).
      if (paiement?.statut === 'en_attente' && paiement.pawapay_deposit_id) continue;

      const now = new Date().toISOString();
      const { data: scs } = await db.from('sous_commandes').select('id, statut').eq('commande_id', cmd.id);
      for (const sc of scs || []) {
        if (sc.statut === 'acceptee' || sc.statut === 'en_attente') {
          await db
            .from('sous_commandes')
            .update({ statut: 'annulee', raison_refus: MOTIF_PAIEMENT_EXPIRE, updated_at: now })
            .eq('id', sc.id);
        }
      }

      const { syncCommandeStatutFromSousCommandes } = require('../../services/order.service');
      await syncCommandeStatutFromSousCommandes(db, cmd.id).catch((err) =>
        logWarn({ msg: 'orderExpiryJob_sync_paiement', commandeId: cmd.id, error: err.message }),
      );
      await db
        .from('commandes')
        .update({
          annulation_motif: MOTIF_PAIEMENT_EXPIRE,
          expiree_at: now,
          paiement_limite_at: null,
          updated_at: now,
        })
        .eq('id', cmd.id);

      const { notifyPaymentDeadlineExpired } = require('../../services/order-notify.service');
      await notifyPaymentDeadlineExpired(db, cmd.id).catch((err) =>
        logWarn({ msg: 'orderExpiryJob_notify_paiement', commandeId: cmd.id, error: err.message }),
      );
      expirees += 1;
    } catch (err) {
      logError({ msg: 'orderExpiryJob_expire_paiement', commandeId: cmd.id, error: err.message });
    }
  }
  return expirees;
}

async function runOnce() {
  if (!ENABLED) return { skipped: true, reason: 'ORDER_EXPIRY_ENABLED=0' };
  const db = getDb();

  // `remboursee` est inclus pour reprendre une commande restée bloquée après un
  // crash (expiree_at posé en dernier). L'idempotence garantit l'innocuité.
  const { data: expired, error } = await db
    .from('commandes')
    .select('id, client_id, total, acceptation_limite_at, expiree_at')
    .in('statut', ['en_attente', 'partiellement_acceptee', 'remboursee'])
    .is('expiree_at', null)
    .not('acceptation_limite_at', 'is', null)
    .lt('acceptation_limite_at', new Date().toISOString())
    .limit(50);
  if (error) throw error;

  const results = {
    scanned: (expired || []).length,
    expirees: 0,
    remboursees: 0,
    rappels: 0,
    paiements_expires: 0,
    erreurs: 0,
  };
  for (const cmd of expired || []) {
    try {
      const r = await expireCommande(db, cmd);
      results.expirees += r.expirees || 0;
      results.remboursees += r.remboursees || 0;
    } catch (err) {
      results.erreurs += 1;
      logError({ msg: 'orderExpiryJob_expire', commandeId: cmd.id, error: err.message });
    }
  }

  // Rappel d'acceptation (<= 3 min restantes) + délai de paiement expiré.
  try {
    results.rappels = await sendAcceptanceReminders(db);
  } catch (err) {
    results.erreurs += 1;
    logError({ msg: 'orderExpiryJob_rappels', error: err.message });
  }
  try {
    results.paiements_expires = await expireCommandesNonPayees(db);
  } catch (err) {
    results.erreurs += 1;
    logError({ msg: 'orderExpiryJob_paiements', error: err.message });
  }

  if (results.scanned > 0 || results.rappels > 0 || results.paiements_expires > 0 || results.erreurs > 0) {
    logInfo({ msg: 'orderExpiryJob_tick', ...results });
  }
  return results;
}

module.exports = { runOnce, expireCommande };
