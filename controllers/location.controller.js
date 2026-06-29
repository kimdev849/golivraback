const { getDb } = require('../config/db');
const { createHttpError } = require('../utils/http');
const {
  listPays,
  listVillesByPays,
  listArrondissementsByVille,
  getFullLocationTree,
} = require('../services/location.service');

async function getPays(req, res, next) {
  try {
    const db = getDb();
    const rows = await listPays(db);
    return res.json(rows);
  } catch (error) {
    return next(error);
  }
}

async function getVilles(req, res, next) {
  try {
    const db = getDb();
    const paysId = req.query.pays_id || req.params.paysId;
    if (!paysId) throw createHttpError(400, 'pays_id requis.');
    const rows = await listVillesByPays(db, paysId);
    return res.json(rows);
  } catch (error) {
    return next(error);
  }
}

async function getArrondissements(req, res, next) {
  try {
    const db = getDb();
    const villeId = req.query.ville_id || req.params.villeId;
    if (!villeId) throw createHttpError(400, 'ville_id requis.');
    const rows = await listArrondissementsByVille(db, villeId);
    return res.json(rows);
  } catch (error) {
    return next(error);
  }
}

async function getFullTree(req, res, next) {
  try {
    const db = getDb();
    const tree = await getFullLocationTree(db);
    return res.json(tree);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getPays,
  getVilles,
  getArrondissements,
  getFullTree,
};
