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

function normalizeImagesUrls(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.map((u) => String(u).trim()).filter((u) => u.startsWith('http'));
  }
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return [];
    if (s.startsWith('[') && s.endsWith(']')) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) {
          return parsed.map((u) => String(u).trim()).filter((u) => u.startsWith('http'));
        }
      } catch { /* ignore */ }
    }
    if (s.startsWith('{') && s.endsWith('}')) {
      return s.slice(1, -1).split(',').map((u) => u.replace(/^"(.*)"$/, '$1').trim()).filter((u) => u.startsWith('http'));
    }
  }
  return [];
}

function parseImageUrl(url) {
  if (!url) return null;
  const s = String(url).trim();
  return s.startsWith('http') ? s : null;
}

function parseImagesUrls(imagesUrls, imageUrl) {
  let list = [];
  if (Array.isArray(imagesUrls)) {
    list = imagesUrls.map((u) => String(u).trim()).filter((u) => u.startsWith('http'));
  } else if (typeof imagesUrls === 'string') {
    list = normalizeImagesUrls(imagesUrls);
  }

  // Check for duplicates in the provided gallery
  const uniqueList = [...new Set(list)];
  if (uniqueList.length !== list.length) {
    throw createHttpError(400, 'La galerie contient des images dupliquées. Chaque image doit être unique.');
  }

  const main = parseImageUrl(imageUrl);
  if (main) {
    // If main image is already in gallery (but not at index 0), it's a duplicate entry
    const existingIndex = list.indexOf(main);
    if (existingIndex > 0) {
      throw createHttpError(400, 'L’image principale est déjà présente dans la galerie. Évitez les doublons.');
    }
    if (existingIndex === -1) {
      list.unshift(main);
    }
  }

  if (list.length > 8) {
    throw createHttpError(400, 'Un article ne peut pas avoir plus de 8 photos au total.');
  }

  return list;
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
    images_urls: normalizeImagesUrls(p.images_urls),
    categorie_id: p.categorie_id ?? null,
    tags: Array.isArray(p.tags) ? p.tags : [],
    allergenes: Array.isArray(p.allergenes) ? p.allergenes : [],
    kind: 'plat',
    options: p.options ?? null,
    nb_vues: Number(p.nb_vues ?? 0),
    nb_clics: Number(p.nb_clics ?? 0),
    nb_ventes: Number(p.nb_ventes ?? 0),
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
    images_urls: normalizeImagesUrls(a.images_urls),
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
    nb_vues: Number(a.nb_vues ?? 0),
    nb_clics: Number(a.nb_clics ?? 0),
    nb_ventes: Number(a.nb_ventes ?? 0),
  };
}

function parseTags(tags) {
  if (!tags) return null;
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean);
  return null;
}

function parseAllergenes(allergenes) {
  if (!allergenes) return null;
  if (Array.isArray(allergenes)) return allergenes.map((a) => String(a).trim().toLowerCase()).filter(Boolean);
  return null;
}

function normalizeOptionGroups(options) {
  if (options === undefined || options === null) return null;
  if (!Array.isArray(options)) throw createHttpError(400, 'Le champ options doit être un tableau JSON.');
  const cleaned = options.map((g) => ({
    nom: String(g?.nom ?? '').trim(),
    requis: g?.requis !== false,
    choix: Array.isArray(g?.choix) ? g.choix.map((c) => ({ label: String(c?.label ?? '').trim(), prix_sup: Number(c?.prix_sup) || 0 })).filter((c) => c.label) : [],
  })).filter((g) => g.nom && g.choix.length);
  return cleaned.length ? cleaned : null;
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

function applyPlatCatalogFields(target, body) {
  const { tags, allergenes, promoDebutAt, promoFinAt, estDisponible, imagesUrls, imageUrl } = body;
  const tagList = parseTags(tags);
  if (tagList) target.tags = tagList;
  const allergeneList = parseAllergenes(allergenes);
  if (allergeneList) target.allergenes = allergeneList;
  const promoStart = parseIsoDate(promoDebutAt);
  const promoEnd = parseIsoDate(promoFinAt);
  if (promoDebutAt !== undefined) target.promo_debut_at = promoStart;
  if (promoFinAt !== undefined) target.promo_fin_at = promoEnd;
  if (estDisponible !== undefined) target.est_disponible = Boolean(estDisponible);
  if (imagesUrls !== undefined || imageUrl !== undefined) {
    const gallery = parseImagesUrls(imagesUrls, imageUrl);
    target.images_urls = gallery;
    if (gallery && gallery[0]) target.image_url = gallery[0];
  }
}

function applyArticleCatalogFields(target, body) {
  const { tags, imagesUrls, imageUrl, promoDebutAt, promoFinAt, typeProduit, etatProduit, marque, poidsKg, dimensions, estDisponible } = body;
  const tagList = parseTags(tags);
  if (tagList) target.tags = tagList;
  const gallery = parseImagesUrls(imagesUrls, imageUrl);
  target.images_urls = gallery;
  if (gallery && gallery[0]) target.image_url = gallery[0];
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

const OPTIONAL_ARTICLE_COLUMNS = ['dimensions', 'images_urls', 'type_produit', 'etat_produit', 'marque', 'poids_kg', 'tags', 'promo_debut_at', 'promo_fin_at'];
const OPTIONAL_PLAT_COLUMNS = ['images_urls', 'tags', 'allergenes', 'promo_debut_at', 'promo_fin_at'];

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
    if (!missing) {
      console.error('[DB Error] Insert article failed:', error);
      throw error;
    }
    console.warn(`[DB Warning] Column "${missing}" missing in table "articles", dropping from payload for this attempt.`);
    delete payload[missing];
    removed.add(missing);
  }
  throw createHttpError(500, 'Impossible d’enregistrer l’article.');
}

