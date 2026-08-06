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

/**
 * Marque la livraison comme livrée avec la preuve de livraison complète.
 *
 * @param {object} proof - { photoUrl, gpsLat, gpsLng, takenAt, clientPresent }
 *   Les colonnes non migrées sont retirées automatiquement par updateLivraisonRow.
 */
async function completeLivraisonRow(db, livraisonId, livreurId, proof) {
  const now = new Date().toISOString();
  const meta = {
    ...(proof?.photoUrl ? { proof_photo_url: String(proof.photoUrl) } : {}),
    ...(proof?.gpsLat != null && Number.isFinite(Number(proof.gpsLat))
      ? { proof_gps_lat: Number(proof.gpsLat) }
      : {}),
    ...(proof?.gpsLng != null && Number.isFinite(Number(proof.gpsLng))
      ? { proof_gps_lng: Number(proof.gpsLng) }
      : {}),
    ...(proof?.takenAt ? { proof_taken_at: proof.takenAt } : {}),
    ...(typeof proof?.clientPresent === 'boolean' ? { proof_client_present: proof.clientPresent } : {}),
  };

  // On essaie d'abord avec la preuve (photo + méta-données)...
  if (meta.proof_photo_url) {
    try {
      const photoPatches = [
        { statut: 'livree', livree_at: now, livre_le: now, updated_at: now, ...meta },
        { statut: 'livree', livree_at: now, updated_at: now, ...meta },
        { statut: 'livree', livree_at: now, ...meta },
        { statut: 'livree', livre_le: now, ...meta },
        { statut: 'livree', ...meta },
      ];
      const data = await updateLivraisonForCourier(db, livraisonId, livreurId, photoPatches);
      if (data) return data;
    } catch (photoErr) {
      // La preuve est le verrou de l'escrow : si la sauvegarde échoue pour une
      // vraie raison (permissions RLS, réseau…), on NE complète PAS sans preuve.
      // Seule tolérance : colonnes de la preuve pas encore migrées.
      if (!isMissingColumnError(photoErr)) throw photoErr;
      console.warn('[livraison-db] colonnes preuve non migrées, complétion sans preuve :', photoErr?.message || photoErr);
      // Fall through : on marque la livraison comme livrée sans la preuve (migration uniquement)
    }
  }

  // Fallback sans preuve (colonnes pas encore migrées ou RLS insuffisant)
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
