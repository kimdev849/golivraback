const { getDb } = require('../config/db');
const { requireFields } = require('../utils/http');
const { validatePromoCode } = require('../services/promo.service');

async function validatePromo(req, res, next) {
  try {
    requireFields(req.body, ['code']);
    const db = getDb();
    const { code, orderSubtotal, deliveryTotal, segments } = req.body;
    const result = await validatePromoCode(db, req.auth.userId, code, {
      orderSubtotal: Number(orderSubtotal) || 0,
      deliveryTotal: Number(deliveryTotal) || 0,
      segments: Array.isArray(segments) ? segments : [],
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return next(error);
  }
}

module.exports = { validatePromo };
