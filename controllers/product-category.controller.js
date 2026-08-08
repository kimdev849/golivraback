const { getDb } = require('../config/db');
const { createHttpError, requireFields } = require('../utils/http');

// Les catégories de produits / menus sont GLOBALES et gérées par GoLivra :
//   • categories_produits → produits des boutiques
//   • categories_menus    → plats des restaurants
// Le vendeur choisit dans ce référentiel — il ne crée plus de catégorie.

const CATEGORY_TABLES = {
  produits: 'categories_produits',
  menus: 'categories_menus',
};

function categoryTableFor(kind) {
  if (kind === 'restaurant') return CATEGORY_TABLES.menus;
  if (kind === 'boutique') return CATEGORY_TABLES.produits;
  return null;
}

async function resolveEstablishment(db, enterpriseId) {
  const { data: r } = await db.from('restaurants').select('id, proprietaire_id, statut').eq('id', enterpriseId).maybeSingle();
  if (r) return { kind: 'restaurant', row: r };
  const { data: b } = await db.from('boutiques').select('id, proprietaire_id, statut').eq('id', enterpriseId).maybeSingle();
  if (b) return { kind: 'boutique', row: b };
  return null;
}

async function fetchGlobalCategories(db, table) {
  const { data, error } = await db
    .from(table)
    .select('id, nom, description, image_url, ordre, est_active')
    .eq('est_active', true)
    .order('ordre', { ascending: true })
    .order('nom', { ascending: true });
  if (error) throw error;
  return data || [];
}

/**
 * GET /api/products/categories?type=produits|menus
 * Liste globale publique des catégories actives (client + vendeur).
 */
async function listGlobalCategories(req, res, next) {
  try {
    const type = String(req.query.type || 'produits').toLowerCase();
    const table = CATEGORY_TABLES[type];
    if (!table) throw createHttpError(400, 'Type de catégories invalide (produits | menus).');
    const db = getDb();
    return res.json(await fetchGlobalCategories(db, table));
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
    return res.json(await fetchGlobalCategories(db, table));
  } catch (error) {
    return next(error);
  }
}

/* ──────────────────────────────────────────────────────────────
 * Administration GoLivra — CRUD des catégories globales
 * ────────────────────────────────────────────────────────────── */

/** GET /api/admin/categories?type=produits|menus — toutes (actives et inactives). */
async function listAdminCategories(req, res, next) {
  try {
    const type = String(req.query.type || 'produits').toLowerCase();
    const table = CATEGORY_TABLES[type];
    if (!table) throw createHttpError(400, 'Type de catégories invalide (produits | menus).');
    const db = getDb();
    const { data, error } = await db
      .from(table)
      .select('id, nom, description, image_url, ordre, est_active, created_at')
      .order('ordre', { ascending: true })
      .order('nom', { ascending: true });
    if (error) throw error;
    return res.json(data || []);
  } catch (error) {
    return next(error);
  }
}

/** POST /api/admin/categories — créer une catégorie globale. */
async function createAdminCategory(req, res, next) {
  try {
    const type = String(req.body.type || 'produits').toLowerCase();
    const table = CATEGORY_TABLES[type];
    if (!table) throw createHttpError(400, 'Type de catégories invalide (produits | menus).');
    requireFields(req.body, ['nom']);
    const { nom, description, image_url, ordre, est_active } = req.body;
    const db = getDb();
    const { data, error } = await db
      .from(table)
      .insert({
        nom: String(nom).trim(),
        description: description ? String(description).trim() : null,
        image_url: image_url || null,
        ordre: Number.isFinite(Number(ordre)) ? Number(ordre) : 0,
        est_active: est_active !== undefined ? Boolean(est_active) : true,
      })
      .select('id, nom, description, image_url, ordre, est_active, created_at')
      .single();
    if (error) throw error;
    return res.status(201).json(data);
  } catch (error) {
    return next(error);
  }
}

/** PATCH /api/admin/categories/:categoryId — modifier une catégorie globale. */
async function updateAdminCategory(req, res, next) {
  try {
    const type = String(req.body.type || 'produits').toLowerCase();
    const table = CATEGORY_TABLES[type];
    if (!table) throw createHttpError(400, 'Type de catégories invalide (produits | menus).');
    const { categoryId } = req.params;
    const { nom, description, image_url, ordre, est_active } = req.body;
    const db = getDb();
    const patch = {};
    if (nom !== undefined) patch.nom = String(nom).trim();
    if (description !== undefined) patch.description = description ? String(description).trim() : null;
    if (image_url !== undefined) patch.image_url = image_url || null;
    if (ordre !== undefined) patch.ordre = Number.isFinite(Number(ordre)) ? Number(ordre) : 0;
    if (est_active !== undefined) patch.est_active = Boolean(est_active);
    const { data, error } = await db.from(table).update(patch).eq('id', categoryId).select('id, nom, description, image_url, ordre, est_active, created_at').single();
    if (error) throw error;
    return res.json(data);
  } catch (error) {
    return next(error);
  }
}

/** DELETE /api/admin/categories/:categoryId — supprimer une catégorie globale. */
async function deleteAdminCategory(req, res, next) {
  try {
    const type = String(req.body.type || req.query.type || 'produits').toLowerCase();
    const table = CATEGORY_TABLES[type];
    if (!table) throw createHttpError(400, 'Type de catégories invalide (produits | menus).');
    const { categoryId } = req.params;
    const db = getDb();
    const { error } = await db.from(table).delete().eq('id', categoryId);
    if (error) throw error;
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
}

/** Charge un Map<categoryId, nom> depuis les deux référentiels globaux. */
async function loadCategoryNameMap(db) {
  const map = new Map();
  for (const table of Object.values(CATEGORY_TABLES)) {
    const { data, error } = await db.from(table).select('id, nom');
    if (error) continue;
    for (const c of data || []) map.set(c.id, c.nom);
  }
  return map;
}

module.exports = {
  listGlobalCategories,
  listProductCategories,
  listAdminCategories,
  createAdminCategory,
  updateAdminCategory,
  deleteAdminCategory,
  loadCategoryNameMap,
};
