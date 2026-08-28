const { getDb } = require('../config/db');
const { createHttpError, requireFields } = require('../utils/http');
const { getUserScores, personalizeResults } = require('../services/personalization.service');
const { loadCategoryNameMap } = require('./product-category.controller');
const { resolveStoredImage } = require('../utils/images');

const ACTIVE = 'active';

// ── Cache mémoire court du feed (la base d'établissements + plats/articles
//    change rarement à l'échelle des secondes). Réduit la charge DB et la
//    latence perçue au scroll infini. TTL volontairement court (10 s).
const FEED_CACHE_TTL_MS = 10_000;
const feedCache = new Map(); // key → { at, payload }

function feedCacheKey(type, onlyPromo, villeId, limit, offset, userId) {
  return [userId || 'anon', type || 'all', onlyPromo ? 'promo' : 'all', villeId || 'any', limit, offset].join('|');
}

function feedCacheGet(key) {
  const hit = feedCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > FEED_CACHE_TTL_MS) {
    feedCache.delete(key);
    return null;
  }
  return hit.payload;
}

function feedCacheSet(key, payload) {
  // Garde le cache borné (≤ 400 entrées) pour éviter toute fuite mémoire.
  if (feedCache.size >= 400) feedCache.clear();
  feedCache.set(key, { at: Date.now(), payload });
}

function isMissingColumnError(error, column) {
  const msg = String(error?.message ?? error ?? '').toLowerCase();
  return msg.includes(column) && (msg.includes('column') || msg.includes('colonne') || msg.includes('schema'));
}

async function resolveEstablishment(db, enterpriseId) {
  const { data: r } = await db.from('restaurants').select('*').eq('id', enterpriseId).maybeSingle();
  if (r) return { kind: 'restaurant', row: r };
  const { data: b } = await db.from('boutiques').select('*').eq('id', enterpriseId).maybeSingle();
  if (b) return { kind: 'boutique', row: b };
  return null;
}

/**
 * Sélectionne les commerces actifs avec gestion défensive des colonnes :
 * si une colonne optionnelle (image_url, ville_id, logo_url…) n'existe pas
 * dans le schéma appliqué en production, on réessaie sans elle au lieu de 500.
 */
async function selectActiveEstablishments(db, table, { villeId } = {}) {
  const base = ['id', 'nom'];
  const optional = ['image_url', 'ville_id', 'logo_url'];
  const attempt = (cols, withVille) => {
    let q = db.from(table).select(cols.join(', ')).eq('statut', ACTIVE);
    if (withVille && villeId) q = q.eq('ville_id', villeId);
    return q;
  };
  const full = await attempt([...base, ...optional], true);
  if (!full.error) return full.data || [];
  if (optional.some((c) => isMissingColumnError(full.error, c))) {
    // On conserve le filtre ville s'il était demandé et que la colonne existe
    // (sinon on renverrait des commerces hors de la ville), avec repli
    // « meilleur effort » sans filtre quand la colonne ville_id manque.
    const villeMissing = isMissingColumnError(full.error, 'ville_id');
    if (!villeMissing && villeId) {
      const baseRes = await attempt(base, true);
      if (!baseRes.error) return baseRes.data || [];
    }
    const noVille = await attempt(base, false);
    if (!noVille.error) return noVille.data || [];
    throw full.error;
  }
  throw full.error;
}

// PostgREST limite la longueur d'URL de requête (~8 Ko) : un filtre
// `in.(id1,id2,…)` avec des centaines d'ids fait exploser l'URL → 500
// systématique sur le feed quand la plateforme grossit. On découpe donc
// les listes d'ids en lots et on fusionne les résultats.
const IN_CHUNK_SIZE = 60;

async function fetchRowsByIdsInChunks(db, table, column, ids, applyQuery) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const chunks = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK_SIZE) {
    chunks.push(ids.slice(i, i + IN_CHUNK_SIZE));
  }
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      let q = db.from(table).select('*').in(column, chunk);
      if (typeof applyQuery === 'function') q = applyQuery(q);
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    }),
  );
  // Fusion sans doublons + tri stable par nom (les requêtes parallèles ne
  // garantissent pas l'ordre du `order('nom')` serveur).
  const seen = new Set();
  const merged = [];
  for (const rows of results) {
    for (const row of rows) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        merged.push(row);
      }
    }
  }
  return merged.sort((a, b) => String(a.nom ?? '').localeCompare(String(b.nom ?? ''), 'fr', { sensitivity: 'base' }));
}

/**
 * Enregistre un échec de sous-requête du feed (dégradation gracieuse) :
 * le feed continue de répondre 200 avec les données disponibles, et
 * l'incident est tout de même tracé avec le vrai message pour le suivi.
 */
