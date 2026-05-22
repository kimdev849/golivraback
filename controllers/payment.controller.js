const { getDb } = require('../config/db');
const { payOrderForClient, isTestPaymentMode, PAYMENT_MODE } = require('../services/payment.service');
const { getPricingConfig, getPublicPricingSnapshot } = require('../services/pricing.service');

async function payOrder(req, res, next) {
  try {
    const { orderId } = req.params;
    const provider = req.body?.provider ?? req.body?.methodePaiement ?? null;
    const db = getDb();
    const result = await payOrderForClient(db, orderId, req.auth.userId, { provider });
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
      },
      commande_id: result.commande.id,
    });
  } catch (error) {
    return next(error);
  }
}

async function getPaymentMode(req, res) {
  return res.json({
    mode: PAYMENT_MODE,
    test_mode: isTestPaymentMode(),
    providers: ['airtel', 'mtn'],
  });
}

async function getPricingConfigHandler(req, res, next) {
  try {
    const db = getDb();
    const config = await getPricingConfig(db);
    return res.json(getPublicPricingSnapshot(config));
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  payOrder,
  getPaymentMode,
  getPricingConfigHandler,
};
