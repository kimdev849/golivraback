const { getDb } = require('../config/db');
const { createHttpError, requireFields } = require('../utils/http');

const ACTIVE = 'active';

async function resolveEstablishment(db, enterpriseId) {
  const { data: r } = await db.from('restaurants').select('*').eq('id', enterpriseId).maybeSingle();
  if (r) return { kind: 'restaurant', row: r };
  const { data: b } = await db.from('boutiques').select('*').eq('id', enterpriseId).maybeSingle();
  if (b) return { kind: 'boutique', row: b };
  return null;
}

function canManageEstablishment(req, row) {
  if (!req.auth || !row) return false;
  if (req.auth.role === 'admin') return true;
  return row.proprietaire_id === req.auth.userId;
}

function mapPlatToProduct(p, enterpriseId) {
  let stock = null;
  if (p.stock !== null && p.stock !== undefined) stock = Math.max(0, Number(p.stock));
  if (p.est_disponible === false) stock = 0;
  return {
    id: p.id,
    entreprise_id: enterpriseId,
    nom: p.nom,
    description: p.description,
    prix: p.prix,
    prix_promo: p.prix_promo != null ? Number(p.prix_promo) : null,
    promo_debut_at: p.promo_debut_at ?? null,
    promo_fin_at: p.promo_fin_at ?? null,
    stock,
    stock_illimite: p.stock === null || p.stock === undefined,
    est_disponible: p.est_disponible !== false,
    est_en_vedette: p.est_en_vedette === true,
    image_url: p.image_url ?? null,
    categorie_id: p.categorie_id ?? null,
    tags: Array.isArray(p.tags) ? p.tags : [],
    allergenes: Array.isArray(p.allergenes) ? p.allergenes : [],
    kind: 'plat',
    options: p.options ?? null,
  };
}

function mapArticleToProduct(a, enterpriseId) {
  let stock = null;
  if (a.stock !== null && a.stock !== undefined) stock = Math.max(0, Number(a.stock));
  if (!a.est_disponible) stock = 0;
  return {
    id: a.id,
    entreprise_id: enterpriseId,
    nom: a.nom,
    description: a.description,
    prix: a.prix,
    prix_promo: a.prix_promo != null ? Number(a.prix_promo) : null,
    promo_debut_at: a.promo_debut_at ?? null,
    promo_fin_at: a.promo_fin_at ?? null,
    stock,
    stock_illimite: a.stock === null || a.stock === undefined,
    est_disponible: a.est_disponible !== false,
    est_en_vedette: a.est_en_vedette === true,
    image_url: a.image_url ?? null,
    images_urls: Array.isArray(a.images_urls) ? a.images_urls : [],
    kind: 'article',
    options: a.options ?? null,
    reference: a.reference ?? null,
    unite: a.unite ?? null,
    categorie_id: a.categorie_id ?? null,
    tags: Array.isArray(a.tags) ? a.tags : [],
    type_produit: a.type_produit ?? null,
    etat_produit: a.etat_produit ?? null,
    marque: a.marque ?? null,
    poids_kg: a.poids_kg != null ? Number(a.poids_kg) : null,
    dimensions: a.dimensions ?? null,
  };
}

function parseTags(tags) {
  if (!tags) return null;
  if (Array.isArray(tags)) {
    return tags.map((t) => String(t).trim()).filter(Boolean);
  }
  return null;
}

function parseAllergenes(allergenes) {
  if (!allergenes) return null;
  if (Array.isArray(allergenes)) {
    return allergenes.map((a) => String(a).trim().toLowerCase()).filter(Boolean);
  }
  return null;
}

function normalizeOptionGroups(options) {
  if (options === undefined || options === null) return null;
  if (!Array.isArray(options)) {
    throw createHttpError(400, 'Le champ options doit être un tableau JSON.');
  }
  const cleaned = options
    .map((g) => ({
      nom: String(g?.nom ?? '').trim(),
      requis: g?.requis !== false,
      choix: Array.isArray(g?.choix)
        ? g.choix
            .map((c) => ({
              label: String(c?.label ?? '').trim(),
              prix_sup: Number(c?.prix_sup) || 0,
            }))
            .filter((c) => c.label)
        : [],
    }))
    .filter((g) => g.nom && g.choix.length);
  return cleaned.length ? cleaned : null;
}

