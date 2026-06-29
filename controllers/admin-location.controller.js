const { getDb } = require('../config/db');
const {
  listPays,
  createPays,
  updatePays,
  deletePays,
  listVilles,
  createVille,
  updateVille,
  deleteVille,
  listArrondissements,
  createArrondissement,
  updateArrondissement,
  deleteArrondissement,
} = require('../services/admin-location.service');

// Pays
async function getPaysList(req, res, next) {
  try { const db = getDb(); return res.json(await listPays(db)); }
  catch (e) { return next(e); }
}
async function postPays(req, res, next) {
  try { const db = getDb(); return res.status(201).json(await createPays(db, req.body)); }
  catch (e) { return next(e); }
}
async function patchPays(req, res, next) {
  try { const db = getDb(); return res.json(await updatePays(db, req.params.paysId, req.body)); }
  catch (e) { return next(e); }
}
async function removePays(req, res, next) {
  try { const db = getDb(); return res.json(await deletePays(db, req.params.paysId)); }
  catch (e) { return next(e); }
}

// Villes
async function getVillesList(req, res, next) {
  try {
    const db = getDb();
    return res.json(await listVilles(db, req.query.pays_id || null));
  } catch (e) { return next(e); }
}
async function postVille(req, res, next) {
  try { const db = getDb(); return res.status(201).json(await createVille(db, req.body)); }
  catch (e) { return next(e); }
}
async function patchVille(req, res, next) {
  try { const db = getDb(); return res.json(await updateVille(db, req.params.villeId, req.body)); }
  catch (e) { return next(e); }
}
async function removeVille(req, res, next) {
  try { const db = getDb(); return res.json(await deleteVille(db, req.params.villeId)); }
  catch (e) { return next(e); }
}

// Arrondissements
async function getArrondissementsList(req, res, next) {
  try {
    const db = getDb();
    return res.json(await listArrondissements(db, req.query.ville_id || null));
  } catch (e) { return next(e); }
}
async function postArrondissement(req, res, next) {
  try { const db = getDb(); return res.status(201).json(await createArrondissement(db, req.body)); }
  catch (e) { return next(e); }
}
async function patchArrondissement(req, res, next) {
  try { const db = getDb(); return res.json(await updateArrondissement(db, req.params.arrId, req.body)); }
  catch (e) { return next(e); }
}
async function removeArrondissement(req, res, next) {
  try { const db = getDb(); return res.json(await deleteArrondissement(db, req.params.arrId)); }
  catch (e) { return next(e); }
}

module.exports = {
  getPaysList, postPays, patchPays, removePays,
  getVillesList, postVille, patchVille, removeVille,
  getArrondissementsList, postArrondissement, patchArrondissement, removeArrondissement,
};
