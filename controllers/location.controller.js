const { getDb } = require('../config/db');
const { createHttpError } = require('../utils/http');
const {
  listPays,
  listVillesByPays,
  listArrondissementsByVille,
  getFullLocationTree,
} = require('../services/location.service');
const { detectLocationByIp } = require('../services/ip-location.service');

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

/**
 * Détection de localisation par IP.
 * Retourne le pays détecté + la ville la plus proche dans notre base.
 */
async function detectLocation(req, res, next) {
  try {
    const db = getDb();
    const clientIp = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '127.0.0.1';
    const detected = await detectLocationByIp(clientIp);

    // Chercher le pays correspondant dans notre base
    const { data: paysRow, error: paysErr } = await db
      .from('pays')
      .select('id, nom, code_iso2, code_iso3, indicatif')
      .eq('code_iso2', detected.pays.code_iso2)
      .maybeSingle();

    if (paysErr) throw paysErr;

    let pays = null;
    let villes = [];
    let villeSuggestions = [];

    if (paysRow) {
      pays = {
        id: paysRow.id,
        nom: paysRow.nom,
        code_iso2: paysRow.code_iso2,
        code_iso3: paysRow.code_iso3,
        indicatif: paysRow.indicatif,
      };

      // Chercher les villes correspondant à la région détectée
      const { data: villeRows } = await db
        .from('villes')
        .select('id, pays_id, nom, sort_order')
        .eq('pays_id', pays.id)
        .order('sort_order', { ascending: true });

      villes = (villeRows || []).map((v) => ({
        id: v.id,
        pays_id: v.pays_id,
        nom: v.nom,
        sort_order: v.sort_order || 0,
      }));

      // Suggérer la ville détectée si elle existe dans notre base
      if (detected.ville) {
        const needle = detected.ville.toLowerCase();
        villeSuggestions = villes.filter((v) => v.nom.toLowerCase().includes(needle));
      }
    }

    return res.json({
      ip: detected.ip,
      pays,
      villes,
      detected_ville: detected.ville || null,
      ville_suggestion: villeSuggestions[0] || null,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getPays,
  getVilles,
  getArrondissements,
  getFullTree,
  detectLocation,
};
