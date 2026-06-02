const { getDb } = require('../config/db');
const { requireFields, createHttpError } = require('../utils/http');
const { resolveStoredImage, logoFieldsFromBody } = require('../utils/images');

const COMMERCE_TYPES = new Set(['restaurant', 'boutique']);

const MODERATION = {
  EN_ATTENTE: 'en_attente',
  ACTIVE: 'active',
  SUSPENDUE: 'suspendue',
};

function initialModerationStatus() {
  const v = (process.env.ENTERPRISE_AUTO_APPROVE || '').trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') {
    return MODERATION.ACTIVE;
  }
  return MODERATION.EN_ATTENTE;
}

function mapRestaurant(r, categorieNom) {
  return {
    id: r.id,
    nom: r.nom,
    type: 'restaurant',
    description: r.description,
    telephone: r.telephone,
    adresse: r.adresse_ligne1,
    adresse_quartier: r.adresse_quartier ?? null,
    adresse_ville: r.adresse_ville ?? null,
    adresse_pays: r.adresse_pays ?? null,
    latitude: r.latitude,
    longitude: r.longitude,
    statut_moderation: r.statut,
    ouvert: r.est_ouvert,
    proprietaire_id: r.proprietaire_id,
    categorie_id: r.categorie_id,
    categorie_nom: categorieNom ?? null,
    image_url: r.logo_url ?? null,
    delai_preparation_min: r.delai_preparation_min ?? 20,
      livraison_propre: false,
    frais_livraison: Number(r.frais_livraison ?? 1000),
    note_moyenne: r.note_moyenne != null ? Number(r.note_moyenne) : 0,
    nb_avis: r.nb_avis != null ? Number(r.nb_avis) : 0,
  };
}

function mapBoutique(b, categorieNom) {
  return {
    id: b.id,
    nom: b.nom,
    type: 'boutique',
    description: b.description,
    telephone: b.telephone,
    adresse: b.adresse_ligne1,
    adresse_quartier: b.adresse_quartier ?? null,
    adresse_ville: b.adresse_ville ?? null,
    adresse_pays: b.adresse_pays ?? null,
    latitude: b.latitude,
    longitude: b.longitude,
    statut_moderation: b.statut,
    ouvert: b.est_ouvert,
    proprietaire_id: b.proprietaire_id,
    categorie_id: b.categorie_id,
    categorie_nom: categorieNom ?? null,
    image_url: b.logo_url ?? null,
    delai_livraison_min: b.delai_livraison_min ?? 30,
    livraison_propre: false,
    frais_livraison: Number(b.frais_livraison ?? 1000),
    note_moyenne: b.note_moyenne != null ? Number(b.note_moyenne) : 0,
    nb_avis: b.nb_avis != null ? Number(b.nb_avis) : 0,
  };
}

async function loadCategoryName(db, type, categorieId) {
  if (!categorieId) return null;
  const table = type === 'restaurant' ? 'categories_restaurants' : 'categories_boutiques';
  const { data } = await db.from(table).select('nom').eq('id', categorieId).maybeSingle();
  return data?.nom ?? null;
}

async function loadCategoryNamesMap(db, type, categorieIds) {
  const unique = [...new Set((categorieIds || []).filter(Boolean))];
  if (unique.length === 0) return new Map();
  const table = type === 'restaurant' ? 'categories_restaurants' : 'categories_boutiques';
  const { data, error } = await db.from(table).select('id, nom').in('id', unique);
  if (error) throw error;
  return new Map((data || []).map((c) => [c.id, c.nom]));
}

function canBypassModerationCheck(req, row) {
  if (!req.auth || !row) return false;
  if (req.auth.role === 'admin') return true;
  if (row.proprietaire_id && row.proprietaire_id === req.auth.userId) return true;
  return false;
}

function isPubliclyVisible(row) {
  return row && row.statut === MODERATION.ACTIVE && row.est_ouvert === true;
}

