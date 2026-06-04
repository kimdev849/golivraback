/**
 * Controller — Paiement client
 * Wrapper rétro-compatible. Délègue à `payments/services/payment.service`.
 */

const { getDb } = require('../config/db');
const { createHttpError, requireFields } = require('../utils/http');
const { payOrderForClient, isTestPaymentMode, PAYMENT_MODE } = require('../services/payment.service');
const { getPricingConfig, getPublicPricingSnapshot } = require('../services/pricing.service');
const { getPublicZonesConfig } = require('../services/zones.service');
const paymentRepo = require('../payments/repositories/payment.repository');
const { paymentResponse } = require('../payments/dto/payment.dto');

async function payOrder(req, res, next) {
  try {
    const { orderId } = req.params;
    const provider = req.body?.provider ?? req.body?.methodePaiement ?? null;
    const numeroCompte = req.body?.numero_compte || req.body?.numeroCompte || null;
    const db = getDb();
    const result = await payOrderForClient(db, orderId, req.auth.userId, {
      provider,
      numero_compte: numeroCompte,
    });
    if (!result.deja_valide) {
      const { notifyPaymentConfirmed } = require('../services/order-notify.service');
      await notifyPaymentConfirmed(db, result.commande.id, req.auth.userId);
    }
    return res.json({
      ok: true,
      deja_valide: result.deja_valide,
      payment_mode: PAYMENT_MODE,
      test_mode: isTestPaymentMode(),
      paiement: {
        id: result.paiement.id,
        statut: result.paiement.statut,
        reference: result.paiement.reference_externe || result.paiement.numero_transaction,
        methode: result.paiement.methode,
        montant_fcfa: Number(result.paiement.montant),
        pawapay_deposit_id: result.paiement.pawapay_deposit_id || null,
      },
      commande_id: result.commande.id,
    });
  } catch (error) {
    return next(error);
  }
}

async function getPaymentStatus(req, res, next) {
  try {
    const { orderId } = req.params;
    const db = getDb();
    const paiement = await paymentRepo.findLatestForCommande(db, orderId);
    if (!paiement) return res.status(404).json({ code: 'PAIEMENT_INTROUVABLE' });
    return res.json(paymentResponse(paiement));
  } catch (error) {
    return next(error);
  }
}

async function getPaymentMode(req, res) {
  return res.json({
    mode: PAYMENT_MODE,
    test_mode: isTestPaymentMode(),
    providers: ['airtel_money', 'mtn_money', 'portefeuille_golivra'],
    pays_supportes: ['CG'],
  });
}

async function getPricingConfigHandler(req, res, next) {
  try {
    const db = getDb();
    const config = await getPricingConfig(db);
    const snapshot = getPublicPricingSnapshot(config);
    try {
      snapshot.zones = await getPublicZonesConfig(db);
    } catch {
      snapshot.zones = null;
    }
    return res.json(snapshot);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  payOrder,
  getPaymentStatus,
  getPaymentMode,
  getPricingConfigHandler,
};
