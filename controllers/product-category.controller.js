const { getDb } = require('../config/db');
const { createHttpError, requireFields } = require('../utils/http');

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

async function listProductCategories(req, res, next) {
  try {
    const { enterpriseId } = req.params;
    const db = getDb();
    const resolved = await resolveEstablishment(db, enterpriseId);
    if (!resolved) throw createHttpError(404, 'Établissement introuvable');

    const { kind } = resolved;
    const table = kind === 'restaurant' ? 'categories_plats' : 'categories_articles';
    const fk = kind === 'restaurant' ? 'restaurant_id' : 'boutique_id';

    const { data, error } = await db
      .from(table)
      .select('id, nom, description, ordre, est_active')
      .eq(fk, enterpriseId)
      .eq('est_active', true)
      .order('ordre', { ascending: true })
      .order('nom', { ascending: true });
    if (error) throw error;
    return res.json(data || []);
  } catch (error) {
    return next(error);
  }
}

async function createProductCategory(req, res, next) {
  try {
    const { enterpriseId } = req.params;
    requireFields(req.body, ['nom']);
    const { nom, description } = req.body;
    const db = getDb();
    const resolved = await resolveEstablishment(db, enterpriseId);
    if (!resolved) throw createHttpError(404, 'Établissement introuvable');

    const { kind, row } = resolved;
    if (!canManageEstablishment(req, row)) {
      throw createHttpError(403, 'Action non autorisée pour cet établissement.');
    }

    if (kind === 'restaurant') {
      if (req.auth.role !== 'admin' && req.auth.role !== 'restaurateur') {
        throw createHttpError(403, 'Seul un restaurateur peut créer des catégories de menu.');
      }
      const { data, error } = await db
        .from('categories_plats')
        .insert({
          restaurant_id: enterpriseId,
          nom: String(nom).trim(),
          description: description ? String(description).trim() : null,
          est_active: true,
        })
        .select('id, nom, description, ordre, est_active')
        .single();
      if (error) throw error;
      return res.status(201).json(data);
    }

    if (req.auth.role !== 'admin' && req.auth.role !== 'commercant') {
      throw createHttpError(403, 'Seul un commerçant peut créer des catégories.');
    }
    const { data, error } = await db
      .from('categories_articles')
      .insert({
        boutique_id: enterpriseId,
        nom: String(nom).trim(),
        description: description ? String(description).trim() : null,
        est_active: true,
      })
      .select('id, nom, description, ordre, est_active')
      .single();
    if (error) throw error;
    return res.status(201).json(data);
  } catch (error) {
    return next(error);
  }
}

module.exports = { listProductCategories, createProductCategory };