async function listEnterprises(req, res, next) {
  try {
    const { type, categorie_id: categorieId } = req.query;
    const db = getDb();
    const out = [];

    if (!type || type === 'restaurant') {
      let q = db
        .from('restaurants')
        .select('*')
        .eq('est_ouvert', true)
        .eq('statut', MODERATION.ACTIVE)
        .order('nom', { ascending: true });
      if (categorieId) q = q.eq('categorie_id', categorieId);
      const { data, error } = await q;
      if (error) throw error;
      const catMap = await loadCategoryNamesMap(
        db,
        'restaurant',
        (data || []).map((r) => r.categorie_id)
      );
      (data || []).forEach((r) => out.push(mapRestaurant(r, catMap.get(r.categorie_id) ?? null)));
    }

    if (!type || type === 'boutique') {
      let q = db
        .from('boutiques')
        .select('*')
        .eq('est_ouvert', true)
        .eq('statut', MODERATION.ACTIVE)
        .order('nom', { ascending: true });
      if (categorieId) q = q.eq('categorie_id', categorieId);
      const { data, error } = await q;
      if (error) throw error;
      const catMap = await loadCategoryNamesMap(
        db,
        'boutique',
        (data || []).map((b) => b.categorie_id)
      );
      (data || []).forEach((b) => out.push(mapBoutique(b, catMap.get(b.categorie_id) ?? null)));
    }

    out.sort((a, b) => String(a.nom || '').localeCompare(String(b.nom || '')));
    return res.json(out);
  } catch (error) {
    return next(error);
  }
}

async function listCategories(req, res, next) {
  try {
    const { type } = req.params;
    if (!COMMERCE_TYPES.has(type)) {
      throw createHttpError(400, 'Type invalide (restaurant ou boutique).');
    }
    const db = getDb();
    const table = type === 'restaurant' ? 'categories_restaurants' : 'categories_boutiques';
    const { data, error } = await db
      .from(table)
      .select('id, nom, description, ordre')
      .eq('est_active', true)
      .order('ordre', { ascending: true });
    if (error) throw error;
    return res.json(data || []);
  } catch (error) {
    return next(error);
  }
}

async function resolveCategoryId(db, type, categorieId) {
  if (!categorieId) {
    throw createHttpError(400, 'La catégorie est obligatoire.');
  }
  const table = type === 'restaurant' ? 'categories_restaurants' : 'categories_boutiques';
  const { data, error } = await db.from(table).select('id').eq('id', categorieId).eq('est_active', true).maybeSingle();
  if (error) throw error;
  if (!data) throw createHttpError(400, 'Catégorie invalide ou inactive.');
  return data.id;
}

async function getMyEnterprises(req, res, next) {
  try {
    const db = getDb();
    const [rRes, bRes] = await Promise.all([
      db.from('restaurants').select('*').eq('proprietaire_id', req.auth.userId).order('nom', { ascending: true }),
      db.from('boutiques').select('*').eq('proprietaire_id', req.auth.userId).order('nom', { ascending: true }),
    ]);
    if (rRes.error) throw rRes.error;
    if (bRes.error) throw bRes.error;
    const out = [];
    for (const r of rRes.data || []) {
      const cat = await loadCategoryName(db, 'restaurant', r.categorie_id);
      out.push(mapRestaurant(r, cat));
    }
    for (const b of bRes.data || []) {
      const cat = await loadCategoryName(db, 'boutique', b.categorie_id);
      out.push(mapBoutique(b, cat));
    }
    out.sort((a, b) => String(a.nom || '').localeCompare(String(b.nom || '')));
    return res.json(out);
  } catch (error) {
    return next(error);
  }
}

