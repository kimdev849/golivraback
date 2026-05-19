const bcrypt = require('bcryptjs');
const { createHttpError } = require('../utils/http');
const { normalizeCgE164 } = require('../utils/phone');
const { revokeUserSessions } = require('./session.service');

const VEHICLE_TYPES = new Set(['moto', 'voiture', 'velo', 'pied']);

const DELAY_ASSIGN_MINUTES = Number(process.env.LOGISTICS_DELAY_ASSIGN_MINUTES) || 20;
const DELAY_DELIVERY_MINUTES = Number(process.env.LOGISTICS_DELAY_DELIVERY_MINUTES) || 45;

function minutesSince(iso) {
  if (!iso) return 0;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 60000));
}

function startOfTodayIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function classifyDeliveryDelay(liv) {
  const now = Date.now();
  const createdAt = liv.created_at ? new Date(liv.created_at).getTime() : now;
  const assignedAt = liv.attribuee_at ? new Date(liv.attribuee_at).getTime() : null;

  if (liv.statut === 'livree' || liv.statut === 'annulee') {
    return { en_retard: false, type_retard: null, minutes_retard: 0 };
  }

  if (!liv.livreur_id) {
    const waitMin = Math.floor((now - createdAt) / 60000);
    if (waitMin >= DELAY_ASSIGN_MINUTES) {
      return {
        en_retard: true,
        type_retard: 'assignation',
        minutes_retard: waitMin - DELAY_ASSIGN_MINUTES,
      };
    }
    return { en_retard: false, type_retard: null, minutes_retard: 0 };
  }

  if (liv.statut === 'en_route' || liv.statut === 'en_cours') {
    const ref = assignedAt || createdAt;
    const routeMin = Math.floor((now - ref) / 60000);
    if (routeMin >= DELAY_DELIVERY_MINUTES) {
      return {
        en_retard: true,
        type_retard: 'livraison',
        minutes_retard: routeMin - DELAY_DELIVERY_MINUTES,
      };
    }
  }

  return { en_retard: false, type_retard: null, minutes_retard: 0 };
}

function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!email || !email.includes('@') || email.length > 255) return null;
  return email;
}

async function getRoleId(db, roleName) {
  const { data, error } = await db.from('roles').select('id').eq('nom', roleName).maybeSingle();
  if (error) throw error;
  if (!data) {
    throw createHttpError(
      503,
      `Rôle « ${roleName} » absent en base. Dans Supabase → SQL Editor : exécutez d'abord sql/amendments-v4-logistics-tenant.sql (étape 1), puis sql/amendments-v4-logistics-tenant-step2.sql (étape 2).`,
    );
  }
  return data.id;
}

async function createUserWithRole(db, { nom, roleName, email, telephone, motDePasse, estApprouve = true }) {
  if (typeof motDePasse !== 'string' || motDePasse.length < 6) {
    throw createHttpError(400, 'Mot de passe requis (6 caractères minimum).');
  }

  const roleId = await getRoleId(db, roleName);
  const hashedPassword = await bcrypt.hash(motDePasse, 10);
  const insert = {
    nom: nom.trim(),
    mot_de_passe_hash: hashedPassword,
    role_id: roleId,
    est_verifie: true,
    est_approuve: estApprouve,
    est_actif: true,
  };

  if (email) {
    const normalized = normalizeEmail(email);
    if (!normalized) throw createHttpError(400, 'Adresse e-mail invalide.');
    insert.email = normalized;
  }

  if (telephone) {
    const normalizedTel = normalizeCgE164(telephone);
    if (!normalizedTel) {
      throw createHttpError(400, 'Numéro de téléphone invalide. Indiquez +242 suivi de 9 chiffres (Congo).');
    }
    insert.telephone = normalizedTel;
  }

  const { data, error } = await db
    .from('utilisateurs')
    .insert(insert)
    .select('id, nom, telephone, email, role_id, est_approuve, est_actif, created_at')
    .single();

  if (error) {
    if (error.code === '23505') throw createHttpError(409, 'E-mail ou téléphone déjà enregistré.');
    throw error;
  }

  return data;
}