function applyPlatCatalogFields(target, body) {
  const { tags, allergenes, promoDebutAt, promoFinAt, estDisponible } = body;

  const tagList = parseTags(tags);
  if (tagList) target.tags = tagList;

  const allergeneList = parseAllergenes(allergenes);
  if (allergeneList) target.allergenes = allergeneList;

  const promoStart = parseIsoDate(promoDebutAt);
  const promoEnd = parseIsoDate(promoFinAt);
  if (promoDebutAt !== undefined) target.promo_debut_at = promoStart;
  if (promoFinAt !== undefined) target.promo_fin_at = promoEnd;
  if (estDisponible !== undefined) target.est_disponible = Boolean(estDisponible);
}

function parseImagesUrls(imagesUrls, imageUrl) {
  const list = Array.isArray(imagesUrls)
    ? imagesUrls.map((u) => String(u).trim()).filter((u) => u.startsWith('http'))
    : [];
  const main = parseImageUrl(imageUrl);
  if (main && !list.includes(main)) list.unshift(main);
  return list.length ? list : null;
}

function parseIsoDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function normalizeDimensions(dimensions) {
  if (!dimensions || typeof dimensions !== 'object') return null;
  const l = dimensions.l != null && dimensions.l !== '' ? Number(dimensions.l) : null;
  const w = dimensions.w != null && dimensions.w !== '' ? Number(dimensions.w) : null;
  const h = dimensions.h != null && dimensions.h !== '' ? Number(dimensions.h) : null;
  if (![l, w, h].some((n) => Number.isFinite(n) && n > 0)) return null;
  const out = {};
  if (Number.isFinite(l) && l > 0) out.l = l;
  if (Number.isFinite(w) && w > 0) out.w = w;
  if (Number.isFinite(h) && h > 0) out.h = h;
  return Object.keys(out).length ? out : null;
}

function applyArticleCatalogFields(target, body) {
  const {
    tags,
    imagesUrls,
    imageUrl,
    promoDebutAt,
    promoFinAt,
    typeProduit,
    etatProduit,
    marque,
    poidsKg,
    dimensions,
    estDisponible,
  } = body;

  const tagList = parseTags(tags);
  if (tagList) target.tags = tagList;

  const gallery = parseImagesUrls(imagesUrls, imageUrl);
  if (gallery) {
    target.images_urls = gallery;
    if (!target.image_url && gallery[0]) target.image_url = gallery[0];
  }

  const promoStart = parseIsoDate(promoDebutAt);
  const promoEnd = parseIsoDate(promoFinAt);
  if (promoDebutAt !== undefined) target.promo_debut_at = promoStart;
  if (promoFinAt !== undefined) target.promo_fin_at = promoEnd;

  if (typeProduit !== undefined && typeProduit) target.type_produit = String(typeProduit).trim();
  if (etatProduit !== undefined && etatProduit) target.etat_produit = String(etatProduit).trim();
  if (marque !== undefined && marque) target.marque = String(marque).trim();
  if (poidsKg !== undefined && poidsKg !== null && poidsKg !== '') {
    const kg = Number(poidsKg);
    if (Number.isFinite(kg) && kg > 0) target.poids_kg = kg;
  }
  const dims = normalizeDimensions(dimensions);
  if (dims) target.dimensions = dims;
  if (estDisponible !== undefined) target.est_disponible = Boolean(estDisponible);
}

const OPTIONAL_ARTICLE_COLUMNS = [
  'dimensions',
  'images_urls',
  'type_produit',
  'etat_produit',
  'marque',
  'poids_kg',
  'tags',
  'promo_debut_at',
  'promo_fin_at',
];

