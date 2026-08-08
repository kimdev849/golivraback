const { getDb } = require('../config/db');
const { requireFields, createHttpError } = require('../utils/http');
const { getUserScores, personalizeResults } = require('../services/personalization.service');
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
    pays_id: r.pays_id || null,
    ville_id: r.ville_id || null,
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
    cree_le: r.created_at ?? null,
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
    pays_id: b.pays_id || null,
    ville_id: b.ville_id || null,
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
    cree_le: b.created_at ?? null,
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
    const { type, categorie_id: categorieId, ville_id: villeId } = req.query;
    if (type && !COMMERCE_TYPES.has(type)) {
      throw createHttpError(400, `Type de commerce invalide: ${type}`);
    }

    const db = getDb();
    let out = [];

    if (!type || type === 'restaurant') {
      let q = db
        .from('restaurants')
        .select('*')
        .eq('est_ouvert', true)
        .eq('statut', MODERATION.ACTIVE)
        .order('nom', { ascending: true });
      if (categorieId) q = q.eq('categorie_id', categorieId);
      if (villeId) q = q.eq('ville_id', villeId);
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
      if (villeId) q = q.eq('ville_id', villeId);
      const { data, error } = await q;
      if (error) throw error;
      const catMap = await loadCategoryNamesMap(
        db,
        'boutique',
        (data || []).map((b) => b.categorie_id)
      );
      (data || []).forEach((b) => out.push(mapBoutique(b, catMap.get(b.categorie_id) ?? null)));
    }

    // --- Personnalisation Algorithmique ---
    const userId = req.auth?.userId;
    if (userId) {
      const scores = await getUserScores(userId);
      out = personalizeResults(out, scores, { rotationStrength: 0.2 });
    } else {
      // Mélange aléatoire par défaut
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
    }

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
        await notifyEnterprisePendingModeration(db, { type: 'restaurant', nom: nomClean, enterpriseId: data.id }).catch(
          () => undefined,
        );
      }
      return res.status(201).json(mapRestaurant(data));
    }

    const { data, error } = await db.from('boutiques').insert(base).select('*').single();
    if (error) throw error;
    if (statut === MODERATION.EN_ATTENTE) {
      const { notifyEnterprisePendingModeration } = require('../services/admin-notify.service');
      await notifyEnterprisePendingModeration(db, { type: 'boutique', nom: nomClean, enterpriseId: data.id }).catch(
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
        await attachHorairesInfo(db, mapped, { kind: 'restaurant', id: resto.id });
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
        await attachHorairesInfo(db, mapped, { kind: 'boutique', id: bout.id });
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
        // Adresse : OBLIGATOIRE pour un restaurant (livraison sur place), OPTIONNELLE pour une boutique (e-commerce).
        // Une boutique sans adresse peut enregistrer sa fiche (nom, description, téléphone) sans bloquer.
        const isRestaurant = table === 'restaurants';
        if (isRestaurant) {
          if (!quartierClean) {
            throw createHttpError(400, 'Le quartier (arrondissement) est obligatoire.');
          }
          if (ligne1Clean.length < 5) {
            throw createHttpError(400, 'Adresse détaillée trop courte (minimum 5 caractères).');
          }
          if (/^[0-9\s]+$/.test(ligne1Clean)) {
            throw createHttpError(400, 'Adresse invalide (pas uniquement des chiffres).');
          }
        } else if (ligne1Clean.length > 0 || quartierClean.length > 0) {
          // Boutique : si une adresse est renseignée, elle doit être exploitable, sinon on la laisse vide.
          if (ligne1Clean && ligne1Clean.length < 5) {
            throw createHttpError(400, 'Adresse détaillée trop courte (minimum 5 caractères).');
          }
          if (ligne1Clean && /^[0-9\s]+$/.test(ligne1Clean)) {
            throw createHttpError(400, 'Adresse invalide (pas uniquement des chiffres).');
          }
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
      // Temps de préparation (géré par le commerce) : restaurant →
      // delai_preparation_min, boutique → delai_livraison_min (le délai
      // boutique sert de temps de préparation du colis). Borné 5–180 min.
      // Accepte les deux conventions de nommage : `delaiPreparationMin`
      // (app mobile actuelle) et les variantes snake_case du nom de colonne
      // (rétrocompatibilité avec les anciennes versions de client).
      // La variante camelCase, si présente, a priorité.
      let prepRaw = body.delaiPreparationMin;
      if (prepRaw === undefined) {
        prepRaw = table === 'restaurants' ? body.delai_preparation_min : body.delai_livraison_min;
      }
      if (prepRaw !== undefined) {
        const v = Number(prepRaw);
        if (!Number.isInteger(v) || v < 5 || v > 180) {
          throw createHttpError(400, 'Temps de préparation invalide (5 à 180 minutes).');
        }
        updates[table === 'restaurants' ? 'delai_preparation_min' : 'delai_livraison_min'] = v;
      }

      // Un seul champ métier suffit (ex. temps de préparation) : on n'exige
      // pas de multi-champs. On rejette seulement un PATCH totalement vide
      // (rien d'autre que updated_at).
      const meaningfulKeys = Object.keys(updates).filter((k) => k !== 'updated_at');
      if (meaningfulKeys.length === 0) {
        throw createHttpError(
          400,
          'Aucune modification à enregistrer (aucun champ reconnu dans la requête).',
        );
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
/** Enrichit la fiche publique d'un commerce avec ses horaires + statut d'ouverture. */
async function attachHorairesInfo(db, mapped, { kind, id }) {
  const { getEtablissementOuvertureInfo } = require('../services/horaires.service');
  const prepMinutes =
    kind === 'restaurant'
      ? Number(mapped.delai_preparation_min ?? 20)
      : Number(mapped.delai_livraison_min ?? 30);
  const info = await getEtablissementOuvertureInfo(db, { kind, id, prepMinutes });
  mapped.horaires = info.horaires;
  mapped.est_ouvert_maintenant = info.ouvert;
  mapped.peut_commander_maintenant = info.peut_commander;
  mapped.accepte_commandes = info.accepte_commandes;
  mapped.fermeture_plage = info.fermeture;
  mapped.derniere_commande = info.derniere_commande;
  mapped.message_fermeture = info.message_fermeture;
  mapped.message_commande = info.message_commande;
  mapped.prochaine_ouverture = info.prochaine_ouverture;
}

/** Trouve un établissement (resto ou boutique) et vérifie la propriété. */
async function findOwnedEstablishment(db, enterpriseId, userId, allowAdmin) {
  const { data: resto } = await db.from('restaurants').select('id, proprietaire_id').eq('id', enterpriseId).maybeSingle();
  if (resto) {
    if (resto.proprietaire_id !== userId && !allowAdmin) throw createHttpError(403, 'Action non autorisée.');
    return { kind: 'restaurant', id: resto.id };
  }
  const { data: bout } = await db.from('boutiques').select('id, proprietaire_id').eq('id', enterpriseId).maybeSingle();
  if (bout) {
    if (bout.proprietaire_id !== userId && !allowAdmin) throw createHttpError(403, 'Action non autorisée.');
    return { kind: 'boutique', id: bout.id };
  }
  throw createHttpError(404, 'Commerce introuvable.');
}

/** GET /api/enterprises/:id/horaires — horaires du commerce (propriétaire/admin). */
async function getEnterpriseHoraires(req, res, next) {
  try {
    const db = getDb();
    const { kind, id } = await findOwnedEstablishment(
      db,
      req.params.enterpriseId,
      req.auth.userId,
      req.auth.role === 'admin',
    );
    const { getEtablissementHoraires } = require('../services/horaires.service');
    const horaires = await getEtablissementHoraires(db, { kind, id });
    return res.json({ enterprise_id: id, type: kind, horaires });
  } catch (error) {
    return next(error);
  }
}

function normalizeTimeValue(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`;
}

/** PUT /api/enterprises/:id/horaires — remplace les horaires (propriétaire/admin). */
async function putEnterpriseHoraires(req, res, next) {
  try {
    const db = getDb();
    const { kind, id } = await findOwnedEstablishment(
      db,
      req.params.enterpriseId,
      req.auth.userId,
      req.auth.role === 'admin',
    );
    const raw = Array.isArray(req.body?.horaires) ? req.body.horaires : [];

    const rows = [];
    for (const item of raw) {
      const jour = Number(item?.jour);
      if (!Number.isInteger(jour) || jour < 0 || jour > 6) {
        throw createHttpError(400, 'Jour invalide (0=Dimanche … 6=Samedi).');
      }
      const ouverture = normalizeTimeValue(item?.ouverture);
      const fermeture = normalizeTimeValue(item?.fermeture);
      if (!ouverture || !fermeture) {
        throw createHttpError(400, 'Horaires invalides : indiquez ouverture et fermeture (HH:MM).');
      }
      rows.push({ jour, ouverture, fermeture });
    }
    if (rows.length > 60) {
      throw createHttpError(400, 'Trop de plages horaires (maximum 60).');
    }

    const table = 'horaires_etablissements';
    const col = kind === 'boutique' ? 'boutique_id' : 'restaurant_id';

    // Remplacement complet : on efface puis on réinsère (transaction best-effort).
    const { error: delErr } = await db.from(table).delete().eq(col, id);
    if (delErr) throw delErr;

    const inserted = [];
    for (const row of rows) {
      const { data, error } = await db
        .from(table)
        .insert({ [col]: id, jour: row.jour, ouverture: row.ouverture, fermeture: row.fermeture })
        .select('id, jour, ouverture, fermeture')
        .maybeSingle();
      if (error) throw error;
      inserted.push(data);
    }

    const { getEtablissementOuvertureInfo } = require('../services/horaires.service');
    const info = await getEtablissementOuvertureInfo(db, { kind, id });
    return res.json({ enterprise_id: id, type: kind, horaires: inserted, ...info });
  } catch (error) {
    return next(error);
  }
}

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
  getEnterpriseHoraires,
  putEnterpriseHoraires,
  getMyEnterpriseStats,
  // Helpers réutilisables (atomicité register-vendor)
  initialModerationStatus,
  resolveCategoryId,
  logoFieldsFromBody,
  MODERATION,
};