async function createEnterprise(req, res, next) {
  try {
    const { type, description, latitude, longitude, categorieId } = req.body;
    requireFields(req.body, ['type', 'categorieId']);

    if (!COMMERCE_TYPES.has(type)) {
      throw createHttpError(400, 'Type de commerce invalide (restaurant ou boutique).');
    }

    if (type === 'restaurant' && req.auth.role !== 'restaurateur' && req.auth.role !== 'admin') {
      throw createHttpError(403, 'Seuls les comptes restaurateur peuvent créer un restaurant.');
    }
    if (type === 'boutique' && req.auth.role !== 'commercant' && req.auth.role !== 'admin') {
      throw createHttpError(403, 'Seuls les comptes commerçant peuvent créer une boutique.');
    }

    const validators = require('../lib/validators');
    const nomClean = validators.requireValid(req.body.nom, validators.validateCommerceName, 'nom');
    const telephoneClean = validators.requireValid(req.body.telephone, validators.validatePhoneCg, 'telephone');
    // Adresse : OBLIGATOIRE pour un restaurant (livraison sur place), OPTIONNELLE pour une boutique (e-commerce).
    // On isole la branche boutique pour ne JAMAIS déclencher validateAddress (qui throw) sur une boutique.
    let adresseClean = '';
    if (type === 'restaurant') {
      adresseClean = validators.requireValid(
        req.body.adresse,
        (v) => validators.validateAddress(v, true),
        'adresse',
      );
    } else {
      adresseClean = validators.sanitizeText(req.body.adresse || '');
    }
    const descriptionClean = description
      ? validators.requireValid(description, (v) => validators.validateDescription(v, 500), 'description')
      : null;

    const statut = initialModerationStatus();

    const db = getDb();
    const resolvedCategoryId = await resolveCategoryId(db, type, categorieId);
    const logoFields = logoFieldsFromBody(req.body);

    const base = {
      proprietaire_id: req.auth.userId,
      categorie_id: resolvedCategoryId,
      nom: nomClean,
      description: descriptionClean,
      telephone: telephoneClean,
      adresse_ligne1: adresseClean,
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      statut,
      est_ouvert: statut === MODERATION.ACTIVE,
      livraison_propre: false,
      ...logoFields,
    };

    if (type === 'restaurant') {
      const { data, error } = await db.from('restaurants').insert(base).select('*').single();
      if (error) throw error;
      if (statut === MODERATION.EN_ATTENTE) {
        const { notifyEnterprisePendingModeration } = require('../services/admin-notify.service');
        await notifyEnterprisePendingModeration(db, { type: 'restaurant', nom, enterpriseId: data.id }).catch(
          () => undefined,
        );
      }
      return res.status(201).json(mapRestaurant(data));
    }

    const { data, error } = await db.from('boutiques').insert(base).select('*').single();
    if (error) throw error;
    if (statut === MODERATION.EN_ATTENTE) {
      const { notifyEnterprisePendingModeration } = require('../services/admin-notify.service');
      await notifyEnterprisePendingModeration(db, { type: 'boutique', nom, enterpriseId: data.id }).catch(
        () => undefined,
      );
    }
    return res.status(201).json(mapBoutique(data));
  } catch (error) {
    return next(error);
  }
}

async function getEnterpriseById(req, res, next) {
  try {
    const { enterpriseId } = req.params;
    const db = getDb();

    const { data: resto, error: rErr } = await db.from('restaurants').select('*').eq('id', enterpriseId).maybeSingle();
    if (rErr) throw rErr;
    if (resto) {
      const cat = await loadCategoryName(db, 'restaurant', resto.categorie_id);
      const mapped = mapRestaurant(resto, cat);
      if (isPubliclyVisible(resto) || canBypassModerationCheck(req, resto)) {
        return res.json(mapped);
      }
      throw createHttpError(404, 'Commerce introuvable ou fermé.');
    }

    const { data: bout, error: bErr } = await db.from('boutiques').select('*').eq('id', enterpriseId).maybeSingle();
    if (bErr) throw bErr;
    if (bout) {
      const cat = await loadCategoryName(db, 'boutique', bout.categorie_id);
      const mapped = mapBoutique(bout, cat);
      if (isPubliclyVisible(bout) || canBypassModerationCheck(req, bout)) {
        return res.json(mapped);
      }
      throw createHttpError(404, 'Commerce introuvable ou fermé.');
    }

    throw createHttpError(404, 'Commerce introuvable ou fermé.');
  } catch (error) {
    return next(error);
  }
}

