/**
 * Service de référentiel géographique : pays, villes, arrondissements.
 */

function mapPays(row) {
  return {
    id: row.id,
    nom: row.nom,
    code_iso2: row.code_iso2,
    code_iso3: row.code_iso3,
    indicatif: row.indicatif || null,
    phone_digits: row.phone_digits || null,
    phone_format: row.phone_format || null,
  };
}

function mapVille(row) {
  return {
    id: row.id,
    pays_id: row.pays_id,
    nom: row.nom,
    sort_order: row.sort_order || 0,
  };
}

function mapArrondissement(row) {
  return {
    id: row.id,
    ville_id: row.ville_id,
    nom: row.name,
    zone_id: row.zone_id || null,
    sort_order: row.sort_order || 0,
  };
}

/** True si l'erreur vient d'une table/relation manquante en base (schéma incomplet). */
function isMissingRelationError(error) {
  const msg = String(error?.message || error?.details || '').toLowerCase();
  return (
    String(error?.code) === 'PGRST205' ||
    (msg.includes('relation') && msg.includes('does not exist')) ||
    msg.includes('could not find the table')
  );
}

/** Liste tous les pays. */
async function listPays(db) {
  const { data, error } = await db
    .from('pays')
    .select('id, nom, code_iso2, code_iso3, indicatif')
    .order('nom', { ascending: true });
  // Table absente (migration pays/villes non appliquée) → liste vide plutôt qu'un 404.
  if (isMissingRelationError(error)) return [];
  if (error) throw error;
  return (data || []).map(mapPays);
}

/** Liste les villes d'un pays. */
async function listVillesByPays(db, paysId) {
  const { data, error } = await db
    .from('villes')
    .select('id, pays_id, nom, sort_order')
    .eq('pays_id', paysId)
    .order('sort_order', { ascending: true });
  if (isMissingRelationError(error)) return [];
  if (error) throw error;
  return (data || []).map(mapVille);
}

/** Liste les arrondissements d'une ville. */
async function listArrondissementsByVille(db, villeId) {
  const { data, error } = await db
    .from('arrondissements')
    .select('id, ville_id, name, zone_id, sort_order')
    .eq('ville_id', villeId)
    .order('sort_order', { ascending: true });
  if (isMissingRelationError(error)) return [];
  if (error) throw error;
  return (data || []).map(mapArrondissement);
}

/** Récupère la hiérarchie complète en un seul appel. */
async function getFullLocationTree(db) {
  const [pays, villes, arrondissements] = await Promise.all([
    db.from('pays').select('id, nom, code_iso2, code_iso3, indicatif, phone_digits, phone_format').order('nom', { ascending: true }),
    db.from('villes').select('id, pays_id, nom, sort_order').order('sort_order', { ascending: true }),
    db.from('arrondissements').select('id, ville_id, name, zone_id, sort_order').order('sort_order', { ascending: true }),
  ]);

  if (pays.error && !isMissingRelationError(pays.error)) throw pays.error;
  if (villes.error && !isMissingRelationError(villes.error)) throw villes.error;
  if (arrondissements.error && !isMissingRelationError(arrondissements.error)) throw arrondissements.error;

  return {
    pays: (pays.data || []).map(mapPays),
    villes: (villes.data || []).map(mapVille),
    arrondissements: (arrondissements.data || []).map(mapArrondissement),
  };
}

module.exports = {
  listPays,
  listVillesByPays,
  listArrondissementsByVille,
  getFullLocationTree,
};