async function insertPlatRow(db, row) {
  const payload = { ...row };
  const removed = new Set();
  for (let attempt = 0; attempt <= OPTIONAL_PLAT_COLUMNS.length; attempt += 1) {
    const { data, error } = await db.from('plats').insert(payload).select('*').single();
    if (!error) return data;
    const missing = OPTIONAL_PLAT_COLUMNS.find((col) => !removed.has(col) && col in payload && isMissingColumnError(error, col));
    if (!missing) {
      console.error('[DB Error] Insert plat failed:', error);
      throw error;
    }
    console.warn(`[DB Warning] Column "${missing}" missing in table "plats", dropping from payload for this attempt.`);
    delete payload[missing];
    removed.add(missing);
  }
  throw createHttpError(500, 'Impossible d’enregistrer le plat.');
}

async function updatePlatRow(db, productId, patch) {
  const payload = { ...patch };
  const removed = new Set();
  for (let attempt = 0; attempt <= OPTIONAL_PLAT_COLUMNS.length; attempt += 1) {
    const { data, error } = await db.from('plats').update(payload).eq('id', productId).select('*').single();
    if (!error) return data;
    const missing = OPTIONAL_PLAT_COLUMNS.find((col) => !removed.has(col) && col in payload && isMissingColumnError(error, col));
    if (!missing) {
      console.error('[DB Error] Update plat failed:', error);
      throw error;
    }
    console.warn(`[DB Warning] Column "${missing}" missing in table "plats", dropping from payload for this attempt.`);
    delete payload[missing];
    removed.add(missing);
  }
  throw createHttpError(500, 'Impossible de mettre à jour le plat.');
}

async function updateArticleRow(db, productId, patch) {
  const payload = { ...patch };
  const removed = new Set();
  for (let attempt = 0; attempt <= OPTIONAL_ARTICLE_COLUMNS.length; attempt += 1) {
    const { data, error } = await db.from('articles').update(payload).eq('id', productId).select('*').single();
    if (!error) return data;
    const missing = OPTIONAL_ARTICLE_COLUMNS.find((col) => !removed.has(col) && col in payload && isMissingColumnError(error, col));
    if (!missing) {
      console.error('[DB Error] Update article failed:', error);
      throw error;
    }
    console.warn(`[DB Warning] Column "${missing}" missing in table "articles", dropping from payload for this attempt.`);
    delete payload[missing];
    removed.add(missing);
  }
  throw createHttpError(500, 'Impossible de mettre à jour l’article.');
}

async function findProductInEstablishment(db, kind, enterpriseId, productId) {
  const table = kind === 'restaurant' ? 'plats' : 'articles';
  const fk = kind === 'restaurant' ? 'restaurant_id' : 'boutique_id';
  const { data, error } = await db.from(table).select('*').eq('id', productId).eq(fk, enterpriseId).maybeSingle();
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
    if (!visible && !canManageEstablishment(req, row)) throw createHttpError(404, 'Établissement introuvable');
    if (kind === 'restaurant') {
      const { data, error } = await db.from('plats').select('*').eq('restaurant_id', enterpriseId).order('nom');
      if (error) throw error;
      return res.json((data || []).map((p) => mapPlatToProduct(p, enterpriseId)));
    }
    const { data, error } = await db.from('articles').select('*').eq('boutique_id', enterpriseId).order('nom');
    if (error) throw error;
    return res.json((data || []).map((a) => mapArticleToProduct(a, enterpriseId)));
  } catch (error) { return next(error); }
}