/** Mise à jour profil commerce (propriétaire). */
async function patchEnterprise(req, res, next) {
  try {
    const { enterpriseId } = req.params;
    const body = req.body || {};
    const db = getDb();

    const applyPatch = async (table, row) => {
      if (row.proprietaire_id !== req.auth.userId && req.auth.role !== 'admin') {
        throw createHttpError(403, 'Action non autorisée.');
      }
      const validators = require('../lib/validators');
      const updates = { updated_at: new Date().toISOString() };
      if (body.nom !== undefined) {
        const n = validators.requireValid(body.nom, validators.validateCommerceName, 'nom');
        updates.nom = n;
      }
      if (body.description !== undefined) {
        if (body.description === null || body.description === '') {
          updates.description = null;
        } else {
          updates.description = validators.requireValid(body.description, (v) => validators.validateDescription(v, 500), 'description');
        }
      }
      if (body.telephone !== undefined) {
        const t = validators.requireValid(body.telephone, validators.validatePhoneCg, 'telephone');
        updates.telephone = t;
      }
      if (body.adresse !== undefined || body.adresseQuartier !== undefined) {
        const ligne1 =
          body.adresse !== undefined ? String(body.adresse || '') : String(row.adresse_ligne1 || '');
        const quartier =
          body.adresseQuartier !== undefined
            ? String(body.adresseQuartier || '')
            : String(row.adresse_quartier || '');
        const ligne1Clean = validators.sanitizeText(ligne1);
        const quartierClean = validators.sanitizeText(quartier);
        if (!quartierClean) {
          throw createHttpError(400, 'Le quartier (arrondissement) est obligatoire.');
        }
        if (ligne1Clean.length < 5) {
          throw createHttpError(400, 'Adresse détaillée trop courte (minimum 5 caractères).');
        }
        if (/^[0-9\s]+$/.test(ligne1Clean)) {
          throw createHttpError(400, 'Adresse invalide (pas uniquement des chiffres).');
        }
        updates.adresse_ligne1 = ligne1Clean;
        updates.adresse_quartier = quartierClean;
        updates.latitude = null;
        updates.longitude = null;
      }
      if (body.adresseVille !== undefined) {
        updates.adresse_ville = String(body.adresseVille || '').trim() || 'Brazzaville';
      }
      if (body.latitude !== undefined) {
        updates.latitude = body.latitude == null || body.latitude === '' ? null : Number(body.latitude);
      }
      if (body.longitude !== undefined) {
        updates.longitude = body.longitude == null || body.longitude === '' ? null : Number(body.longitude);
      }
      if (body.livraisonPropre !== undefined) {
        throw createHttpError(400, 'Les livraisons passent exclusivement par les livreurs GoLivra.');
      }
      if (body.imageUrl !== undefined || body.imageDataUrl !== undefined) {
        const logoFields = logoFieldsFromBody(body);
        if (Object.keys(logoFields).length > 0) {
          Object.assign(updates, logoFields);
        }
      }

      if (Object.keys(updates).length <= 1) {
        throw createHttpError(400, 'Aucune modification à enregistrer.');
      }

      const { data, error } = await db.from(table).update(updates).eq('id', enterpriseId).select('*').single();
      if (error) throw error;
      return data;
    };

    const { data: resto } = await db.from('restaurants').select('*').eq('id', enterpriseId).maybeSingle();
    if (resto) {
      const data = await applyPatch('restaurants', resto);
      const cat = await loadCategoryName(db, 'restaurant', data.categorie_id);
      return res.json(mapRestaurant(data, cat));
    }

    const { data: bout } = await db.from('boutiques').select('*').eq('id', enterpriseId).maybeSingle();
    if (bout) {
      const data = await applyPatch('boutiques', bout);
      const cat = await loadCategoryName(db, 'boutique', data.categorie_id);
      return res.json(mapBoutique(data, cat));
    }

    throw createHttpError(404, 'Commerce introuvable.');
  } catch (error) {
    return next(error);
  }
}

/** Désactivé : toutes les livraisons passent par GoLivra. */
async function patchEnterpriseSettings(_req, res, next) {
  try {
    throw createHttpError(
      400,
      'Les livraisons sont assurées uniquement par les livreurs GoLivra (pas de livraison propre ni externe côté commerce).',
    );
  } catch (error) {
    return next(error);
  }
}

/** Statistiques détaillées (CA + engagement) pour le commerce du vendeur authentifié. */
async function getMyEnterpriseStats(req, res, next) {
  try {
    const { enterpriseId } = req.params;
    const db = getDb();

    const { data: resto } = await db.from('restaurants').select('id, proprietaire_id, nom').eq('id', enterpriseId).maybeSingle();
    const { data: bout } = !resto
      ? await db.from('boutiques').select('id, proprietaire_id, nom').eq('id', enterpriseId).maybeSingle()
      : { data: null };

    const row = resto || bout;
    if (!row) throw createHttpError(404, 'Commerce introuvable.');
    if (row.proprietaire_id !== req.auth.userId && req.auth.role !== 'admin') {
      throw createHttpError(403, 'Action non autorisée.');
    }

    const kind = resto ? 'restaurant' : 'boutique';
    const { getCommerceStatsForEnterprise } = require('../services/admin-commerce-stats.service');
    const stats = await getCommerceStatsForEnterprise(db, enterpriseId, kind);
    return res.json({ enterprise_id: enterpriseId, nom: row.nom, type: kind, ...stats });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listEnterprises,
  listCategories,
  getEnterpriseById,
  createEnterprise,
  getMyEnterprises,
  patchEnterprise,
  patchEnterpriseSettings,
  getMyEnterpriseStats,
};