function recordFeedSubError(req, part, error) {
  const { recordIncidentAsync, incidentFromHttpError } = require('../services/observability.service');
  console.error(`[Feed] ${part} sub-query failed (requestId=${req?.requestId || 'unknown'}):`, error?.message || error);
  try {
    recordIncidentAsync(
      incidentFromHttpError(
        { ...error, status: 500, message: `[Feed] ${part} : ${error?.message || String(error)}` },
        req,
        {
          title: `[API dégradé] ${req?.method || 'GET'} ${req?.originalUrl || 'feed'} — ${part}`,
          source: 'backend',
          metadata: { part, code: error?.code || null, details: error?.details || null },
        },
      ),
    );
  } catch {
    // L'observabilité ne doit jamais faire échouer la réponse.
  }
}

async function searchActiveEstablishments(db, table, pattern, limit) {
  const base = ['id', 'nom', 'description', 'adresse_ligne1', 'categorie_id'];
  const optional = ['image_url', 'logo_url'];
  const attempt = (cols) =>
    db
      .from(table)
      .select(cols.join(', '))
      .eq('statut', ACTIVE)
      .or(`nom.ilike.${pattern},description.ilike.${pattern},adresse_ligne1.ilike.${pattern}`)
      .limit(limit);
  const full = await attempt([...base, ...optional]);
  if (!full.error) return full.data || [];
  if (optional.some((c) => isMissingColumnError(full.error, c))) {
    const baseRes = await attempt(base);
    if (!baseRes.error) return baseRes.data || [];
    throw baseRes.error;
  }
  throw full.error;
}

function enterpriseImageUrl(row) {
  return row?.logo_url || row?.image_url || null;
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
      throw createHttpError(400, 'L\u2019image principale est déjà présente dans la galerie. Évitez les doublons.');
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

/**
 * Compute the best image URL for a product in the feed (resolveBytea=false).
 * Uses image_url (HTTP) if available, otherwise generates the /api/images
 * endpoint URL when we know the product has an image (image_mime or image
 * column present).
 *
 * We check `image_mime` as a lightweight TEXT flag — Supabase always returns
 * TEXT columns even when bytea is dropped. If image_mime is truthy, we know
 * an image EXISTS and the endpoint can serve it.
 */
function feedImageUrl(p) {
  const explicit = p.image_url ?? null;
  if (explicit) return explicit;
  // Generate endpoint URL only if we know the product has an image.
  // image_mime is a small TEXT column that Supabase PostgREST always returns.
  if ((p.image_mime || p.image) && p.id) {
    return `/api/images/products/${p.id}`;
  }
  return null;
}

function mapPlatToProduct(p, enterpriseId, categoryNames, resolveBytea = true) {
  let stock = null;
  if (p.stock !== null && p.stock !== undefined) stock = Math.max(0, Number(p.stock));
  if (p.est_disponible === false) stock = 0;
  let imageUrl;
  if (resolveBytea) {
    imageUrl = resolveStoredImage(p.image_url, p.image, p.image_mime);
  } else {
    imageUrl = feedImageUrl(p);
  }
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
    image_url: imageUrl,
    images_urls: normalizeImagesUrls(p.images_urls),
    categorie_id: p.categorie_id ?? null,
    categorie_nom: p.categorie_id && categoryNames ? categoryNames.get(p.categorie_id) ?? null : null,
    tags: Array.isArray(p.tags) ? p.tags : [],
    allergenes: Array.isArray(p.allergenes) ? p.allergenes : [],
    kind: 'plat',
    options: p.options ?? null,
  };
}

function mapArticleToProduct(a, enterpriseId, categoryNames, resolveBytea = true) {
  let stock = null;
  if (a.stock !== null && a.stock !== undefined) stock = Math.max(0, Number(a.stock));
  if (!a.est_disponible) stock = 0;
  let imageUrl;
  if (resolveBytea) {
    imageUrl = resolveStoredImage(a.image_url, a.image, a.image_mime);
  } else {
    imageUrl = feedImageUrl(a);
  }
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
    image_url: imageUrl,
    images_urls: normalizeImagesUrls(a.images_urls),
    kind: 'article',
    options: a.options ?? null,
    reference: a.reference ?? null,
    unite: a.unite ?? null,
    categorie_id: a.categorie_id ?? null,
    categorie_nom: a.categorie_id && categoryNames ? categoryNames.get(a.categorie_id) ?? null : null,
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
  throw createHttpError(500, 'Impossible d\u2019enregistrer l\u2019article.');
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
  throw createHttpError(500, 'Impossible d\u2019enregistrer le plat.');
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
  throw createHttpError(500, 'Impossible de mettre à jour l\u2019article.');
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
    const categoryNames = await loadCategoryNameMap(db);
    if (kind === 'restaurant') {
      const { data, error } = await db.from('plats').select('*').eq('restaurant_id', enterpriseId).order('nom');
      if (error) throw error;
      return res.json((data || []).map((p) => mapPlatToProduct(p, enterpriseId, categoryNames)));
    }
    const { data, error } = await db.from('articles').select('*').eq('boutique_id', enterpriseId).order('nom');
    if (error) throw error;
    return res.json((data || []).map((a) => mapArticleToProduct(a, enterpriseId, categoryNames)));
  } catch (error) { return next(error); }
}

