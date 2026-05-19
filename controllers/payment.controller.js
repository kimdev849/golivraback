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
      const { notifyUserSafe } = require('../services/notification.service');
      await notifyUserSafe(db, {
        utilisateurId: req.auth.userId,
        type: 'paiement',
        titre: 'Paiement confirmé',
        corps: 'Votre commande est confirmée. Le commerce va la préparer.',
        data: { commande_id: result.commande.id, action: 'open_orders' },
      });

      const { data: sous } = await db
        .from('sous_commandes')
        .select('id, restaurant_id, boutique_id')
        .eq('commande_id', result.commande.id);
      const ownerIds = new Set();
      for (const sc of sous || []) {
        if (sc.restaurant_id) {
          const { data: r } = await db.from('restaurants').select('proprietaire_id').eq('id', sc.restaurant_id).maybeSingle();
          if (r?.proprietaire_id) ownerIds.add(r.proprietaire_id);
        }
        if (sc.boutique_id) {
          const { data: b } = await db.from('boutiques').select('proprietaire_id').eq('id', sc.boutique_id).maybeSingle();
          if (b?.proprietaire_id) ownerIds.add(b.proprietaire_id);
        }
      }
      for (const ownerId of ownerIds) {
        await notifyUserSafe(db, {
          utilisateurId: ownerId,
          type: 'commande_statut',
          titre: 'Nouvelle commande payée',
          corps: 'Un client vient de payer une commande. Consultez vos commandes.',
          data: { commande_id: result.commande.id, action: 'vendor_orders' },
        });
      }
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
