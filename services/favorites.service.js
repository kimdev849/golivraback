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

  // Enrichir avec le statut ouvert/fermé LIVE (le snapshot est_ouvert
  // est souvent figé et ne reflète pas l'état actuel).
  try {
    const { getEtablissementOuvertureInfo } = require('./horaires.service');
    await Promise.all(
      items.map(async (item) => {
        try {
          const info = await getEtablissementOuvertureInfo(db, {
            kind: item.type,
            id: item.enterprise_id,
            prepMinutes: 20,
          });
          item.est_ouvert_maintenant = info.ouvert;
          item.message_fermeture = info.message_fermeture;
          item.prochaine_ouverture = info.prochaine_ouverture;
        } catch { /* best-effort */ }
      }),
    );
  } catch { /* service d'horaires indisponible */ }

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
      try {
        await addFavorite(db, userId, id);
      } catch (err) {
        // Commerce supprimé entre-temps : on ignore, pas de 404 sur le batch.
        if (err?.status === 404 || err?.statusCode === 404) continue;
        throw err;
      }
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
  listFavoriteProducts,
  toggleFavoriteProduct,
  removeFavoriteProduct,
};

/* ============================================================ */
/* PRODUITS (plats + articles)                                  */
/* ============================================================ */

const VALID_KINDS = new Set(['plat', 'article']);

/** True si l'erreur vient d'une table/relation manquante en base (schéma incomplet). */
function isMissingRelationError(error) {
  const msg = String(error?.message || error?.details || '').toLowerCase();
  return (
    String(error?.code) === 'PGRST205' ||
    msg.includes('relation') && msg.includes('does not exist') ||
    msg.includes('could not find the table')
  );
}

async function verifyProductExists(db, productId, kind) {
  if (!VALID_KINDS.has(kind)) return false;
  const table = kind === 'plat' ? 'plats' : 'articles';
  const { data } = await db.from(table).select('id').eq('id', productId).maybeSingle();
  return Boolean(data?.id);
}

async function listFavoriteProducts(db, userId) {
  const { data, error } = await db
    .from('favoris_produits')
    .select('produit_id, produit_kind, created_at')
    .eq('client_id', userId)
    .order('created_at', { ascending: false });
  // Table absente (migration 006 non appliquée) → liste vide plutôt qu'un 500.
  if (isMissingRelationError(error)) return [];
  if (error) throw error;
  return (data || []).map((row) => ({
    produit_id: row.produit_id,
    produit_kind: row.produit_kind,
    favorited_at: row.created_at,
  }));
}

async function toggleFavoriteProduct(db, userId, productId, kind) {
  if (!productId) throw createHttpError(400, 'produitId requis');
  if (!VALID_KINDS.has(kind)) throw createHttpError(400, 'kind doit etre "plat" ou "article"');

  // Verifie que le produit existe (404 clair si pas).
  const exists = await verifyProductExists(db, productId, kind);
  if (!exists) throw createHttpError(404, 'Produit introuvable.');

  const { data: existing, error: existingErr } = await db
    .from('favoris_produits')
    .select('produit_id')
    .eq('client_id', userId)
    .eq('produit_id', productId)
    .eq('produit_kind', kind)
    .maybeSingle();

  if (isMissingRelationError(existingErr)) {
    // Table absente → on ne peut pas persister, on renvoie l'état côté client
    // sans casser l'UX (le client garde ses favoris localement).
    return { produit_id: productId, produit_kind: kind, favori: true, degraded: true };
  }
  if (existingErr) throw existingErr;

  if (existing) {
    await removeFavoriteProduct(db, userId, productId, kind);
    return { produit_id: productId, produit_kind: kind, favori: false };
  }

  const { error } = await db
    .from('favoris_produits')
    .insert({ client_id: userId, produit_id: productId, produit_kind: kind });
  if (isMissingRelationError(error)) {
    return { produit_id: productId, produit_kind: kind, favori: true, degraded: true };
  }
  if (error) throw error;
  return { produit_id: productId, produit_kind: kind, favori: true };
}

async function removeFavoriteProduct(db, userId, productId, kind) {
  if (!productId || !VALID_KINDS.has(kind)) {
    return { produit_id: productId, produit_kind: kind, favori: false };
  }
  const { error } = await db
    .from('favoris_produits')
    .delete()
    .eq('client_id', userId)
    .eq('produit_id', productId)
    .eq('produit_kind', kind);
  if (isMissingRelationError(error)) {
    return { produit_id: productId, produit_kind: kind, favori: false };
  }
  if (error) throw error;
  return { produit_id: productId, produit_kind: kind, favori: false };
}