async function listProductFeed(req, res, next) {
  try {
    const db = getDb();
    const type = typeof req.query.type === 'string' ? req.query.type.toLowerCase() : null;
    const onlyPromo = String(req.query.promo || '').toLowerCase() === 'true';
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 30));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const includePlats = !type || type === 'plat' || type === 'all';
    const includeArticles = !type || type === 'article' || type === 'all';
    const out = [];
    if (includePlats) {
      const { data: restaurants, error: restErr } = await db.from('restaurants').select('id, nom, image_url').eq('statut', ACTIVE);
      if (restErr) throw restErr;
      const restById = new Map((restaurants || []).map((r) => [r.id, r]));
      const restIds = [...restById.keys()];
      if (restIds.length) {
        let q = db.from('plats').select('*').in('restaurant_id', restIds).order('nom');
        if (onlyPromo) q = q.not('prix_promo', 'is', null);
        const { data, error } = await q;
        if (error) throw error;
        for (const p of data || []) {
          const rest = restById.get(p.restaurant_id);
          if (!rest) continue;
          out.push({ ...mapPlatToProduct(p, p.restaurant_id), enterprise_id: p.restaurant_id, enterprise_nom: rest.nom || null, enterprise_type: 'restaurant', enterprise_image_url: rest.image_url || null });
        }
      }
    }
    if (includeArticles) {
      const { data: boutiques, error: boutErr } = await db.from('boutiques').select('id, nom, image_url').eq('statut', ACTIVE);
      if (boutErr) throw boutErr;
      const boutById = new Map((boutiques || []).map((b) => [b.id, b]));
      const boutIds = [...boutById.keys()];
      if (boutIds.length) {
        let q = db.from('articles').select('*').in('boutique_id', boutIds).order('nom');
        if (onlyPromo) q = q.not('prix_promo', 'is', null);
        const { data, error } = await q;
        if (error) throw error;
        for (const a of data || []) {
          const bou = boutById.get(a.boutique_id);
          if (!bou) continue;
          out.push({ ...mapArticleToProduct(a, a.boutique_id), enterprise_id: a.boutique_id, enterprise_nom: bou.nom || null, enterprise_type: 'boutique', enterprise_image_url: bou.image_url || null });
        }
      }
    }
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return res.json(out.slice(offset, offset + limit));
  } catch (error) { return next(error); }
}