async function getCompanyById(db, companyId) {
  const { data, error } = await db
    .from('entreprises_logistiques')
    .select('*')
    .eq('id', companyId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getCompanyByGestionnaire(db, gestionnaireId) {
  const { data, error } = await db
    .from('entreprises_logistiques')
    .select('*')
    .eq('gestionnaire_id', gestionnaireId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function assertCompanyActive(company) {
  if (!company) throw createHttpError(404, 'Entreprise logistique introuvable.');
  if (company.statut !== 'active') {
    throw createHttpError(403, 'Cette entreprise logistique n\'est pas active.');
  }
}

async function assertCompanyAccess(db, { userId, role, companyId }) {
  const company = await getCompanyById(db, companyId);
  if (!company) throw createHttpError(404, 'Entreprise logistique introuvable.');
  if (role === 'admin') return company;
  if (role === 'gestionnaire_logistique' && company.gestionnaire_id === userId) return company;
  throw createHttpError(403, 'Accès refusé à cette entreprise logistique.');
}

async function createLogisticsCompanyWithManager(db, payload) {
  const {
    nomEntreprise,
    telephoneEntreprise,
    emailEntreprise,
    description,
    zoneActivite,
    commissionPct,
    adresseLigne1,
    adresseVille,
    gestionnaire,
    statut = 'active',
  } = payload;

  const { nom, email, motDePasse, telephone: telGestionnaire } = gestionnaire;
  const manager = await createUserWithRole(db, {
    nom,
    email,
    telephone: telGestionnaire || null,
    motDePasse,
    roleName: 'gestionnaire_logistique',
    estApprouve: true,
  });

  const { data: company, error } = await db
    .from('entreprises_logistiques')
    .insert({
      gestionnaire_id: manager.id,
      nom: nomEntreprise.trim(),
      telephone: telephoneEntreprise || null,
      email: emailEntreprise ? normalizeEmail(emailEntreprise) : null,
      description: description || null,
      zone_activite: zoneActivite || null,
      commission_pct: commissionPct != null ? Number(commissionPct) : 15,
      adresse_ligne1: adresseLigne1 || null,
      adresse_ville: adresseVille || 'Brazzaville',
      statut,
    })
    .select('*')
    .single();

  if (error) {
    await db.from('utilisateurs').delete().eq('id', manager.id);
    throw error;
  }

  return { company, gestionnaire: manager };
}

async function getLivreurInCompany(db, livreurId, companyId) {
  const { data: livreur, error } = await db
    .from('livreurs')
    .select('*')
    .eq('id', livreurId)
    .eq('entreprise_logistique_id', companyId)
    .maybeSingle();
  if (error) throw error;
  if (!livreur) throw createHttpError(404, 'Livreur introuvable pour cette entreprise.');

  const { data: utilisateur } = await db
    .from('utilisateurs')
    .select('id, nom, telephone, email, est_actif, est_approuve')
    .eq('id', livreur.utilisateur_id)
    .maybeSingle();

  return { ...livreur, utilisateur: utilisateur || null };
}

function mapCourierPublic(row) {
  const u = row.utilisateur || row.utilisateur_id;
  const user = typeof u === 'object' && u !== null ? u : null;
  return {
    id: row.id,
    type_vehicule: row.type_vehicule,
    est_disponible: row.est_disponible,
    est_approuve: row.est_approuve,
    nb_livraisons_total: row.nb_livraisons_total,
    nb_livraisons_reussies: row.nb_livraisons_reussies,
    plaque_immatriculation: row.plaque_immatriculation,
    created_at: row.created_at,
    utilisateur: user
      ? {
          id: user.id,
          nom: user.nom,
          telephone: user.telephone,
          email: user.email,
          est_actif: user.est_actif,
        }
      : null,
  };
}

async function listCouriersForCompany(db, companyId) {
  const { data: livreurs, error } = await db
    .from('livreurs')
    .select('id, type_vehicule, est_disponible, est_approuve, nb_livraisons_total, nb_livraisons_reussies, plaque_immatriculation, created_at, utilisateur_id')
    .eq('entreprise_logistique_id', companyId)
    .order('created_at', { ascending: false });
  if (error) throw error;

  const userIds = [...new Set((livreurs || []).map((l) => l.utilisateur_id))];
  const { data: users } = userIds.length
    ? await db.from('utilisateurs').select('id, nom, telephone, email, est_actif').in('id', userIds)
    : { data: [] };
  const userMap = new Map((users || []).map((u) => [u.id, u]));

  return (livreurs || []).map((l) =>
    mapCourierPublic({
      ...l,
      utilisateur: userMap.get(l.utilisateur_id) || null,
    }),
  );
}

async function createCourierForCompany(db, companyId, payload) {
  const { nom, telephone, motDePasse, typeVehicule, plaqueImmatriculation } = payload;

  const type = typeof typeVehicule === 'string' ? typeVehicule.trim().toLowerCase() : '';
  if (!VEHICLE_TYPES.has(type)) {
    throw createHttpError(400, 'Type de véhicule invalide (moto, voiture, velo, pied).');
  }

  const company = await getCompanyById(db, companyId);
  assertCompanyActive(company);

  const user = await createUserWithRole(db, {
    nom,
    telephone,
    motDePasse,
    roleName: 'livreur',
    estApprouve: true,
  });

  const { data: livreur, error } = await db
    .from('livreurs')
    .insert({
      utilisateur_id: user.id,
      entreprise_logistique_id: companyId,
      type_vehicule: type,
      plaque_immatriculation: plaqueImmatriculation || null,
      est_disponible: false,
      est_approuve: true,
    })
    .select('*')
    .single();

  if (error) {
    await db.from('utilisateurs').delete().eq('id', user.id);
    if (error.code === '23505') throw createHttpError(409, 'Ce compte a déjà un profil livreur.');
    throw error;
  }

  return mapCourierPublic({ ...livreur, utilisateur: user });
}

async function suspendCourier(db, livreurId, companyId) {
  const livreur = await getLivreurInCompany(db, livreurId, companyId);

  await db
    .from('utilisateurs')
    .update({ est_actif: false })
    .eq('id', livreur.utilisateur_id);

  await db
    .from('livreurs')
    .update({
      est_disponible: false,
      est_approuve: false,
      disponibilite_bloquee_entreprise: true,
    })
    .eq('id', livreurId);

  await revokeUserSessions(db, livreur.utilisateur_id);

  return getLivreurInCompany(db, livreurId, companyId);
}

async function activateCourier(db, livreurId, companyId) {
  const livreur = await getLivreurInCompany(db, livreurId, companyId);

  await db
    .from('utilisateurs')
    .update({ est_actif: true, est_approuve: true })
    .eq('id', livreur.utilisateur_id);

  await db.from('livreurs').update({ est_approuve: true }).eq('id', livreurId);

  return getLivreurInCompany(db, livreurId, companyId);
}

async function setCourierAvailability(db, livreurId, companyId, disponible) {
  const livreur = await getLivreurInCompany(db, livreurId, companyId);
  if (livreur.utilisateur?.est_actif === false) {
    throw createHttpError(400, 'Impossible de modifier la disponibilité d\'un compte suspendu.');
  }

  const patch = {
    est_disponible: Boolean(disponible),
    disponibilite_bloquee_entreprise: !disponible,
  };

  const { data, error } = await db
    .from('livreurs')
    .update(patch)
    .eq('id', livreurId)
    .eq('entreprise_logistique_id', companyId)
    .select('*')
    .single();
  if (error) throw error;

  return getLivreurInCompany(db, livreurId, companyId);
}

async function getCourierDetailForCompany(db, companyId, livreurId) {
  const livreur = await getLivreurInCompany(db, livreurId, companyId);
  const publicRow = mapCourierPublic(livreur);

  const { data: livraisons, error } = await db
    .from('livraisons')
    .select('*')
    .eq('livreur_id', livreurId)
    .order('created_at', { ascending: false })
    .limit(25);
  if (error) throw error;

  const recent = [];
  for (const liv of livraisons || []) {
    recent.push(await mapDeliveryRow(db, liv));
  }

  const livrees = recent.filter((d) => d.statut === 'livree').length;
  const enCours = recent.filter((d) => d.statut !== 'livree' && d.statut !== 'annulee').length;

  return {
    ...publicRow,
    compte_actif: livreur.utilisateur?.est_actif !== false,
    livraisons_recentes: recent,
    resume: {
      total_historique: Number(livreur.nb_livraisons_total ?? 0),
      reussies_historique: Number(livreur.nb_livraisons_reussies ?? 0),
      recentes_total: recent.length,
      recentes_livrees: livrees,
      recentes_en_cours: enCours,
    },
  };
}

async function getCourierIdsForCompany(db, companyId) {
  const { data: livreurs, error } = await db
    .from('livreurs')
    .select('id')
    .eq('entreprise_logistique_id', companyId);
  if (error) throw error;
  return (livreurs || []).map((l) => l.id);
}

function deliveryAddressFromSnapshot(snap) {
  if (snap && typeof snap === 'object' && snap.texte) return String(snap.texte);
  if (typeof snap === 'string') return snap;
  return '';
}

async function mapDeliveryRow(db, liv) {
  const { data: sc } = await db.from('sous_commandes').select('*').eq('id', liv.sous_commande_id).maybeSingle();
  let commande = null;
  if (sc?.commande_id) {
    const { data: c } = await db
      .from('commandes')
      .select('id, numero, statut, created_at')
      .eq('id', sc.commande_id)
      .maybeSingle();
    commande = c;
  }

  let livreur = null;
  if (liv.livreur_id) {
    const { data: l } = await db
      .from('livreurs')
      .select('id, utilisateur_id, type_vehicule, entreprise_logistique_id')
      .eq('id', liv.livreur_id)
      .maybeSingle();
    if (l?.utilisateur_id) {
      const { data: u } = await db
        .from('utilisateurs')
        .select('nom, telephone')
        .eq('id', l.utilisateur_id)
        .maybeSingle();
      livreur = {
        id: l.id,
        nom: u?.nom,
        telephone: u?.telephone,
        type_vehicule: l.type_vehicule,
        entreprise_logistique_id: l.entreprise_logistique_id,
      };
    }
  }

  const delay = classifyDeliveryDelay(liv);
  const elapsedSinceCreated = minutesSince(liv.created_at);
  const elapsedSinceAssigned = liv.attribuee_at ? minutesSince(liv.attribuee_at) : null;

  return {
    id: liv.id,
    statut: liv.statut,
    created_at: liv.created_at,
    attribuee_at: liv.attribuee_at,
    livree_at: liv.livree_at,
    adresse: deliveryAddressFromSnapshot(liv.adresse_livraison_snapshot),
    commande,
    sous_commande_id: liv.sous_commande_id,
    livreur,
    minutes_depuis_creation: elapsedSinceCreated,
    minutes_depuis_attribution: elapsedSinceAssigned,
    en_retard: delay.en_retard,
    type_retard: delay.type_retard,
    minutes_retard: delay.minutes_retard,
  };
}

async function loadDeliveriesForCompany(db, companyId, { status } = {}) {
  const courierIds = await getCourierIdsForCompany(db, companyId);
  const courierSet = new Set(courierIds);

  let query = db.from('livraisons').select('*').order('created_at', { ascending: false });
  if (status) query = query.eq('statut', status);
  const { data: livraisons, error } = await query;
  if (error) throw error;

  const filtered = (livraisons || []).filter(
    (liv) => !liv.livreur_id || courierSet.has(liv.livreur_id),
  );

  const out = [];
  for (const liv of filtered) {
    out.push(await mapDeliveryRow(db, liv));
  }
  return out;
}

async function listDeliveriesForLogisticsCompany(db, companyId, { status } = {}) {
  return loadDeliveriesForCompany(db, companyId, { status });
}

async function getLogisticsStatsForCompany(db, companyId) {
  const [couriers, deliveries, company] = await Promise.all([
    listCouriersForCompany(db, companyId),
    loadDeliveriesForCompany(db, companyId),
    getCompanyById(db, companyId),
  ]);

  const todayStart = startOfTodayIso();
  const todayDeliveries = deliveries.filter((d) => d.created_at >= todayStart);
  const activeStatuses = new Set(['en_attente', 'attribuee', 'en_collecte', 'collectee', 'en_route']);
  const enCours = deliveries.filter((d) => activeStatuses.has(d.statut));
  const enRetard = deliveries.filter((d) => d.en_retard);
  const livreesAujourdhui = todayDeliveries.filter((d) => d.statut === 'livree');
  const sansLivreur = deliveries.filter(
    (d) => !d.livreur?.id && d.statut !== 'livree' && d.statut !== 'annulee',
  );

  const parStatut = deliveries.reduce((acc, d) => {
    const key = d.statut || 'inconnu';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const completedWithDuration = livreesAujourdhui.filter((d) => d.attribuee_at && d.livree_at);
  let delaiMoyenMinutes = null;
  if (completedWithDuration.length > 0) {
    const totalMin = completedWithDuration.reduce((acc, d) => {
      const start = new Date(d.attribuee_at).getTime();
      const end = new Date(d.livree_at).getTime();
      return acc + Math.max(0, Math.floor((end - start) / 60000));
    }, 0);
    delaiMoyenMinutes = Math.round(totalMin / completedWithDuration.length);
  }

  const totalLivraisonsCouriers = couriers.reduce((acc, c) => acc + Number(c.nb_livraisons_total || 0), 0);
  const reussiesCouriers = couriers.reduce((acc, c) => acc + Number(c.nb_livraisons_reussies || 0), 0);
  const tauxReussite =
    totalLivraisonsCouriers > 0 ? Math.round((reussiesCouriers / totalLivraisonsCouriers) * 100) : null;

  const { getPricingConfig } = require('./pricing.service');
  const pricingConfig = await getPricingConfig(db);

  const livrees = deliveries.filter((d) => d.statut === 'livree');
  const livreesAujourdhuiAll = todayDeliveries.filter((d) => d.statut === 'livree');

  const livreeIds = livrees.map((d) => d.id);
  let revenusLivraisonTotal = 0;
  if (livreeIds.length > 0) {
    const { data: rows } = await db
      .from('livraisons')
      .select('id, commission_logistique, created_at')
      .in('id', livreeIds);
    for (const row of rows || []) {
      revenusLivraisonTotal += Number(row.commission_logistique ?? 0);
    }
  }

  const livreeTodayIds = livreesAujourdhuiAll.map((d) => d.id);
  let revenusLivraisonAujourdhui = 0;
  if (livreeTodayIds.length > 0) {
    const { data: rowsToday } = await db
      .from('livraisons')
      .select('id, commission_logistique')
      .in('id', livreeTodayIds);
    for (const row of rowsToday || []) {
      revenusLivraisonAujourdhui += Number(row.commission_logistique ?? 0);
    }
  }

  let portefeuilleSolde = null;
  if (company?.gestionnaire_id) {
    const { getPortefeuilleSolde } = require('./wallet.service');
    try {
      portefeuilleSolde = await getPortefeuilleSolde(db, company.gestionnaire_id);
    } catch {
      portefeuilleSolde = null;
    }
  }

  return {
    seuils_retard: {
      assignation_minutes: DELAY_ASSIGN_MINUTES,
      livraison_minutes: DELAY_DELIVERY_MINUTES,
    },
    livreurs_total: couriers.length,
    livreurs_disponibles: couriers.filter((c) => c.est_disponible && c.utilisateur?.est_actif !== false).length,
    livreurs_actifs: couriers.filter((c) => c.utilisateur?.est_actif !== false).length,
    livraisons_total: deliveries.length,
    livraisons_aujourdhui: todayDeliveries.length,
    livraisons_en_cours: enCours.length,
    livraisons_en_retard: enRetard.length,
    livraisons_sans_livreur: sansLivreur.length,
    livraisons_livrees_aujourdhui: livreesAujourdhui.length,
    taux_reussite_pct: tauxReussite,
    delai_moyen_minutes: delaiMoyenMinutes,
    par_statut: parStatut,
    revenus_livraison_total_fcfa: revenusLivraisonTotal,
    revenus_livraison_aujourdhui_fcfa: revenusLivraisonAujourdhui,
    split_ventes_percent: {
      merchant_percent: pricingConfig.merchant_percent,
      platform_fee_percent: pricingConfig.platform_fee_percent,
    },
    split_livraison_percent: {
      delivery_logistics_percent: pricingConfig.delivery_logistics_percent,
      delivery_platform_percent: pricingConfig.delivery_platform_percent,
    },
    portefeuille_solde_fcfa: portefeuilleSolde,
    mis_a_jour_le: new Date().toISOString(),
  };
}

async function getOperationsForCompany(db, companyId) {
  const deliveries = await loadDeliveriesForCompany(db, companyId);
  const active = deliveries.filter((d) => d.statut !== 'livree' && d.statut !== 'annulee');
  const recentDone = deliveries
    .filter((d) => d.statut === 'livree' && d.livree_at && d.livree_at >= startOfTodayIso())
    .slice(0, 15);

  const colonnes = {
    sans_livreur: active.filter((d) => !d.livreur?.id),
    en_route: active.filter((d) => d.livreur?.id && (d.statut === 'en_route' || d.statut === 'en_cours')),
    autres: active.filter(
      (d) => d.livreur?.id && d.statut !== 'en_route' && d.statut !== 'en_cours',
    ),
  };

  return {
    livraisons_actives: active,
    livraisons_recentes_livrees: recentDone,
    colonnes,
    alertes_retard: active.filter((d) => d.en_retard),
    mis_a_jour_le: new Date().toISOString(),
  };
}

async function getDelaysForCompany(db, companyId) {
  const deliveries = await loadDeliveriesForCompany(db, companyId);
  const retards = deliveries
    .filter((d) => d.en_retard)
    .sort((a, b) => (b.minutes_retard || 0) - (a.minutes_retard || 0));

  return {
    total: retards.length,
    assignation: retards.filter((d) => d.type_retard === 'assignation').length,
    livraison: retards.filter((d) => d.type_retard === 'livraison').length,
    livraisons: retards,
    seuils_retard: {
      assignation_minutes: DELAY_ASSIGN_MINUTES,
      livraison_minutes: DELAY_DELIVERY_MINUTES,
    },
    mis_a_jour_le: new Date().toISOString(),
  };
}

/** Relance l'attribution automatique GoLivra (sans choix manuel du livreur). */
async function retryAutoDispatchForCompany(db, companyId, deliveryId) {
  const courierIds = await getCourierIdsForCompany(db, companyId);

  const { data: delivery, error: delErr } = await db
    .from('livraisons')
    .select('*')
    .eq('id', deliveryId)
    .maybeSingle();
  if (delErr) throw delErr;
  if (!delivery) throw createHttpError(404, 'Livraison introuvable.');

  if (delivery.livreur_id && !courierIds.includes(delivery.livreur_id)) {
    throw createHttpError(403, 'Cette course est suivie par un autre réseau de livreurs.');
  }

  if (delivery.livreur_id) {
    return mapDeliveryRow(db, delivery);
  }

  const { notifyAvailableCouriersForDelivery } = require('./notification.service');
  await notifyAvailableCouriersForDelivery(db, deliveryId);

  const { data: refreshed } = await db.from('livraisons').select('*').eq('id', deliveryId).maybeSingle();
  return mapDeliveryRow(db, refreshed || delivery);
}

module.exports = {
  VEHICLE_TYPES,
  DELAY_ASSIGN_MINUTES,
  DELAY_DELIVERY_MINUTES,
  normalizeEmail,
  getRoleId,
  getCompanyById,
  getCompanyByGestionnaire,
  assertCompanyActive,
  assertCompanyAccess,
  createLogisticsCompanyWithManager,
  listCouriersForCompany,
  createCourierForCompany,
  suspendCourier,
  activateCourier,
  setCourierAvailability,
  getCourierDetailForCompany,
  mapCourierPublic,
  listDeliveriesForLogisticsCompany,
  retryAutoDispatchForCompany,
  getLogisticsStatsForCompany,
  getOperationsForCompany,
  getDelaysForCompany,
};
