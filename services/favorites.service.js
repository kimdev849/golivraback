const { createHttpError } = require('../utils/http');

async function resolveEnterpriseType(db, enterpriseId) {
  const { data: r } = await db.from('restaurants').select('id, nom').eq('id', enterpriseId).maybeSingle();
  if (r) return { type: 'restaurant', nom: r.nom };

  const { data: b } = await db.from('boutiques').select('id, nom').eq('id', enterpriseId).maybeSingle();
  if (b) return { type: 'boutique', nom: b.nom };

  return null;
}

async function listFavorites(db, userId) {
  const [restRes, boutRes] = await Promise.all([
    db
      .from('favoris_restaurants')
      .select('restaurant_id, created_at, restaurants(id, nom, statut, est_ouvert)')
      .eq('utilisateur_id', userId)
      .order('created_at', { ascending: false }),
    db
      .from('favoris_boutiques')
      .select('boutique_id, created_at, boutiques(id, nom, statut, est_ouvert)')
      .eq('utilisateur_id', userId)
      .order('created_at', { ascending: false }),
  ]);

  if (restRes.error) throw restRes.error;
  if (boutRes.error) throw boutRes.error;

  const items = [];

  for (const row of restRes.data || []) {
    const ent = row.restaurants;
    if (!ent?.id) continue;
    items.push({
      enterprise_id: ent.id,
      type: 'restaurant',
      nom: ent.nom,
      statut: ent.statut,
      est_ouvert: ent.est_ouvert,
      favorited_at: row.created_at,
    });
  }

  for (const row of boutRes.data || []) {
    const ent = row.boutiques;
    if (!ent?.id) continue;
    items.push({
      enterprise_id: ent.id,
      type: 'boutique',
      nom: ent.nom,
      statut: ent.statut,
      est_ouvert: ent.est_ouvert,
      favorited_at: row.created_at,
    });
  }

  items.sort((a, b) => String(b.favorited_at || '').localeCompare(String(a.favorited_at || '')));
  return items;
}

async function addFavorite(db, userId, enterpriseId, enterpriseTypeHint) {
  let ent = null;
  if (enterpriseTypeHint === 'restaurant' || enterpriseTypeHint === 'boutique') {
    ent = await resolveEnterpriseType(db, enterpriseId);
    if (ent && ent.type !== enterpriseTypeHint) {
      throw createHttpError(400, 'Le type de commerce ne correspond pas.');
    }
  } else {
    ent = await resolveEnterpriseType(db, enterpriseId);
  }

  if (!ent) throw createHttpError(404, 'Commerce introuvable.');

  if (ent.type === 'restaurant') {
    const { error } = await db.from('favoris_restaurants').upsert(
      { utilisateur_id: userId, restaurant_id: enterpriseId },
      { onConflict: 'utilisateur_id,restaurant_id' },
    );
    if (error) throw error;
  } else {
    const { error } = await db.from('favoris_boutiques').upsert(
      { utilisateur_id: userId, boutique_id: enterpriseId },
      { onConflict: 'utilisateur_id,boutique_id' },
    );
    if (error) throw error;
  }

  return { enterprise_id: enterpriseId, type: ent.type, favori: true };
}

async function removeFavorite(db, userId, enterpriseId) {
  await db.from('favoris_restaurants').delete().eq('utilisateur_id', userId).eq('restaurant_id', enterpriseId);
  await db.from('favoris_boutiques').delete().eq('utilisateur_id', userId).eq('boutique_id', enterpriseId);
  return { enterprise_id: enterpriseId, favori: false };
}

async function toggleFavorite(db, userId, enterpriseId, enterpriseTypeHint) {
  const ent = enterpriseTypeHint
    ? { type: enterpriseTypeHint }
  : await resolveEnterpriseType(db, enterpriseId);
  if (!ent) throw createHttpError(404, 'Commerce introuvable.');

  const table = ent.type === 'restaurant' ? 'favoris_restaurants' : 'favoris_boutiques';
  const col = ent.type === 'restaurant' ? 'restaurant_id' : 'boutique_id';

  const { data: existing } = await db
    .from(table)
    .select(col)
    .eq('utilisateur_id', userId)
    .eq(col, enterpriseId)
    .maybeSingle();

  if (existing) {
    await removeFavorite(db, userId, enterpriseId);
    return { enterprise_id: enterpriseId, type: ent.type, favori: false };
  }

  return addFavorite(db, userId, enterpriseId, ent.type);
}

async function syncFavorites(db, userId, enterpriseIds) {
  const ids = [...new Set((enterpriseIds || []).filter((id) => typeof id === 'string' && id.length > 0))];
  const current = await listFavorites(db, userId);
  const currentIds = new Set(current.map((f) => f.enterprise_id));

  for (const id of ids) {
    if (!currentIds.has(id)) {
      await addFavorite(db, userId, id);
    }
  }

  for (const fav of current) {
    if (!ids.includes(fav.enterprise_id)) {
      await removeFavorite(db, userId, fav.enterprise_id);
    }
  }

  return listFavorites(db, userId);
}

module.exports = {
  listFavorites,
  addFavorite,
  removeFavorite,
  toggleFavorite,
  syncFavorites,
};