async function searchCatalog(req, res, next) {
  try {
    const db = getDb();
    const q = String(req.query.q || '').trim();
    const type = typeof req.query.type === 'string' ? req.query.type.toLowerCase() : 'all';
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 24));
    if (q.length < 2) return res.json({ products: [], enterprises: [] });
    const pattern = `%${q.replace(/[%_\\]/g, '')}%`;
    const enterprises = [];
    const products = [];
    const includeRestaurants = type === 'all' || type === 'restaurant';
    const includeBoutiques = type === 'all' || type === 'boutique';
    const includePlats = type === 'all' || type === 'plat';
    const includeArticles = type === 'all' || type === 'article';
    if (includeRestaurants) {
      const { data, error } = await db.from('restaurants').select('id, nom, description, adresse, image_url, type, categorie_id').eq('statut', ACTIVE).or(`nom.ilike.${pattern},description.ilike.${pattern},adresse.ilike.${pattern}`).limit(Math.min(limit, 12));
      if (error) throw error;
      for (const r of data || []) enterprises.push({ id: r.id, nom: r.nom, type: 'restaurant', description: r.description ?? null, adresse: r.adresse ?? null, image_url: r.image_url ?? null, categorie_id: r.categorie_id ?? null });
    }
    if (includeBoutiques) {
      const { data, error } = await db.from('boutiques').select('id, nom, description, adresse, image_url, type, categorie_id').eq('statut', ACTIVE).or(`nom.ilike.${pattern},description.ilike.${pattern},adresse.ilike.${pattern}`).limit(Math.min(limit, 12));
      if (error) throw error;
      for (const b of data || []) enterprises.push({ id: b.id, nom: b.nom, type: 'boutique', description: b.description ?? null, adresse: b.adresse ?? null, image_url: b.image_url ?? null, categorie_id: b.categorie_id ?? null });
    }
    if (includePlats) {
      const { data: restaurants, error: restErr } = await db.from('restaurants').select('id, nom, image_url').eq('statut', ACTIVE);
      if (restErr) throw restErr;
      const restById = new Map((restaurants || []).map((r) => [r.id, r]));
      const restIds = [...restById.keys()];
      if (restIds.length) {
        const { data, error } = await db.from('plats').select('*').in('restaurant_id', restIds).or(`nom.ilike.${pattern},description.ilike.${pattern}`).limit(limit);
        if (error) throw error;
        for (const p of data || []) {
          const rest = restById.get(p.restaurant_id);
          if (!rest) continue;
          products.push({ ...mapPlatToProduct(p, p.restaurant_id), enterprise_id: p.restaurant_id, enterprise_nom: rest.nom || null, enterprise_type: 'restaurant', enterprise_image_url: rest.image_url || null });
        }
      }
    }
    if (includeArticles) {
      const { data: boutiques, error: boutErr } = await db.from('boutiques').select('id, nom, image_url').eq('statut', ACTIVE);
      if (boutErr) throw boutErr;
      const boutById = new Map((boutiques || []).map((b) => [b.id, b]));
      const boutIds = [...boutById.keys()];
      if (boutIds.length) {
        const { data, error } = await db.from('articles').select('*').in('boutique_id', boutIds).or(`nom.ilike.${pattern},description.ilike.${pattern}`).limit(limit);
        if (error) throw error;
        for (const a of data || []) {
          const bou = boutById.get(a.boutique_id);
          if (!bou) continue;
          products.push({ ...mapArticleToProduct(a, a.boutique_id), enterprise_id: a.boutique_id, enterprise_nom: bou.nom || null, enterprise_type: 'boutique', enterprise_image_url: bou.image_url || null });
        }
      }
    }
    return res.json({ products: products.slice(0, limit), enterprises: enterprises.slice(0, Math.min(limit, 12)) });
  } catch (error) { return next(error); }
}

