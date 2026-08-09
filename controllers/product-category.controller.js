const { getDb } = require('../config/db');
const { createHttpError, requireFields } = require('../utils/http');

// Les catégories sont GLOBALES et gérées par GoLivra (admin) :
//   • categories_produits     → produits des boutiques
//   • categories_menus        → plats des restaurants
//   • categories_boutiques    → types de boutiques (choisis à l'inscription)
//   • categories_restaurants  → types de restaurants (choisis à l'inscription)
// Le vendeur choisit dans ce référentiel — il ne crée plus de catégorie.
//
// Note de schéma : les tables produits/menus nomment la colonne image
// « image_url », tandis que les tables boutiques/restaurants utilisent
// « icone_url ». L'API expose toujours « image_url » côté admin.

const CATEGORY_TABLES = {
  produits: { table: 'categories_produits', imageCol: 'image_url' },
  menus: { table: 'categories_menus', imageCol: 'image_url' },
  boutiques: { table: 'categories_boutiques', imageCol: 'icone_url' },
  restaurants: { table: 'categories_restaurants', imageCol: 'icone_url' },
};

function categoryConfigFor(type) {
  const cfg = CATEGORY_TABLES[String(type || '').toLowerCase()];
  if (!cfg) throw createHttpError(400, 'Type de catégories invalide (produits | menus | boutiques | restaurants).');
  return cfg;
}

function categoryTableFor(kind) {
  if (kind === 'restaurant') return CATEGORY_TABLES.menus.table;
  if (kind === 'boutique') return CATEGORY_TABLES.produits.table;
  return null;
}

/**
 * Colonnes lues par le back-office.
 * ⚠️ IMPORTANT : PostgREST ne supporte PAS la syntaxe SQL `AS` dans le select
 * (il interprète « image_url AS image_url » comme une colonne littérale
 * « image_urlASimage_url » → erreur 42703). On sélectionne donc la colonne
 * réelle (image_url ou icone_url) et on la renomme côté JavaScript.
 */
function adminSelectFor(cfg) {
  return `id, nom, description, ${cfg.imageCol}, ordre, est_active, created_at`;
}

/** Renomme la colonne image réelle (image_url/icone_url) en « image_url » (contrat API). */
function applyImageAlias(row, cfg) {
  if (!row || !cfg || cfg.imageCol === 'image_url') return row;
  const next = { ...row };
  if (next[cfg.imageCol] !== undefined) {
    next.image_url = next[cfg.imageCol];
    delete next[cfg.imageCol];
  }
  return next;
}

async function resolveEstablishment(db, enterpriseId) {
  const { data: r } = await db.from('restaurants').select('id, proprietaire_id, statut').eq('id', enterpriseId).maybeSingle();
  if (r) return { kind: 'restaurant', row: r };
  const { data: b } = await db.from('boutiques').select('id, proprietaire_id, statut').eq('id', enterpriseId).maybeSingle();
  if (b) return { kind: 'boutique', row: b };
  return null;
}

/**
 * Récupère les lignes d'un référentiel de catégories en exposant toujours
 * « image_url » (mapping icone_url → image_url selon la table).
 */
async function fetchCategories(db, cfg, { includeInactive } = {}) {
  const { table, imageCol } = cfg;
  // Pas de `AS` (non supporté par PostgREST) : colonne réelle + renommage JS.
  const selectExpr =
    `id, nom, description, ${imageCol}, ordre, est_active` +
    (includeInactive ? ', created_at' : '');
  let q = db.from(table).select(selectExpr);
  if (!includeInactive) q = q.eq('est_active', true);
  q = q.order('ordre', { ascending: true }).order('nom', { ascending: true });
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map((row) => applyImageAlias(row, cfg));
}

/**
 * GET /api/products/categories?type=produits|menus|boutiques|restaurants
 * Liste globale publique des catégories actives (client + vendeur).
 */
