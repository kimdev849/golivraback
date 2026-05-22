const { createHttpError } = require('../utils/http');
const { parseMissingColumn, isMissingColumnError } = require('../utils/supabase-errors');

const OPEN_ACCEPT_FILTER = { livreur_id: null, statut: 'en_attente' };

async function updateLivraisonRow(db, livraisonId, patch, extraFilters = {}) {
  let body = { ...patch };
  let lastError = null;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    let query = db.from('livraisons').update(body).eq('id', livraisonId).select('*');
    for (const [key, value] of Object.entries(extraFilters)) {
      if (value === null) query = query.is(key, null);
      else query = query.eq(key, value);
    }

    const { data, error } = await query.maybeSingle();
    if (!error && data) return data;

    lastError = error;
    if (!isMissingColumnError(error)) break;

    const missing = parseMissingColumn(error);
    if (!missing || !(missing in body)) break;
    const next = { ...body };
    delete next[missing];
    if (Object.keys(next).length === Object.keys(body).length) break;
    body = next;
  }

  if (lastError) throw lastError;
  return null;
}

/** Met à jour une livraison ouverte (en_attente, sans livreur). */
async function acceptLivraisonForCourier(db, livraisonId, livreur) {
  const now = new Date().toISOString();
  const data = await updateLivraisonRow(
    db,
    livraisonId,
    {
      livreur_id: livreur.id,
      statut: 'attribuee',
      assigne_le: now,
      attribuee_at: now,
      entreprise_logistique_id: livreur.entreprise_logistique_id || null,
      updated_at: now,
    },
    OPEN_ACCEPT_FILTER,
  );

  if (data) return data;
  throw createHttpError(409, 'Cette course a déjà été acceptée par un autre livreur.');
}

async function updateLivraisonForCourier(db, livraisonId, livreurId, patchVariants) {
  let lastError = null;
  for (const patch of patchVariants) {
    try {
      const data = await updateLivraisonRow(db, livraisonId, patch, { livreur_id: livreurId });
      if (data) return data;
    } catch (error) {
      lastError = error;
      if (!isMissingColumnError(error)) throw error;
    }
  }
  if (lastError) throw lastError;
  return null;
}

async function advanceLivraisonStatut(db, livraisonId, livreurId, nextStatut, extraPatch = {}) {
  const now = new Date().toISOString();
  const data = await updateLivraisonForCourier(db, livraisonId, livreurId, [
    { statut: nextStatut, updated_at: now, ...extraPatch },
    { statut: nextStatut, ...extraPatch },
  ]);
  if (!data) throw createHttpError(404, 'Livraison introuvable pour ce livreur.');
  return data;
}

async function completeLivraisonRow(db, livraisonId, livreurId) {
  const now = new Date().toISOString();
  const data = await updateLivraisonForCourier(db, livraisonId, livreurId, [
    { statut: 'livree', livree_at: now, livre_le: now, updated_at: now },
    { statut: 'livree', livree_at: now, updated_at: now },
    { statut: 'livree', livree_at: now },
    { statut: 'livree', livre_le: now },
    { statut: 'livree' },
  ]);
  if (!data) throw createHttpError(404, 'Livraison introuvable pour ce livreur.');
  return data;
}

module.exports = {
  acceptLivraisonForCourier,
  advanceLivraisonStatut,
  completeLivraisonRow,
  isMissingColumnError,
};
