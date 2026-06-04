const { getDb } = require('../config/db');
const {
  getPublicZonesConfig,
  resolveDeliveryPriceForQuartier,
  getAdminZonesBoard,
  updateAdminZonesBoard,
} = require('../services/zones.service');

async function getPublic(req, res, next) {
  try {
    const db = getDb();
    const config = await getPublicZonesConfig(db);
    return res.json(config);
  } catch (error) {
    return next(error);
  }
}

async function quoteDelivery(req, res, next) {
  try {
    const quartier = req.query.quartier || req.query.q || '';
    const db = getDb();
    const quote = await resolveDeliveryPriceForQuartier(db, quartier);
    return res.json({
      quartier: String(quartier).trim() || null,
      price_fcfa: quote.price_fcfa,
      zone: quote.zone,
    });
  } catch (error) {
    return next(error);
  }
}

async function listAdmin(req, res, next) {
  try {
    const db = getDb();
    const board = await getAdminZonesBoard(db);
    return res.json(board);
  } catch (error) {
    return next(error);
  }
}

async function updateAdmin(req, res, next) {
  try {
    const db = getDb();
    const board = await updateAdminZonesBoard(db, req.body, req.auth?.userId);
    return res.json(board);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getPublic,
  quoteDelivery,
  listAdmin,
  updateAdmin,
};
