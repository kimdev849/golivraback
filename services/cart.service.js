const { createHttpError } = require('../utils/http');

async function resolveProduct(db, productId) {
  const { data: plat } = await db
    .from('plats')
    .select('id, nom, prix, stock, restaurant_id, est_disponible')
    .eq('id', productId)
    .maybeSingle();
  if (plat) {
    const stockUnlimited = plat.stock === null || plat.stock === undefined;
    return {
      kind: 'plat',
      plat_id: plat.id,
      article_id: null,
      restaurant_id: plat.restaurant_id,
      boutique_id: null,
      nom: plat.nom,
      prix: Number(plat.prix),
      stock: stockUnlimited ? null : Number(plat.stock),
      stock_illimite: stockUnlimited,
      disponible: plat.est_disponible !== false,
    };
  }

  const { data: article } = await db
    .from('articles')
    .select('id, nom, prix, stock, boutique_id, est_disponible')
    .eq('id', productId)
    .maybeSingle();
  if (article) {
    const stockUnlimited = article.stock === null || article.stock === undefined;
    return {
      kind: 'article',
      plat_id: null,
      article_id: article.id,
      restaurant_id: null,
      boutique_id: article.boutique_id,
      nom: article.nom,
      prix: Number(article.prix),
      stock: stockUnlimited ? null : Number(article.stock),
      stock_illimite: stockUnlimited,
      disponible: article.est_disponible !== false,
    };
  }

  return null;
}

async function getOrCreatePanier(db, userId) {
  const { data: existing, error: findErr } = await db
    .from('paniers')
    .select('id, expire_at, note_globale, created_at, updated_at')
    .eq('utilisateur_id', userId)
    .maybeSingle();
  if (findErr) throw findErr;
  if (existing) return existing;

  const expireAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  const { data: created, error: insErr } = await db
    .from('paniers')
    .insert({ utilisateur_id: userId, expire_at: expireAt })
    .select('id, expire_at, note_globale, created_at, updated_at')
    .single();
  if (insErr) throw insErr;
  return created;
}

async function loadCartItems(db, panierId) {
  const { data, error } = await db
    .from('panier_items')
    .select(
      'id, plat_id, article_id, restaurant_id, boutique_id, quantite, prix_unitaire, note_item, options_choisies, created_at',
    )
    .eq('panier_id', panierId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function mapCartToSegments(db, items) {
  const segmentMap = new Map();

  for (const item of items) {
    const enterpriseId = item.restaurant_id || item.boutique_id;
    if (!enterpriseId) continue;
    const productId = item.plat_id || item.article_id;
    if (!productId) continue;

    let seg = segmentMap.get(enterpriseId);
    if (!seg) {
      let enterpriseNom = 'Commerce';
      let enterpriseType;
      if (item.restaurant_id) {
        const { data: r } = await db.from('restaurants').select('nom').eq('id', enterpriseId).maybeSingle();
        enterpriseNom = r?.nom || enterpriseNom;
        enterpriseType = 'restaurant';
      } else {
        const { data: b } = await db.from('boutiques').select('nom').eq('id', enterpriseId).maybeSingle();
        enterpriseNom = b?.nom || enterpriseNom;
        enterpriseType = 'boutique';
      }
      seg = { enterpriseId, enterpriseNom, enterpriseType, lines: [] };
      segmentMap.set(enterpriseId, seg);
    }

    let nom = 'Article';
    if (item.plat_id) {
      const { data: p } = await db.from('plats').select('nom').eq('id', item.plat_id).maybeSingle();
      nom = p?.nom || nom;
    } else if (item.article_id) {
      const { data: a } = await db.from('articles').select('nom').eq('id', item.article_id).maybeSingle();
      nom = a?.nom || nom;
    }

    seg.lines.push({
      itemId: item.id,
      productId,
      nom,
      prixUnitaire: Number(item.prix_unitaire),
      quantite: Number(item.quantite),
    });
  }

  return [...segmentMap.values()];
}

async function getCartForUser(db, userId) {
  const panier = await getOrCreatePanier(db, userId);
  const items = await loadCartItems(db, panier.id);
  const segments = await mapCartToSegments(db, items);
  return { panier_id: panier.id, segments, expire_at: panier.expire_at };
}

async function clearPanierItems(db, panierId) {
  const { error } = await db.from('panier_items').delete().eq('panier_id', panierId);
  if (error) throw error;
}

async function replaceCartFromSegments(db, userId, segments) {
  const panier = await getOrCreatePanier(db, userId);
  await clearPanierItems(db, panier.id);

  if (!Array.isArray(segments) || segments.length === 0) {
    return getCartForUser(db, userId);
  }

  const rows = [];

  for (const seg of segments) {
    if (!seg || !Array.isArray(seg.lines)) continue;
    for (const line of seg.lines) {
      const productId = line.productId;
      const quantite = Math.max(1, Math.min(99, Math.floor(Number(line.quantite) || 1)));
      if (!productId) continue;

      const product = await resolveProduct(db, productId);
      if (!product || !product.disponible) continue;

      const enterpriseId = seg.enterpriseId;
      if (product.restaurant_id && product.restaurant_id !== enterpriseId) continue;
      if (product.boutique_id && product.boutique_id !== enterpriseId) continue;

      const prixUnitaire =
        Number.isFinite(Number(line.prixUnitaire)) && Number(line.prixUnitaire) > 0
          ? Number(line.prixUnitaire)
          : product.prix;

      rows.push({
        panier_id: panier.id,
        plat_id: product.plat_id,
        article_id: product.article_id,
        restaurant_id: product.restaurant_id,
        boutique_id: product.boutique_id,
        quantite,
        prix_unitaire: prixUnitaire,
        options_choisies: null,
        note_item: null,
      });
    }
  }

  if (rows.length > 0) {
    const { error } = await db.from('panier_items').insert(rows);
    if (error) throw error;
  }

  const expireAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  await db.from('paniers').update({ expire_at: expireAt, updated_at: new Date().toISOString() }).eq('id', panier.id);

  return getCartForUser(db, userId);
}

async function clearCartForUser(db, userId) {
  const { data: panier } = await db.from('paniers').select('id').eq('utilisateur_id', userId).maybeSingle();
  if (panier) {
    await clearPanierItems(db, panier.id);
  }
  return { segments: [] };
}

module.exports = {
  getCartForUser,
  replaceCartFromSegments,
  clearCartForUser,
};
