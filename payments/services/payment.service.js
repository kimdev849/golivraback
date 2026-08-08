/**
 * Service — Payment (initiation d'un paiement client)
 *
 * Orchestre :
 *   1. Vérification de la commande (propriétaire, statut, montant)
 *   2. Création / récupération de la ligne `paiements`
 *   3. Appel PawaPay (live ou simulation)
 *   4. Mise à jour de la ligne paiement (statut, références)
 *
 * Le `hold` (escrow) est déclenché par les webhooks PawaPay, pas ici.
 */

const paymentRepo = require('../repositories/payment.repository');
const pawapay = require('./pawapay.service');
const { createHttpError } = require('../../utils/http');
const { info: logInfo, warn: logWarn, error: logError } = require('../../utils/logger');

const PAYMENT_MODE = String(process.env.PAYMENT_MODE || 'test').toLowerCase();

function isTestPaymentMode() {
  return ['test', 'mock', 'dev'].includes(PAYMENT_MODE) || !pawapay.isLive();
}

/**
 * Nouveau parcours « paiement après acceptation » :
 *   - la commande n'est payable qu'une fois acceptée (toutes les réponses
 *     réunies, au moins un commerce accepté) ;
 *   - le client ne paie QUE les segments acceptés (jamais les refusés/expirés),
 *     plafonné au total initial de la commande (jamais plus cher).
 */
const PAYABLE_SC_STATUTS = new Set([
  'acceptee',
  'en_preparation',
  'prete',
  'collectee',
  'livree',
]);
const PAYABLE_COMMANDE_STATUTS = new Set(['acceptee', 'partiellement_acceptee']);

async function computePayableAmount(db, commande) {
  const { data: scs, error } = await db
    .from('sous_commandes')
    .select('id, total, statut')
    .eq('commande_id', commande.id);
  if (error) throw error;
  let sum = 0;
  for (const sc of scs || []) {
    if (PAYABLE_SC_STATUTS.has(sc.statut)) sum += Number(sc.total ?? 0);
  }
  const cap = Math.max(0, Math.round(Number(commande.total ?? 0)));
  return Math.min(Math.round(sum), cap);
}

