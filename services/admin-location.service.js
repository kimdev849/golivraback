/**
 * Admin : gestion des pays, villes et arrondissements.
 */

const { createHttpError } = require('../utils/http');

// ── P A Y S ─────────────────────────────────────────────────────────────────

async function listPays(db) {
  const { data, error } = await db
    .from('pays')
    .select('id, nom, code_iso2, code_iso3, indicatif')
    .order('nom', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function createPays(db, body) {
  const nom = String(body.nom || '').trim();
  const code_iso2 = String(body.code_iso2 || '').trim().toUpperCase();
  const code_iso3 = String(body.code_iso3 || '').trim().toUpperCase();
  const indicatif = body.indicatif ? String(body.indicatif).trim() : null;

  if (!nom) throw createHttpError(400, 'Le nom du pays est requis.');
  if (!code_iso2 || code_iso2.length !== 2) throw createHttpError(400, 'Code ISO2 (2 lettres) requis.');
  if (!code_iso3 || code_iso3.length !== 3) throw createHttpError(400, 'Code ISO3 (3 lettres) requis.');

  const { data, error } = await db
    .from('pays')
    .insert({ nom, code_iso2, code_iso3, indicatif })
    .select('*')
    .single();
  if (error) {
    if (error.code === '23505') throw createHttpError(409, 'Ce code ISO existe déjà.');
    throw error;
  }
  return data;
}

async function updatePays(db, paysId, body) {
  const patch = {};
  if (body.nom !== undefined) patch.nom = String(body.nom).trim();
  if (body.code_iso2 !== undefined) patch.code_iso2 = String(body.code_iso2).trim().toUpperCase();
  if (body.code_iso3 !== undefined) patch.code_iso3 = String(body.code_iso3).trim().toUpperCase();
  if (body.indicatif !== undefined) patch.indicatif = String(body.indicatif).trim() || null;

  if (Object.keys(patch).length === 0) throw createHttpError(400, 'Aucun champ à mettre à jour.');

  const { data, error } = await db
    .from('pays')
    .update(patch)
    .eq('id', paysId)
    .select('*')
    .single();
  if (error) {
    if (error.code === '23505') throw createHttpError(409, 'Ce code ISO existe déjà.');
    if (error.code === 'PGRST116') throw createHttpError(404, 'Pays introuvable.');
    throw error;
  }
  return data;
}

async function deletePays(db, paysId) {
  const { error } = await db.from('pays').delete().eq('id', paysId);
  if (error) {
    if (error.code === 'PGRST116') throw createHttpError(404, 'Pays introuvable.');
    throw error;
  }
  return { message: 'Pays supprimé.' };
}

// ── V I L L E S ─────────────────────────────────────────────────────────────

async function listVilles(db, paysId) {
  let q = db.from('villes').select('*').order('sort_order', { ascending: true });
  if (paysId) q = q.eq('pays_id', paysId);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function createVille(db, body) {
  const pays_id = body.pays_id;
  const nom = String(body.nom || '').trim();
  if (!pays_id) throw createHttpError(400, 'pays_id requis.');
  if (!nom) throw createHttpError(400, 'Le nom de la ville est requis.');

  const { data, error } = await db
    .from('villes')
    .insert({ pays_id, nom, sort_order: body.sort_order ?? 0 })
    .select('*')
    .single();
  if (error) {
    if (error.code === '23505') throw createHttpError(409, 'Cette ville existe déjà dans ce pays.');
    throw error;
  }
  return data;
}

async function updateVille(db, villeId, body) {
  const patch = {};
  if (body.nom !== undefined) patch.nom = String(body.nom).trim();
  if (body.sort_order !== undefined) patch.sort_order = Number(body.sort_order);

  if (Object.keys(patch).length === 0) throw createHttpError(400, 'Aucun champ à mettre à jour.');

  const { data, error } = await db
    .from('villes')
    .update(patch)
    .eq('id', villeId)
    .select('*')
    .single();
  if (error) {
    if (error.code === '23505') throw createHttpError(409, 'Cette ville existe déjà dans ce pays.');
    if (error.code === 'PGRST116') throw createHttpError(404, 'Ville introuvable.');
    throw error;
  }
  return data;
}

async function deleteVille(db, villeId) {
  const { error } = await db.from('villes').delete().eq('id', villeId);
  if (error) {
    if (error.code === 'PGRST116') throw createHttpError(404, 'Ville introuvable.');
    throw error;
  }
  return { message: 'Ville supprimée.' };
}

// ── A R R O N D I S S E M E N T S ────────────────────────────────────────────

async function listArrondissements(db, villeId) {
  let q = db
    .from('arrondissements')
    .select('id, ville_id, name, zone_id, sort_order')
    .order('sort_order', { ascending: true });
  if (villeId) q = q.eq('ville_id', villeId);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function createArrondissement(db, body) {
  const ville_id = body.ville_id;
  const name = String(body.name || '').trim();
  if (!ville_id) throw createHttpError(400, 'ville_id requis.');
  if (!name) throw createHttpError(400, 'Le nom de l\'arrondissement est requis.');

  const { data, error } = await db
    .from('arrondissements')
    .insert({ ville_id, name, sort_order: body.sort_order ?? 0, zone_id: body.zone_id || null })
    .select('*')
    .single();
  if (error) {
    if (error.code === '23505') throw createHttpError(409, 'Cet arrondissement existe déjà dans cette ville.');
    throw error;
  }
  return data;
}

async function updateArrondissement(db, arrondissementId, body) {
  const patch = {};
  if (body.name !== undefined) patch.name = String(body.name).trim();
  if (body.sort_order !== undefined) patch.sort_order = Number(body.sort_order);
  if (body.zone_id !== undefined) patch.zone_id = body.zone_id || null;

  if (Object.keys(patch).length === 0) throw createHttpError(400, 'Aucun champ à mettre à jour.');

  const { data, error } = await db
    .from('arrondissements')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', arrondissementId)
    .select('*')
    .single();
  if (error) {
    if (error.code === '23505') throw createHttpError(409, 'Cet arrondissement existe déjà dans cette ville.');
    if (error.code === 'PGRST116') throw createHttpError(404, 'Arrondissement introuvable.');
    throw error;
  }
  return data;
}

async function deleteArrondissement(db, arrondissementId) {
  const { error } = await db.from('arrondissements').delete().eq('id', arrondissementId);
  if (error) {
    if (error.code === 'PGRST116') throw createHttpError(404, 'Arrondissement introuvable.');
    throw error;
  }
  return { message: 'Arrondissement supprimé.' };
}

module.exports = {
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
};
