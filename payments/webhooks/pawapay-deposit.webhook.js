/**
 * Webhook PawaPay — deposit (paiement client)
 *
 * Réception des événements de paiement Mobile Money.
 * - COMPLETED → met le paiement "valide" et déclenche l'escrow
 * - FAILED    → met le paiement "echoue"
 * - autres    → ignorés
 */

const crypto = require('crypto');
const paymentRepo = require('../repositories/payment.repository');
const escrowService = require('../services/escrow.service');
const withdrawalRepo = require('../repositories/withdrawal.repository');
const { pickString, isSuccessStatus, isFailedStatus, extractMetadata, extractPawapayId } = require('../dto/webhook.dto');
const { info: logInfo, warn: logWarn, error: logError } = require('../../utils/logger');

const WEBHOOK_SECRET = process.env.PAWAPAY_WEBHOOK_SECRET;

function verifySignature(rawBody, signatureHeader) {
  if (!WEBHOOK_SECRET) return { ok: true, skipped: true };
  if (!signatureHeader) return { ok: false, reason: 'header_manquant' };
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody || '').digest('hex');
  const provided = String(signatureHeader).replace(/^sha256=/, '').trim();
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(provided, 'hex');
    if (a.length !== b.length) return { ok: false, reason: 'longueur_invalide' };
    return { ok: crypto.timingSafeEqual(a, b) };
  } catch {
    return { ok: false, reason: 'signature_invalide' };
  }
}

async function findPaiement(db, { depositId, meta }) {
  if (depositId) {
    const p = await paymentRepo.findByDepositId(db, depositId);
    if (p) return p;
  }
  const paiementId = pickString(meta.paiementId, meta.paiement_id);
  if (paiementId) {
    const p = await paymentRepo.findById(db, paiementId);
    if (p) return p;
  }
  const commandeId = pickString(meta.commandeId, meta.commande_id);
  if (commandeId) {
    return paymentRepo.findLatestForCommande(db, commandeId);
  }
  return null;
}

async function logEvent(db, { depositId, status, paiementId, payload }) {
  if (!depositId) return { inserted: false, reason: 'pawapay_id_manquant' };
  // Le journal pawapay_events est conservé pour rétro-compat avec l'existant
  const { data, error } = await db
    .from('pawapay_events')
    .insert({
      event_type: 'deposit',
      pawapay_id: depositId,
      status: status || null,
      paiement_id: paiementId || null,
      payload: payload || {},
    })
    .select('id')
    .maybeSingle();
  if (error) {
    if (/unique|duplicate/i.test(error.message || '')) {
      return { inserted: false, duplicate: true };
    }
    throw error;
  }
  return { inserted: true, id: data?.id };
}