async function createProduct(req, res, next) {
  try {
    const { enterpriseId } = req.params;
    const { description, prixPromo, stock, stockIllimite, imageUrl, imagesUrls, categorieId, estEnVedette, estDisponible, reference, unite, options, tags, promoDebutAt, promoFinAt, allergenes, typeProduit, etatProduit, marque, poidsKg, dimensions } = req.body;
    requireFields(req.body, ['nom', 'prix']);
    const validators = require('../lib/validators');
    const nomClean = validators.requireValid(req.body.nom, validators.validateProductName, 'nom');
    const prixClean = validators.requireValid(req.body.prix, validators.validatePrice, 'prix');
    const descriptionClean = description ? validators.requireValid(description, (v) => validators.validateDescription(v, 500), 'description') : null;
    if (prixPromo != null && prixPromo !== '') validators.requireValid(prixPromo, validators.validatePrice, 'prixPromo');
    validators.requireValidPromo({ prixNormal: prixClean, prixPromo, promoDebutAt, promoFinAt });
    if (stock !== undefined && stock !== null && stock !== '' && !stockIllimite) validators.requireValid(stock, validators.validateStock, 'stock');
    require('../lib/content-policy').assertListingContent(req.body);
    const imgUrl = parseImageUrl(imageUrl);
    const normalizedOptions = options !== undefined ? normalizeOptionGroups(options) : undefined;
    const db = getDb();
    const resolved = await resolveEstablishment(db, enterpriseId);
    if (!resolved) throw createHttpError(404, 'Établissement introuvable');
    const { kind, row } = resolved;
    if (!canManageEstablishment(req, row)) throw createHttpError(403, 'Action non autorisée pour cet établissement');
    if (kind === 'restaurant') {
      if (req.auth.role !== 'admin' && req.auth.role !== 'restaurateur') throw createHttpError(403, 'Seul un restaurateur peut ajouter des plats.');
      const insertPlat = { restaurant_id: enterpriseId, nom: nomClean, description: descriptionClean, prix: Number(prixClean), est_disponible: estDisponible !== undefined ? Boolean(estDisponible) : true, image_url: imgUrl, est_en_vedette: Boolean(estEnVedette), options: normalizedOptions !== undefined ? normalizedOptions : options ?? null };
      if (categorieId) insertPlat.categorie_id = categorieId;
      if (prixPromo != null && prixPromo !== '') insertPlat.prix_promo = Number(prixPromo);
      applyPlatCatalogFields(insertPlat, { tags, allergenes, promoDebutAt, promoFinAt, estDisponible, imagesUrls, imageUrl: imgUrl });
      if (stockIllimite === true) insertPlat.stock = null;
      else if (stock !== undefined && stock !== null && stock !== '') insertPlat.stock = Math.max(0, Math.floor(Number(stock)));
      const data = await insertPlatRow(db, insertPlat);
      return res.status(201).json(mapPlatToProduct(data, enterpriseId));
    }
    if (req.auth.role !== 'admin' && req.auth.role !== 'commercant') throw createHttpError(403, 'Seul un commerçant peut ajouter des articles.');
    const insertArt = { boutique_id: enterpriseId, nom: nomClean, description: descriptionClean, prix: Number(prixClean), stock: stockIllimite ? null : (stock === undefined || stock === null ? null : Math.max(0, Math.floor(Number(stock)))), est_disponible: estDisponible !== undefined ? Boolean(estDisponible) : true, image_url: imgUrl, est_en_vedette: Boolean(estEnVedette), options: normalizedOptions !== undefined ? normalizedOptions : options ?? null };
    if (categorieId) insertArt.categorie_id = categorieId;
    if (prixPromo != null && prixPromo !== '') insertArt.prix_promo = Number(prixPromo);
    insertArt.reference = reference ? String(reference).trim() : `GLV-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    if (unite) insertArt.unite = String(unite).trim();
    applyArticleCatalogFields(insertArt, { tags, imagesUrls, imageUrl: imgUrl, promoDebutAt, promoFinAt, typeProduit, etatProduit, marque, poidsKg, dimensions, estDisponible });
    const data = await insertArticleRow(db, insertArt);
    return res.status(201).json(mapArticleToProduct(data, enterpriseId));
  } catch (error) { return next(error); }
}

async function updateProduct(req, res, next) {
  try {
    const { enterpriseId, productId } = req.params;
    const { nom, description, prix, prixPromo, stock, stockIllimite, imageUrl, imagesUrls, estDisponible, categorieId, estEnVedette, reference, unite, options, tags, promoDebutAt, promoFinAt, allergenes, typeProduit, etatProduit, marque, poidsKg, dimensions } = req.body;
    const db = getDb();
    const resolved = await resolveEstablishment(db, enterpriseId);
    if (!resolved) throw createHttpError(404, 'Établissement introuvable');
    const { kind, row } = resolved;
    if (!canManageEstablishment(req, row)) throw createHttpError(403, 'Action non autorisée pour cet établissement');
    const existing = await findProductInEstablishment(db, kind, enterpriseId, productId);
    if (!existing) throw createHttpError(404, 'Produit introuvable');
    const validators = require('../lib/validators');
    if (nom !== undefined) validators.requireValid(nom, validators.validateProductName, 'nom');
    if (description !== undefined && description !== null) validators.requireValid(description, (v) => validators.validateDescription(v, 500), 'description');
    if (prix !== undefined) validators.requireValid(prix, validators.validatePrice, 'prix');
    if (prixPromo !== undefined && prixPromo !== null) validators.requireValid(prixPromo, validators.validatePrice, 'prixPromo');
    if (prix !== undefined || prixPromo !== undefined || promoDebutAt !== undefined || promoFinAt !== undefined) {
      validators.requireValidPromo({ prixNormal: prix !== undefined ? prix : existing.prix, prixPromo: prixPromo !== undefined ? prixPromo : existing.prix_promo, promoDebutAt: promoDebutAt !== undefined ? promoDebutAt : existing.promo_debut_at, promoFinAt: promoFinAt !== undefined ? promoFinAt : existing.promo_fin_at });
    }
    if (stock !== undefined && stock !== null && stock !== '' && !stockIllimite) validators.requireValid(stock, validators.validateStock, 'stock');
    require('../lib/content-policy').assertListingContent(req.body);
    if (kind === 'restaurant') {
      if (req.auth.role !== 'admin' && req.auth.role !== 'restaurateur') throw createHttpError(403, 'Seul un restaurateur peut modifier des plats.');
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
      if (stockIllimite === true) patch.stock = null;
      else if (stock !== undefined) patch.stock = stock === null || stock === '' ? null : Math.max(0, Math.floor(Number(stock)));
      const imagesPatch = { imagesUrls: imagesUrls !== undefined ? imagesUrls : normalizeImagesUrls(existing.images_urls), imageUrl: imageUrl !== undefined ? parseImageUrl(imageUrl) : existing.image_url };
      applyPlatCatalogFields(patch, { ...req.body, ...imagesPatch });
      const data = await updatePlatRow(db, productId, patch);
      return res.json(mapPlatToProduct(data, enterpriseId));
    }
    if (req.auth.role !== 'admin' && req.auth.role !== 'commercant') throw createHttpError(403, 'Seul un commerçant peut modifier des articles.');
    const patch = {};
    if (nom !== undefined) patch.nom = String(nom).trim();
    if (description !== undefined) patch.description = description || null;
    if (prix !== undefined) patch.prix = Number(prix);
    if (imageUrl !== undefined) patch.image_url = parseImageUrl(imageUrl);
    if (estDisponible !== undefined) patch.est_disponible = Boolean(estDisponible);
    if (stockIllimite === true) patch.stock = null;
    else if (stock !== undefined) patch.stock = stock === null ? null : Math.max(0, Math.floor(Number(stock)));
    if (prixPromo !== undefined) patch.prix_promo = prixPromo === null ? null : Number(prixPromo);
    if (categorieId !== undefined) patch.categorie_id = categorieId || null;
    if (estEnVedette !== undefined) patch.est_en_vedette = Boolean(estEnVedette);
    if (reference !== undefined) patch.reference = reference || null;
    if (unite !== undefined) patch.unite = unite || null;
    if (options !== undefined) patch.options = normalizeOptionGroups(options);
    const imagesPatch = { imagesUrls: imagesUrls !== undefined ? imagesUrls : normalizeImagesUrls(existing.images_urls), imageUrl: imageUrl !== undefined ? parseImageUrl(imageUrl) : existing.image_url };
    applyArticleCatalogFields(patch, { ...req.body, ...imagesPatch });
    const data = await updateArticleRow(db, productId, patch);
    return res.json(mapArticleToProduct(data, enterpriseId));
  } catch (error) { return next(error); }
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
  } catch (error) { return next(error); }
}

async function trackProductView(req, res, next) {
  try {
    const { enterpriseId, productId } = req.params;
    const { ids } = req.body || {};
    const db = getDb();
    const resolved = await resolveEstablishment(db, enterpriseId);
    if (!resolved) return res.status(204).send();
    const { kind } = resolved;
    const table = kind === 'restaurant' ? 'plats' : 'articles';
    const fk = kind === 'restaurant' ? 'restaurant_id' : 'boutique_id';
    let targetIds = Array.isArray(ids) && ids.length ? ids.filter((x) => typeof x === 'string' && x.length === 36).slice(0, 50) : (productId ? [productId] : []);
    if (!targetIds.length) return res.status(204).send();
    await Promise.all(targetIds.map(async (id) => {
      try { await db.rpc('increment_product_view', { p_table: table, p_id: id }); }
      catch {
        const { data: cur } = await db.from(table).select('id, nb_vues').eq('id', id).eq(fk, enterpriseId).maybeSingle();
        if (cur) await db.from(table).update({ nb_vues: Number(cur.nb_vues ?? 0) + 1 }).eq('id', id);
      }
    }));
    return res.status(204).send();
  } catch (error) { return res.status(204).send(); }
}

async function trackProductClick(req, res, next) {
  try {
    const { enterpriseId, productId } = req.params;
    const db = getDb();
    const resolved = await resolveEstablishment(db, enterpriseId);
    if (!resolved) return res.status(204).send();
    const { kind } = resolved;
    const table = kind === 'restaurant' ? 'plats' : 'articles';
    const fk = kind === 'restaurant' ? 'restaurant_id' : 'boutique_id';
    try { await db.rpc('increment_product_click', { p_table: table, p_id: productId }); }
    catch {
      const { data: cur } = await db.from(table).select('id, nb_clics').eq('id', productId).eq(fk, enterpriseId).maybeSingle();
      if (cur) await db.from(table).update({ nb_clics: Number(cur.nb_clics ?? 0) + 1 }).eq('id', productId);
    }
    return res.status(204).send();
  } catch (error) { return res.status(204).send(); }
}

module.exports = { listProducts, listProductFeed, searchCatalog, createProduct, updateProduct, deleteProduct, trackProductView, trackProductClick };
