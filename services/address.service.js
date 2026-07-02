const { createHttpError } = require('../utils/http');

function mapAddress(row) {
  if (!row) return null;
  return {
    id: row.id,
    libelle: row.libelle,
    type: row.type,
    ligne1: row.ligne1,
    ligne2: row.ligne2,
    quartier: row.quartier,
    ville: row.ville,
    pays: row.pays,
    pays_id: row.pays_id || null,
    ville_id: row.ville_id || null,
    arrondissement_id: row.arrondissement_id || null,
    latitude: row.latitude != null ? Number(row.latitude) : null,
    longitude: row.longitude != null ? Number(row.longitude) : null,
    est_principale: row.est_principale === true,
    instructions: row.instructions,
    point_reperes: row.point_reperes ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function validateAddressBody(body, { requireAll = true } = {}) {
  const validators = require('../lib/validators');
  const quartier = typeof body.quartier === 'string' ? validators.sanitizeText(body.quartier) : '';
  const ligne1 = typeof body.ligne1 === 'string' ? validators.sanitizeText(body.ligne1) : '';
  const instructions = typeof body.instructions === 'string' ? validators.sanitizeText(body.instructions) : null;
  const point_reperes = typeof body.point_reperes === 'string' ? validators.sanitizeText(body.point_reperes) : null;
  const libelle = typeof body.libelle === 'string' ? validators.sanitizeText(body.libelle) : null;
  const type = typeof body.type === 'string' ? body.type.trim() : 'domicile';
  const ville = typeof body.ville === 'string' && body.ville.trim() ? validators.sanitizeText(body.ville) : 'Brazzaville';
  const pays = typeof body.pays === 'string' && body.pays.trim() ? validators.sanitizeText(body.pays) : 'Congo';

  // UUIDs FK (optionnels pour backward compat)
  const paysId = typeof body.pays_id === 'string' && body.pays_id.trim() ? body.pays_id.trim() : null;
  const villeId = typeof body.ville_id === 'string' && body.ville_id.trim() ? body.ville_id.trim() : null;
  const arrondissementId = typeof body.arrondissement_id === 'string' && body.arrondissement_id.trim() ? body.arrondissement_id.trim() : null;

  if (requireAll) {
    if (!quartier) throw createHttpError(400, 'Le quartier est obligatoire.');
    if (!ligne1 || ligne1.length < 5) {
      throw createHttpError(400, 'Décrivez votre adresse (rue, repère, immeuble…).');
    }
    if (/^[0-9\s]+$/.test(ligne1)) {
      throw createHttpError(400, 'Adresse invalide (pas uniquement des chiffres).');
    }
    if (!/\p{L}/u.test(ligne1)) {
      throw createHttpError(400, 'L\'adresse doit contenir au moins une lettre (rue, repère ou quartier).');
    }
  }

  return {
    libelle: libelle || quartier || 'Domicile',
    type: ['domicile', 'bureau', 'autre'].includes(type) ? type : 'domicile',
    ligne1,
    ligne2: typeof body.ligne2 === 'string' ? body.ligne2.trim() || null : null,
    quartier,
    ville,
    pays,
    pays_id: paysId,
    ville_id: villeId,
    arrondissement_id: arrondissementId,
    latitude: null,
    longitude: null,
    instructions: instructions || null,
    point_reperes: point_reperes || null,
    est_principale: body.est_principale === true,
  };
}

function formatAddressText(fields) {
  const parts = [
    fields.quartier,
    fields.ligne1,
    fields.point_reperes,
    fields.instructions,
    fields.ville,
    fields.pays,
  ].filter(Boolean);
  return parts.join(' · ');
}

async function listUserAddresses(db, userId) {
  const { data, error } = await db
    .from('adresses')
    .select('*')
    .eq('utilisateur_id', userId)
    .order('est_principale', { ascending: false })
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(mapAddress);
}

async function getAddressForUser(db, userId, addressId) {
  const { data, error } = await db
    .from('adresses')
    .select('*')
    .eq('id', addressId)
    .eq('utilisateur_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw createHttpError(404, 'Adresse introuvable.');
  return mapAddress(data);
}

async function clearPrincipalFlag(db, userId, exceptId = null) {
  let q = db.from('adresses').update({ est_principale: false, updated_at: new Date().toISOString() }).eq('utilisateur_id', userId);
  if (exceptId) q = q.neq('id', exceptId);
  const { error } = await q;
  if (error) throw error;
}

async function createUserAddress(db, userId, body) {
  const fields = validateAddressBody(body);
  const { data: existing } = await db.from('adresses').select('id').eq('utilisateur_id', userId).limit(1);
  const makePrincipal = fields.est_principale || !(existing || []).length;

  if (makePrincipal) await clearPrincipalFlag(db, userId);

  const { data, error } = await db
    .from('adresses')
    .insert({
      utilisateur_id: userId,
      ...fields,
      est_principale: makePrincipal,
    })
    .select('*')
    .single();
  if (error) throw error;
  return mapAddress(data);
}

async function updateUserAddress(db, userId, addressId, body) {
  await getAddressForUser(db, userId, addressId);
  const fields = validateAddressBody(body);
  if (fields.est_principale) await clearPrincipalFlag(db, userId, addressId);

  const { data, error } = await db
    .from('adresses')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', addressId)
    .eq('utilisateur_id', userId)
    .select('*')
    .single();
  if (error) throw error;
  return mapAddress(data);
}

async function deleteUserAddress(db, userId, addressId) {
  const row = await getAddressForUser(db, userId, addressId);
  const { error } = await db.from('adresses').delete().eq('id', addressId).eq('utilisateur_id', userId);
  if (error) throw error;
  if (row.est_principale) {
    const { data: next } = await db
      .from('adresses')
      .select('id')
      .eq('utilisateur_id', userId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (next?.id) {
      await db.from('adresses').update({ est_principale: true }).eq('id', next.id);
    }
  }
  return { message: 'Adresse supprimée.' };
}

async function setPrincipalAddress(db, userId, addressId) {
  await getAddressForUser(db, userId, addressId);
  await clearPrincipalFlag(db, userId, addressId);
  const { data, error } = await db
    .from('adresses')
    .update({ est_principale: true, updated_at: new Date().toISOString() })
    .eq('id', addressId)
    .eq('utilisateur_id', userId)
    .select('*')
    .single();
  if (error) throw error;
  return mapAddress(data);
}

module.exports = {
  mapAddress,
  validateAddressBody,
  formatAddressText,
  listUserAddresses,
  getAddressForUser,
  createUserAddress,
  updateUserAddress,
  deleteUserAddress,
  setPrincipalAddress,
};
