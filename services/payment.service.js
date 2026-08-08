/**
 * Service legacy — Paiement
 * ───────────────────────────────────────────────────────────────────────────
 * Wrapper rétro-compatible. Délègue au module `payments/`.
 * Toute nouvelle fonctionnalité doit utiliser `payments/services/payment.service`.
 */

const { createHttpError } = require('../utils/http');
const { getPricingConfig, randomTestPaymentAmount } = require('./pricing.service');
const newPaymentService = require('../payments/services/payment.service');
const { normalizePaymentRequest } = require('../payments/dto/payment.dto');

const PAYMENT_MODE = newPaymentService.PAYMENT_MODE;
const isTestPaymentMode = newPaymentService.isTestPaymentMode;

async function assertOrderOwnedByClient(db, commandeId, clientId) {
  return newPaymentService.assertOrderOwnedByClient(db, commandeId, clientId);
}

async function getPendingPaymentForOrder(db, commandeId) {
  const p = await require('../payments/repositories/payment.repository').findLatestForCommande(db, commandeId);
  if (!p) return null;
  return {
    id: p.id,
    commande_id: p.commandeId,
    utilisateur_id: p.utilisateurId,
    montant: p.montantFcfa,
    methode: p.methode,
    statut: p.statut,
    reference_externe: p.referenceExterne,
    numero_transaction: p.numeroTransaction,
    metadata: p.metadata,
    paye_at: p.payeAt,
    created_at: p.creeLe,
    updated_at: p.misAJourLe,
  };
}

/**
 * Wrapper legacy : payOrderForClient(commandeId, clientId, { provider })
 */
async function payOrderForClient(db, commandeId, clientId, { provider, numero_compte } = {}) {
  const payload = normalizePaymentRequest({ provider, numero_compte });
  const result = await newPaymentService.initiate(db, commandeId, clientId, payload);
  const paiementRow = result.paiement ? {
    id: result.paiement.id,
    commande_id: result.paiement.commandeId,
    utilisateur_id: result.paiement.utilisateurId,
    montant: result.paiement.montantFcfa,
    methode: result.paiement.methode,
    statut: result.paiement.statut,
    reference_externe: result.paiement.referenceExterne,
    numero_transaction: result.paiement.numeroTransaction,
    pawapay_deposit_id: result.paiement.pawapayDepositId,
    metadata: result.paiement.metadata,
    paye_at: result.paiement.payeAt,
    created_at: result.paiement.creeLe,
    updated_at: result.paiement.misAJourLe,
  } : null;
  return {
    commande: result.commande,
    paiement: paiementRow,
    deja_valide: Boolean(result.dejaValide),
    simulation: Boolean(result.simulation),
  };
}

async function assertCommandePayee(db, commandeId) {
  const p = await newPaymentService.assertCommandePayee(db, commandeId);
  return {
    id: p.id,
    commande_id: p.commandeId,
    utilisateur_id: p.utilisateurId,
    montant: p.montantFcfa,
    methode: p.methode,
    statut: p.statut,
    paye_at: p.payeAt,
  };
}

module.exports = {
  PAYMENT_MODE,
  isTestPaymentMode,
  payOrderForClient,
  assertCommandePayee,
  getPendingPaymentForOrder,
  assertOrderOwnedByClient,
};