function isMissingColumnError(error, column) {
  const msg = String(error?.message ?? error ?? '').toLowerCase();
  return msg.includes(column) && (msg.includes('column') || msg.includes('colonne') || msg.includes('schema'));
}

async function insertArticleRow(db, row) {
  const payload = { ...row };
  const removed = new Set();

  for (let attempt = 0; attempt <= OPTIONAL_ARTICLE_COLUMNS.length; attempt += 1) {
    const { data, error } = await db.from('articles').insert(payload).select('*').single();
    if (!error) return data;

    const missing = OPTIONAL_ARTICLE_COLUMNS.find((col) => !removed.has(col) && col in payload && isMissingColumnError(error, col));
    if (!missing) throw error;
    delete payload[missing];
    removed.add(missing);
  }

  throw createHttpError(500, 'Impossible d’enregistrer l’article.');
}

async function updateArticleRow(db, productId, patch) {
  const payload = { ...patch };
  const removed = new Set();

  for (let attempt = 0; attempt <= OPTIONAL_ARTICLE_COLUMNS.length; attempt += 1) {
    const { data, error } = await db.from('articles').update(payload).eq('id', productId).select('*').single();
    if (!error) return data;

    const missing = OPTIONAL_ARTICLE_COLUMNS.find((col) => !removed.has(col) && col in payload && isMissingColumnError(error, col));
    if (!missing) throw error;
    delete payload[missing];
    removed.add(missing);
  }

  throw createHttpError(500, 'Impossible de mettre à jour l’article.');
}

function parseImageUrl(imageUrl) {
  return typeof imageUrl === 'string' && imageUrl.trim().startsWith('http') ? imageUrl.trim() : null;
}