async function handle(db, payload, { rawBody, signature } = {}) {
  const sigCheck = verifySignature(rawBody || (typeof payload === 'string' ? payload : JSON.stringify(payload || {})), signature);
  if (!sigCheck.ok) {
    logWarn({ msg: 'pawapay_deposit_signature_invalide', reason: sigCheck.reason });
    return { ok: false, code: 'SIGNATURE_INVALIDE' };
  }

  const status = pickString(payload.status, payload.transactionStatus, payload.State);
  const depositId = extractPawapayId('deposit', payload);
  const meta = extractMetadata(payload.metadata);

  const paiement = await findPaiement(db, { depositId, meta });
  logInfo({ msg: 'pawapay_deposit_webhook', depositId, status, paiementId: paiement?.id });

  try {
    const log = await logEvent(db, { depositId, status, paiementId: paiement?.id, payload });
    if (log.duplicate) return { ok: true, dejaTraite: true };
  } catch (err) {
    logError({ msg: 'pawapay_deposit_log_failed', error: err.message });
  }

  if (!paiement) {
    // Paiement d'une LIVRAISON externe (le commerce paie les frais de
    // livraison) : le webhook confirme le paiement puis ouvre la course aux
    // livreurs disponibles (et prévient le commerce).
    try {
      const {
        findLivraisonByDepositId,
        confirmExternalDeliveryPayment,
        markExternalDeliveryPaymentFailed,
      } = require('../../services/external-delivery.service');
      const livraison = await findLivraisonByDepositId(db, depositId);
      if (livraison) {
        const snap =
          livraison.adresse_livraison_snapshot &&
          typeof livraison.adresse_livraison_snapshot === 'object'
            ? livraison.adresse_livraison_snapshot
            : {};
        if (isSuccessStatus(status)) {
          if (snap.paiement_statut === 'valide') {
            return { ok: true, dejaValide: true, livraison_id: livraison.id };
          }
          await confirmExternalDeliveryPayment(db, livraison.id, { depositId });
          return { ok: true, livraison_id: livraison.id, paiement_confirme: true };
        }
        if (isFailedStatus(status)) {
          await markExternalDeliveryPaymentFailed(db, livraison.id, status);
          return { ok: true, livraison_id: livraison.id, paiement_echec: true };
        }
        return { ok: true, ignored: 'statut_ignore', status, livraison_id: livraison.id };
      }
    } catch (err) {
      logWarn({ msg: 'pawapay_deposit_livraison_fallback', depositId, error: err.message });
    }
    return { ok: true, ignored: 'paiement_introuvable' };
  }

  if (isSuccessStatus(status)) {
    if (paiement.statut === 'valide') return { ok: true, dejaValide: true };
    const now = new Date().toISOString();
    const updated = await paymentRepo.update(db, paiement.id, {
      statut: 'valide',
      pawapay_deposit_id: depositId || paiement.pawapayDepositId,
      reference_externe: depositId || paiement.referenceExterne,
      numero_transaction: depositId || paiement.numeroTransaction,
      paye_at: now,
      metadata: { ...(paiement.metadata || {}), pawapay_deposit: { payload, received_at: now } },
    });

    // Déclenche l'escrow
    try {
      const { escrows, totalBloqueFcfa } = await escrowService.hold(db, updated.commandeId, updated.id);

      // Délai d'acceptation : le commerce a 5 min pour accepter. Dans le nouveau
      // parcours, l'acceptation précède le paiement → on réarme uniquement pour
      // les commandes encore en attente (rétro-compat : anciennes versions de
      // l'app qui paient avant l'acceptation).
      const { data: cmd } = await db
        .from('commandes')
        .select('statut, expiree_at')
        .eq('id', updated.commandeId)
        .maybeSingle();
      if (cmd) {
        const patch = {
          // Le paiement est validé → le délai de paiement du client (5 min)
          // n'a plus lieu d'être.
          paiement_limite_at: null,
          updated_at: new Date().toISOString(),
        };
        if (
          cmd.expiree_at == null &&
          (cmd.statut === 'en_attente' || cmd.statut === 'partiellement_acceptee')
        ) {
          patch.acceptation_limite_at = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        }
        await db.from('commandes').update(patch).eq('id', updated.commandeId);
      }

      // Paiement reçu APRÈS l'expiration de la commande : l'argent ne doit pas
      // rester bloqué sur un escrow d'une commande déjà remboursée/annulée.
      if (cmd && (cmd.expiree_at != null || cmd.statut === 'remboursee' || cmd.statut === 'annulee')) {
        try {
          await escrowService.refundAllForCommande(db, updated.commandeId, {
            motif: 'Paiement reçu après expiration de la commande',
            payoutClient: false,
          });
          logWarn({ msg: 'escrow_refund_paid_after_expiry', paiementId: updated.id, commandeId: updated.commandeId });
        } catch (err) {
          logError({ msg: 'escrow_refund_paid_after_expiry', paiementId: updated.id, error: err.message });
        }
      }

      // Notification « paiement confirmé » (client + commerces). Essentielle
      // pour les dépôts initiés automatiquement à l'acceptation (aucun appel
      // manuel du client sur l'API).
      try {
        const { notifyPaymentConfirmed } = require('../../services/order-notify.service');
        await notifyPaymentConfirmed(db, updated.commandeId, updated.utilisateurId);
      } catch (err) {
        logWarn({ msg: 'pawapay_deposit_notify', paiementId: updated.id, error: err.message });
      }

      return { ok: true, paiement: updated, escrow: { escrows, totalBloqueFcfa } };
    } catch (err) {
      logError({ msg: 'escrow_hold_after_deposit', paiementId: updated.id, error: err.message });
      return { ok: true, paiement: updated, escrowError: err.message };
    }
  }

  if (isFailedStatus(status)) {
    if (paiement.statut === 'echoue') return { ok: true, dejaEchec: true };
    const now = new Date().toISOString();
    const updated = await paymentRepo.update(db, paiement.id, {
      statut: 'echoue',
      pawapay_deposit_id: depositId || paiement.pawapayDepositId,
      failure_reason: status,
      metadata: { ...(paiement.metadata || {}), pawapay_deposit: { payload, received_at: now } },
    });
    return { ok: true, paiement: updated, echec: true };
  }

  return { ok: true, ignored: 'statut_ignore', status };
}

module.exports = { handle, verifySignature };
