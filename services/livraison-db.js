const { createHttpError } = require('../utils/http');

const SCHEMA_COLUMN_CODES = new Set(['42703', 'PGRST204']);

function isMissingColumnError(error) {
  return error && SCHEMA_COLUMN_CODES.has(String(error.code || ''));
}

/** Met à jour une livraison ouverte (en_attente, sans livreur) — plusieurs variantes de colonnes. */
async function acceptLivraisonForCourier(db, livraisonId, livreur) {
  const now = new Date().toISOString();
  const patches = [
    {
      livreur_id: livreur.id,
      entreprise_logistique_id: livreur.entreprise_logistique_id || null,
      statut: 'attribuee',
      attribuee_at: now,
      assigne_le: now,
      updated_at: now,
    },
    {
      livreur_id: livreur.id,
      entreprise_logistique_id: livreur.entreprise_logistique_id || null,
      statut: 'attribuee',
      attribuee_at: now,
      assigne_le: now,
    },
    {
      livreur_id: livreur.id,
      statut: 'attribuee',
      assigne_le: now,
    },
  ];

  let lastError = null;
  for (const patch of patches) {
    const { data, error } = await db
      .from('livraisons')
      .update(patch)
      .eq('id', livraisonId)
      .is('livreur_id', null)
      .eq('statut', 'en_attente')
      .select('*')
      .maybeSingle();

    if (!error && data) return data;
    lastError = error;
    if (!isMissingColumnError(error)) break;
  }

  if (lastError) throw lastError;
  throw createHttpError(409, 'Cette course a déjà été acceptée par un autre livreur.');
}

async function updateLivraisonForCourier(db, livraisonId, livreurId, patchVariants) {
  let lastError = null;
  for (const patch of patchVariants) {
    const { data, error } = await db
      .from('livraisons')
      .update(patch)
      .eq('id', livraisonId)
      .eq('livreur_id', livreurId)
      .select('*')
      .maybeSingle();

    if (!error && data) return data;
    lastError = error;
    if (!isMissingColumnError(error)) break;
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