async function findProductInEstablishment(db, kind, enterpriseId, productId) {
  if (kind === 'restaurant') {
    const { data, error } = await db
      .from('plats')
      .select('*')
      .eq('id', productId)
      .eq('restaurant_id', enterpriseId)
      .maybeSingle();
    if (error) throw error;
    return data;
  }
  const { data, error } = await db
    .from('articles')
    .select('*')
    .eq('id', productId)
    .eq('boutique_id', enterpriseId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function listProducts(req, res, next) {
  try {
    const { enterpriseId } = req.params;
    const db = getDb();

    const resolved = await resolveEstablishment(db, enterpriseId);
    if (!resolved) throw createHttpError(404, 'Établissement introuvable');

    const { kind, row } = resolved;
    const visible = row.statut === ACTIVE;
    if (!visible && !canManageEstablishment(req, row)) {
      throw createHttpError(404, 'Établissement introuvable');
    }

    if (kind === 'restaurant') {
      const { data, error } = await db
        .from('plats')
        .select('*')
        .eq('restaurant_id', enterpriseId)
        .order('nom');
      if (error) throw error;
      return res.json((data || []).map((p) => mapPlatToProduct(p, enterpriseId)));
    }

    const { data, error } = await db
      .from('articles')
      .select('*')
      .eq('boutique_id', enterpriseId)
      .order('nom');
    if (error) throw error;
    return res.json((data || []).map((a) => mapArticleToProduct(a, enterpriseId)));
  } catch (error) {
    return next(error);
  }
}

async function createProduct(req, res, next) {
  try {
    const { enterpriseId } = req.params;
    const {
      nom,
      description,
      prix,
      prixPromo,
      stock,
      stockIllimite,
      imageUrl,
      imagesUrls,
      categorieId,
      estEnVedette,
      estDisponible,
      reference,
      unite,
      options,
      tags,
      promoDebutAt,
      promoFinAt,
      allergenes,
      typeProduit,
      etatProduit,
      marque,
      poidsKg,
      dimensions,
    } = req.body;
    requireFields(req.body, ['nom', 'prix']);
    const imgUrl = parseImageUrl(imageUrl);
    const normalizedOptions = options !== undefined ? normalizeOptionGroups(options) : undefined;

    const db = getDb();
    const resolved = await resolveEstablishment(db, enterpriseId);
    if (!resolved) throw createHttpError(404, 'Établissement introuvable');

    const { kind, row } = resolved;
    if (!canManageEstablishment(req, row)) throw createHttpError(403, 'Action non autorisée pour cet établissement');

    if (kind === 'restaurant') {
      if (req.auth.role !== 'admin' && req.auth.role !== 'restaurateur') {
        throw createHttpError(403, 'Seul un restaurateur peut ajouter des plats.');
      }
      const prixNum = Number(prix);
      const insertPlat = {
        restaurant_id: enterpriseId,
        nom: String(nom).trim(),
        description: description || null,
        prix: prixNum,
        est_disponible: estDisponible !== undefined ? Boolean(estDisponible) : true,
        image_url: imgUrl,
        est_en_vedette: Boolean(estEnVedette),
        options: normalizedOptions !== undefined ? normalizedOptions : options ?? null,
      };
      if (categorieId) insertPlat.categorie_id = categorieId;
      if (prixPromo != null && prixPromo !== '') insertPlat.prix_promo = Number(prixPromo);
      applyPlatCatalogFields(insertPlat, {
        tags,
        allergenes,
        promoDebutAt,
        promoFinAt,
        estDisponible,
      });
      if (stockIllimite === true) {
        insertPlat.stock = null;
      } else if (stock !== undefined && stock !== null && stock !== '') {
        insertPlat.stock = Math.max(0, Math.floor(Number(stock)));
      }

      const { data, error } = await db.from('plats').insert(insertPlat).select('*').single();
      if (error) throw error;
      return res.status(201).json(mapPlatToProduct(data, enterpriseId));
    }

    if (req.auth.role !== 'admin' && req.auth.role !== 'commercant') {
      throw createHttpError(403, 'Seul un commerçant peut ajouter des articles.');
    }
    const prixNum = Number(prix);
    const stockVal = stockIllimite
      ? null
      : stock === undefined || stock === null
        ? null
        : Math.max(0, Math.floor(Number(stock)));

    const insertArt = {
      boutique_id: enterpriseId,
      nom: String(nom).trim(),
      description: description || null,
      prix: prixNum,
      stock: stockVal,
      est_disponible: estDisponible !== undefined ? Boolean(estDisponible) : true,
      image_url: imgUrl,
      est_en_vedette: Boolean(estEnVedette),
      options: normalizedOptions !== undefined ? normalizedOptions : options ?? null,
    };
    if (categorieId) insertArt.categorie_id = categorieId;
    if (prixPromo != null && prixPromo !== '') insertArt.prix_promo = Number(prixPromo);
    const ref = reference ? String(reference).trim() : `GLV-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    insertArt.reference = ref;
    if (unite) insertArt.unite = String(unite).trim();
    applyArticleCatalogFields(insertArt, {
      tags,
      imagesUrls,
      imageUrl: imgUrl,
      promoDebutAt,
      promoFinAt,
      typeProduit,
      etatProduit,
      marque,
      poidsKg,
      dimensions,
    });

    const data = await insertArticleRow(db, insertArt);
    return res.status(201).json(mapArticleToProduct(data, enterpriseId));
  } catch (error) {
    return next(error);
  }
}

async function updateProduct(req, res, next) {
  try {
    const { enterpriseId, productId } = req.params;
    const {
      nom,
      description,
      prix,
      prixPromo,
      stock,
      stockIllimite,
      imageUrl,
      imagesUrls,
      estDisponible,
      categorieId,
      estEnVedette,
      reference,
      unite,
      options,
      tags,
      promoDebutAt,
      promoFinAt,
      allergenes,
      typeProduit,
      etatProduit,
      marque,
      poidsKg,
      dimensions,
    } = req.body;

    const db = getDb();
    const resolved = await resolveEstablishment(db, enterpriseId);
    if (!resolved) throw createHttpError(404, 'Établissement introuvable');

    const { kind, row } = resolved;
    if (!canManageEstablishment(req, row)) throw createHttpError(403, 'Action non autorisée pour cet établissement');

    const existing = await findProductInEstablishment(db, kind, enterpriseId, productId);
    if (!existing) throw createHttpError(404, 'Produit introuvable');

    if (kind === 'restaurant') {
      if (req.auth.role !== 'admin' && req.auth.role !== 'restaurateur') {
        throw createHttpError(403, 'Seul un restaurateur peut modifier des plats.');
      }
      const patch = {};
      if (nom !== undefined) patch.nom = String(nom).trim();
      if (description !== undefined) patch.description = description || null;
      if (prix !== undefined) patch.prix = Number(prix);
      if (imageUrl !== undefined) patch.image_url = parseImageUrl(imageUrl);
      if (estDisponible !== undefined) patch.est_disponible = Boolean(estDisponible);
      if (prixPromo !== undefined) patch.prix_promo = prixPromo === null ? null : Number(prixPromo);
      if (categorieId !== undefined) patch.categorie_id = categorieId || null;
      if (estEnVedette !== undefined) patch.est_en_vedette = Boolean(estEnVedette);
      if (options !== undefined) patch.options = normalizeOptionGroups(options);
      applyPlatCatalogFields(patch, {
        tags,
        allergenes,
        promoDebutAt,
        promoFinAt,
        estDisponible,
      });
      if (stockIllimite === true) {
        patch.stock = null;
      } else if (stock !== undefined) {
        patch.stock = stock === null || stock === '' ? null : Math.max(0, Math.floor(Number(stock)));
      }

      const { data, error } = await db.from('plats').update(patch).eq('id', productId).select('*').single();
      if (error) throw error;
      return res.json(mapPlatToProduct(data, enterpriseId));
    }

    if (req.auth.role !== 'admin' && req.auth.role !== 'commercant') {
      throw createHttpError(403, 'Seul un commerçant peut modifier des articles.');
    }
    const patch = {};
    if (nom !== undefined) patch.nom = String(nom).trim();
    if (description !== undefined) patch.description = description || null;
    if (prix !== undefined) patch.prix = Number(prix);
    if (imageUrl !== undefined) patch.image_url = parseImageUrl(imageUrl);
    if (estDisponible !== undefined) patch.est_disponible = Boolean(estDisponible);
    if (stockIllimite === true) {
      patch.stock = null;
    } else if (stock !== undefined) {
      patch.stock = stock === null ? null : Math.max(0, Math.floor(Number(stock)));
    }
    if (prixPromo !== undefined) patch.prix_promo = prixPromo === null ? null : Number(prixPromo);
    if (categorieId !== undefined) patch.categorie_id = categorieId || null;
    if (estEnVedette !== undefined) patch.est_en_vedette = Boolean(estEnVedette);
    if (reference !== undefined) patch.reference = reference || null;
    if (unite !== undefined) patch.unite = unite || null;
    if (options !== undefined) patch.options = normalizeOptionGroups(options);
    applyArticleCatalogFields(patch, {
      tags,
      imagesUrls,
      imageUrl,
      promoDebutAt,
      promoFinAt,
      typeProduit,
      etatProduit,
      marque,
      poidsKg,
      dimensions,
      estDisponible,
    });

    const data = await updateArticleRow(db, productId, patch);
    return res.json(mapArticleToProduct(data, enterpriseId));
  } catch (error) {
    return next(error);
  }
}

async function deleteProduct(req, res, next) {
  try {
    const { enterpriseId, productId } = req.params;
    const db = getDb();
    const resolved = await resolveEstablishment(db, enterpriseId);
    if (!resolved) throw createHttpError(404, 'Établissement introuvable');

    const { kind, row } = resolved;
    if (!canManageEstablishment(req, row)) throw createHttpError(403, 'Action non autorisée pour cet établissement');

    const existing = await findProductInEstablishment(db, kind, enterpriseId, productId);
    if (!existing) throw createHttpError(404, 'Produit introuvable');

    const table = kind === 'restaurant' ? 'plats' : 'articles';
    const { error } = await db.from(table).delete().eq('id', productId);
    if (error) throw error;
    return res.status(204).send();
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listProducts,
  createProduct,
  updateProduct,
  deleteProduct,
};