async function listProductFeed(req, res, next) {
  try {
    const db = getDb();
    const type = typeof req.query.type === 'string' ? req.query.type.toLowerCase() : null;
    const onlyPromo = String(req.query.promo || '').toLowerCase() === 'true';
    const villeId = typeof req.query.ville_id === 'string' && req.query.ville_id.trim() ? req.query.ville_id.trim() : null;
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 30));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const includePlats = !type || type === 'plat' || type === 'all';
    const includeArticles = !type || type === 'article' || type === 'all';
    const userId = req.auth?.userId;

    // --- Cache court (10 s) VÉRIFIÉ AVANT toute requête DB : le coût réel du
    //    feed est la collecte des établissements + plats/articles + noms de
    //    catégories. Le catalogue bouge peu à cette échelle. Clé = params +
    //    utilisateur (personnalisation) pour éviter tout résultat croisé.
    const cacheKey = feedCacheKey(type, onlyPromo, villeId, limit, offset, userId);
    const cached = feedCacheGet(cacheKey);
    if (cached) return res.json(cached);

    const out = [];
    const categoryNames = await loadCategoryNameMap(db);
    if (includePlats) {
      const restaurants = await selectActiveEstablishments(db, 'restaurants', { villeId });
      const restById = new Map((restaurants || []).map((r) => [r.id, r]));
      const restIds = [...restById.keys()];
      if (restIds.length) {
        try {
          const rows = await fetchRowsByIdsInChunks(db, 'plats', 'restaurant_id', restIds, (q) => {
            let query = q.eq('est_disponible', true);
            if (onlyPromo) query = query.not('prix_promo', 'is', null);
            return query;
          });
          for (const p of rows) {
            const rest = restById.get(p.restaurant_id);
            if (!rest) continue;
            out.push({ ...mapPlatToProduct(p, p.restaurant_id, categoryNames, false), enterprise_id: p.restaurant_id, enterprise_nom: rest.nom || null, enterprise_type: 'restaurant', enterprise_image_url: enterpriseImageUrl(rest) });
          }
        } catch (subErr) {
          // Un échec sur les plats ne doit pas faire planter tout le feed.
          recordFeedSubError(req, 'plats', subErr);
        }
      }
    }
    if (includeArticles) {
      const boutiques = await selectActiveEstablishments(db, 'boutiques');
      const boutById = new Map((boutiques || []).map((b) => [b.id, b]));
      const boutIds = [...boutById.keys()];
      if (boutIds.length) {
        try {
          const rows = await fetchRowsByIdsInChunks(db, 'articles', 'boutique_id', boutIds, (q) => {
            let query = q.eq('est_disponible', true);
            if (onlyPromo) query = query.not('prix_promo', 'is', null);
            return query;
          });
          for (const a of rows) {
            const bou = boutById.get(a.boutique_id);
            if (!bou) continue;
            out.push({ ...mapArticleToProduct(a, a.boutique_id, categoryNames, false), enterprise_id: a.boutique_id, enterprise_nom: bou.nom || null, enterprise_type: 'boutique', enterprise_image_url: enterpriseImageUrl(bou) });
          }
        } catch (subErr) {
          // Un échec sur les articles ne doit pas faire planter tout le feed.
          recordFeedSubError(req, 'articles', subErr);
        }
      }
    }
    // --- Personnalisation Algorithmique ---
    let result;
    if (userId) {
      const scores = await getUserScores(userId);
      const personalized = personalizeResults(out, scores, { rotationStrength: 0.2 });
      result = personalized.slice(offset, offset + limit);
    } else {
      // Pour les anonymes, on garde un mélange aléatoire de base
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      result = out.slice(offset, offset + limit);
    }

    feedCacheSet(cacheKey, result);
    return res.json(result);
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
    const categoryNames = includePlats || includeArticles ? await loadCategoryNameMap(db) : null;
    if (includeRestaurants) {
      const rows = await searchActiveEstablishments(db, 'restaurants', pattern, Math.min(limit, 12));
      for (const r of rows || []) enterprises.push({ id: r.id, nom: r.nom, type: 'restaurant', description: r.description ?? null, adresse: r.adresse_ligne1 ?? null, image_url: enterpriseImageUrl(r), categorie_id: r.categorie_id ?? null });
    }
    if (includeBoutiques) {
      const rows = await searchActiveEstablishments(db, 'boutiques', pattern, Math.min(limit, 12));
      for (const b of rows || []) enterprises.push({ id: b.id, nom: b.nom, type: 'boutique', description: b.description ?? null, adresse: b.adresse_ligne1 ?? null, image_url: enterpriseImageUrl(b), categorie_id: b.categorie_id ?? null });
    }
    if (includePlats) {
      const restaurants = await selectActiveEstablishments(db, 'restaurants');
      const restById = new Map((restaurants || []).map((r) => [r.id, r]));
      const restIds = [...restById.keys()];
      if (restIds.length) {
        let platsRows = [];
        try {
          platsRows = await fetchRowsByIdsInChunks(db, 'plats', 'restaurant_id', restIds, (q) =>
            q.eq('est_disponible', true).or(`nom.ilike.${pattern},description.ilike.${pattern}`).limit(limit),
          );
        } catch (subErr) {
          recordFeedSubError(req, 'search_plats', subErr);
        }
        for (const p of platsRows) {
          const rest = restById.get(p.restaurant_id);
          if (!rest) continue;
          products.push({ ...mapPlatToProduct(p, p.restaurant_id, categoryNames, false), enterprise_id: p.restaurant_id, enterprise_nom: rest.nom || null, enterprise_type: 'restaurant', enterprise_image_url: enterpriseImageUrl(rest) });
        }
      }
    }
    if (includeArticles) {
      const boutiques = await selectActiveEstablishments(db, 'boutiques');
      const boutById = new Map((boutiques || []).map((b) => [b.id, b]));
      const boutIds = [...boutById.keys()];
      if (boutIds.length) {
        let articlesRows = [];
        try {
          articlesRows = await fetchRowsByIdsInChunks(db, 'articles', 'boutique_id', boutIds, (q) =>
            q.eq('est_disponible', true).or(`nom.ilike.${pattern},description.ilike.${pattern}`).limit(limit),
          );
        } catch (subErr) {
          recordFeedSubError(req, 'search_articles', subErr);
        }
        for (const a of articlesRows) {
          const bou = boutById.get(a.boutique_id);
          if (!bou) continue;
          products.push({ ...mapArticleToProduct(a, a.boutique_id, categoryNames, false), enterprise_id: a.boutique_id, enterprise_nom: bou.nom || null, enterprise_type: 'boutique', enterprise_image_url: enterpriseImageUrl(bou) });
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
      feedCache.clear(); // le catalogue vient de changer → on sert du frais immédiatement
      const categoryNames = await loadCategoryNameMap(db);
      return res.status(201).json(mapPlatToProduct(data, enterpriseId, categoryNames));
    }
    if (req.auth.role !== 'admin' && req.auth.role !== 'commercant') throw createHttpError(403, 'Seul un commerçant peut ajouter des articles.');
    const insertArt = { boutique_id: enterpriseId, nom: nomClean, description: descriptionClean, prix: Number(prixClean), stock: stockIllimite ? null : (stock === undefined || stock === null ? null : Math.max(0, Math.floor(Number(stock)))), est_disponible: estDisponible !== undefined ? Boolean(estDisponible) : true, image_url: imgUrl, est_en_vedette: Boolean(estEnVedette), options: normalizedOptions !== undefined ? normalizedOptions : options ?? null };
    if (categorieId) insertArt.categorie_id = categorieId;
    if (prixPromo != null && prixPromo !== '') insertArt.prix_promo = Number(prixPromo);
    insertArt.reference = reference ? String(reference).trim() : `GLV-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    if (unite) insertArt.unite = String(unite).trim();
    applyArticleCatalogFields(insertArt, { tags, imagesUrls, imageUrl: imgUrl, promoDebutAt, promoFinAt, typeProduit, etatProduit, marque, poidsKg, dimensions, estDisponible });
    const data = await insertArticleRow(db, insertArt);
    feedCache.clear(); // le catalogue vient de changer → on sert du frais immédiatement
    const categoryNames = await loadCategoryNameMap(db);
    return res.status(201).json(mapArticleToProduct(data, enterpriseId, categoryNames));
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
      feedCache.clear(); // le catalogue vient de changer → on sert du frais immédiatement
      const categoryNames = await loadCategoryNameMap(db);
      return res.json(mapPlatToProduct(data, enterpriseId, categoryNames));
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
    feedCache.clear(); // le catalogue vient de changer → on sert du frais immédiatement
    const categoryNames = await loadCategoryNameMap(db);
    return res.json(mapArticleToProduct(data, enterpriseId, categoryNames));
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
    feedCache.clear(); // le catalogue vient de changer → on sert du frais immédiatement
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