async function listGlobalCategories(req, res, next) {
  try {
    const type = String(req.query.type || 'produits').toLowerCase();
    const cfg = categoryConfigFor(type);
    const db = getDb();
    return res.json(await fetchCategories(db, cfg));
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /api/products/enterprise/:enterpriseId/categories
 * Rétrocompatibilité : résout le type d'établissement puis renvoie la liste
 * globale correspondante. Le vendeur ne crée plus de catégorie.
 */
async function listProductCategories(req, res, next) {
  try {
    const { enterpriseId } = req.params;
    const db = getDb();
    const resolved = await resolveEstablishment(db, enterpriseId);
    if (!resolved) throw createHttpError(404, 'Établissement introuvable');
    const table = categoryTableFor(resolved.kind);
    if (!table) throw createHttpError(400, 'Type d’établissement sans catégories de produits.');
    const cfg = CATEGORY_TABLES[resolved.kind === 'restaurant' ? 'menus' : 'produits'];
    return res.json(await fetchCategories(db, cfg));
  } catch (error) {
    return next(error);
  }
}

/* ──────────────────────────────────────────────────────────────
 * Administration GoLivra — CRUD des catégories globales
 * type = produits | menus | boutiques | restaurants
 * ────────────────────────────────────────────────────────────── */

/** GET /api/admin/categories?type=… — toutes (actives et inactives). */
async function listAdminCategories(req, res, next) {
  try {
    const type = String(req.query.type || 'produits').toLowerCase();
    const cfg = categoryConfigFor(type);
    const db = getDb();
    const rows = await fetchCategories(db, cfg, { includeInactive: true });
    // fetchCategories renvoie created_at seulement si includeInactive — on
    // garantit le champ sur toutes les lignes pour un contrat stable.
    return res.json(rows.map((r) => ({ ...r, created_at: r.created_at ?? null })));
  } catch (error) {
    return next(error);
  }
}

/** POST /api/admin/categories — créer une catégorie globale. */
async function createAdminCategory(req, res, next) {
  try {
    const type = String(req.body.type || 'produits').toLowerCase();
    const cfg = categoryConfigFor(type);
    requireFields(req.body, ['nom']);
    const { nom, description, image_url, ordre, est_active } = req.body;
    const db = getDb();
    const { data, error } = await db
      .from(cfg.table)
      .insert({
        nom: String(nom).trim(),
        description: description ? String(description).trim() : null,
        [cfg.imageCol]: image_url || null,
        ordre: Number.isFinite(Number(ordre)) ? Number(ordre) : 0,
        est_active: est_active !== undefined ? Boolean(est_active) : true,
      })
      .select(adminSelectFor(cfg))
      .single();
    if (error) throw error;
    invalidateCategoryNameCache();
    return res.status(201).json(applyImageAlias(data, cfg));
  } catch (error) {
    return next(error);
  }
}

/** PATCH /api/admin/categories/:categoryId — modifier une catégorie globale. */
async function updateAdminCategory(req, res, next) {
  try {
    const type = String(req.body.type || 'produits').toLowerCase();
    const cfg = categoryConfigFor(type);
    const { categoryId } = req.params;
    const { nom, description, image_url, ordre, est_active } = req.body;
    const db = getDb();
    const patch = {};
    if (nom !== undefined) patch.nom = String(nom).trim();
    if (description !== undefined) patch.description = description ? String(description).trim() : null;
    if (image_url !== undefined) patch[cfg.imageCol] = image_url || null;
    if (ordre !== undefined) patch.ordre = Number.isFinite(Number(ordre)) ? Number(ordre) : 0;
    if (est_active !== undefined) patch.est_active = Boolean(est_active);
    const { data, error } = await db
      .from(cfg.table)
      .update(patch)
      .eq('id', categoryId)
      .select(adminSelectFor(cfg))
      .single();
    if (error) throw error;
    invalidateCategoryNameCache();
    return res.json(applyImageAlias(data, cfg));
  } catch (error) {
    return next(error);
  }
}

/** DELETE /api/admin/categories/:categoryId — supprimer une catégorie globale. */
async function deleteAdminCategory(req, res, next) {
  try {
    const type = String(req.body.type || req.query.type || 'produits').toLowerCase();
    const cfg = categoryConfigFor(type);
    const { categoryId } = req.params;
    const db = getDb();
    const { error } = await db.from(cfg.table).delete().eq('id', categoryId);
    if (error) throw error;
    invalidateCategoryNameCache();
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
}

/**
 * Charge un Map<categoryId, nom> depuis les référentiels produits + menus.
 * Mémoïsé 30 s (2 requêtes DB à chaque appel sinon, y compris feed, recherche
 * et catalogue) : le référentiel de catégories change rarement.
 */
const CATEGORY_NAME_MAP_TTL_MS = 30_000;
let categoryNameCache = null;
let categoryNameCacheAt = 0;

async function loadCategoryNameMap(db) {
  const now = Date.now();
  if (categoryNameCache && now - categoryNameCacheAt < CATEGORY_NAME_MAP_TTL_MS) {
    return categoryNameCache;
  }
  const map = new Map();
  let hadError = false;
  for (const key of ['produits', 'menus']) {
    const cfg = CATEGORY_TABLES[key];
    const { data, error } = await db.from(cfg.table).select('id, nom');
    if (error) {
      hadError = true;
      continue;
    }
    for (const c of data || []) map.set(c.id, c.nom);
  }
  // On ne mémorise QUE si les deux requêtes ont réussi : un map partiel
  // (erreur transitoire) ne doit pas être servi pendant 30 s à tous les appels.
  if (!hadError) {
    categoryNameCache = map;
    categoryNameCacheAt = now;
  }
  return map;
}

/** Invalide la mémoire des noms de catégories (appelé après un CRUD admin). */
function invalidateCategoryNameCache() {
  categoryNameCache = null;
  categoryNameCacheAt = 0;
}

module.exports = {
  listGlobalCategories,
  listProductCategories,
  listAdminCategories,
  createAdminCategory,
  updateAdminCategory,
  deleteAdminCategory,
  loadCategoryNameMap,
  invalidateCategoryNameCache,
};