function newDepositId() {
  return `dp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Vérifie qu'une commande existe et appartient bien au client.
 */
async function assertOrderOwnedByClient(db, commandeId, clientId) {
  const { data: commande, error } = await db
    .from('commandes')
    .select('id, client_id, total, methode_paiement, statut, paiement_limite_at')
    .eq('id', commandeId)
    .maybeSingle();
  if (error) throw error;
  if (!commande) throw createHttpError(404, 'Commande introuvable.');
  if (commande.client_id !== clientId) throw createHttpError(403, 'Accès non autorisé.');
  return commande;
}

/**
 * Récupère (ou crée) le paiement en attente pour une commande.
 * Le schéma de la plateforme crée déjà un paiement `en_attente` lors de
 * la création de la commande, mais on garde un fallback pour la robustesse.
 */
async function ensurePendingPayment(db, commande, utilisateurId, payload, montantFcfa) {
  const existing = await paymentRepo.findLatestForCommande(db, commande.id);
  if (existing) {
    if (existing.statut === 'valide') return existing;
    if (existing.statut === 'en_attente' || existing.statut === 'echoue') {
      // Met à jour avec la nouvelle méthode / provider + montant à payer réel
      return paymentRepo.update(db, existing.id, {
        methode: payload.methode,
        montant: montantFcfa ?? Number(commande.total ?? 0),
        provider_country: payload.providerCountry || null,
        provider_correspondent: payload.providerCorrespondent || null,
        statut: 'en_attente',
        failure_reason: null,
      });
    }
    return existing;
  }
  return paymentRepo.create(db, {
    commandeId: commande.id,
    utilisateurId,
    montantFcfa: montantFcfa ?? Number(commande.total ?? 0),
    methode: payload.methode,
    providerCountry: payload.providerCountry,
    providerCorrespondent: payload.providerCorrespondent,
    statut: 'en_attente',
  });
}

/**
 * Initie le paiement d'une commande.
 * @returns {Promise<{ paiement, commande, simulation: boolean }>}
 */
async function initiate(db, commandeId, clientId, payload) {
  const commande = await assertOrderOwnedByClient(db, commandeId, clientId);

  // Nouveau parcours : la commande n'est payable qu'une fois acceptée par au
  // moins un commerce, et avant l'expiration du délai de paiement (5 min).
  if (!PAYABLE_COMMANDE_STATUTS.has(commande.statut)) {
    throw createHttpError(400, 'La commande doit être acceptée avant le paiement.');
  }
  const paiementLimite = commande.paiement_limite_at
    ? new Date(commande.paiement_limite_at).getTime()
    : null;
  if (paiementLimite != null && Date.now() > paiementLimite) {
    throw createHttpError(400, 'Le délai de paiement (5 minutes) est expiré : la commande a été annulée.');
  }

  // Le client ne paie que les segments acceptés (jamais plus que le total initial).
  const montantFcfa = await computePayableAmount(db, commande);
  const paiement = await ensurePendingPayment(db, commande, clientId, payload, montantFcfa);

  if (paiement.statut === 'valide') {
    return { paiement, commande, dejaValide: true, simulation: false };
  }

  // Vérifie que le paiement a un montant
  if (Number(paiement.montantFcfa) <= 0) {
    throw createHttpError(400, 'Montant de paiement invalide.');
  }

  // Mode test : on simule un succès immédiat
  if (isTestPaymentMode() && !pawapay.isLive()) {
    const now = new Date().toISOString();
    const reference = `TEST_${Date.now()}`;
    const updated = await paymentRepo.update(db, paiement.id, {
      statut: 'valide',
      reference_externe: reference,
      numero_transaction: reference,
      paye_at: now,
      metadata: {
        ...(paiement.metadata || {}),
        mode: 'test',
        paid_at: now,
        provider: payload.methode === 'mtn_money' ? 'mtn' : 'airtel',
      },
    });
    return { paiement: updated, commande, simulation: true, dejaValide: false };
  }

  // Live : appel PawaPay
  const depositId = newDepositId();
  const providerCorrespondent = payload.providerCorrespondent || pawapay.countryToCorrespondent('CG', payload.methode);
  const phoneNumber = String(payload.numeroCompte || payload.numero_compte || '').trim();
  if (!phoneNumber) {
    throw createHttpError(400, 'Numéro Mobile Money requis pour le paiement live.');
  }
  const apiRes = await pawapay.initiateDeposit({
    depositId,
    montantFcfa: Number(paiement.montantFcfa),
    currency: 'XAF',
    methode: payload.methode,
    numeroCompte: phoneNumber,
    pays: payload.providerCountry || 'CG',
    metadata: [
      { fieldName: 'paiementId', fieldValue: paiement.id },
      { fieldName: 'commandeId', fieldValue: commande.id },
      { fieldName: 'utilisateurId', fieldValue: clientId },
    ],
    // Contexte sandbox : le backend swappe le numéro en interne si besoin
    sandboxContext: {
      utilisateurId: clientId,
      commandeId: commande.id,
    },
  });

  if (!apiRes.ok) {
    await paymentRepo.update(db, paiement.id, {
      statut: 'echoue',
      failure_reason: apiRes.error || 'pawapay_error',
    });
    throw createHttpError(502, `PawaPay injoignable : ${apiRes.error || 'erreur inconnue'}`);
  }

  if (apiRes.simulated) {
    // Mode test (clé présente mais endpoint fake) — on simule le succès
    const now = new Date().toISOString();
    const updated = await paymentRepo.update(db, paiement.id, {
      statut: 'valide',
      pawapay_deposit_id: depositId,
      reference_externe: depositId,
      numero_transaction: depositId,
      paye_at: now,
      metadata: { ...(paiement.metadata || {}), mode: 'simulated_live', paid_at: now },
    });
    return { paiement: updated, commande, simulation: true, dejaValide: false };
  }

  // Live OK : on stocke l'identifiant PawaPay, on attend le webhook
  const updated = await paymentRepo.update(db, paiement.id, {
    pawapay_deposit_id: depositId,
    provider_correspondent: providerCorrespondent,
    metadata: {
      ...(paiement.metadata || {}),
      pawapay_request: apiRes.data || null,
      requested_at: new Date().toISOString(),
    },
  });
  return { paiement: updated, commande, simulation: false, dejaValide: false };
}

/**
 * Vérifie qu'une commande est payée (utilisé en aval).
 */
async function assertCommandePayee(db, commandeId) {
  const paiement = await paymentRepo.findLatestForCommande(db, commandeId);
  if (!paiement || paiement.statut !== 'valide') {
    throw createHttpError(402, 'Le paiement doit être validé avant de traiter la commande.');
  }
  return paiement;
}

/**
 * Permet à l'admin / système de marquer un paiement comme échoué (en cas
 * de timeout PawaPay par exemple).
 */
async function markAsFailed(db, paiementId, raison) {
  return paymentRepo.update(db, paiementId, {
    statut: 'echoue',
    failure_reason: raison || 'Echec paiement',
  });
}

module.exports = {
  PAYMENT_MODE,
  isTestPaymentMode,
  initiate,
  assertOrderOwnedByClient,
  assertCommandePayee,
  ensurePendingPayment,
  markAsFailed,
};
