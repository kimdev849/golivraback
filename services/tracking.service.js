const { haversineKm } = require('./dispatch.service');

/** Statuts pendant lesquels le livreur est « en course » (partage sa position). */
const ACTIVE_COURSE_STATUTS = new Set(['attribuee', 'en_collecte', 'collectee', 'en_route']);

/**
 * Âge maximum d'une position pour l'afficher sur la carte (min).
 * Au-delà, le livreur est listé mais sans point : la carte reste honnête
 * (un livreur qui a fermé son app ne « flotte » pas à sa dernière position).
 */
const POSITION_MAX_AGE_MS = 15 * 60 * 1000;

function deliveryAddressFromSnapshot(snap) {
  if (snap && typeof snap === 'object' && snap.texte) return String(snap.texte);
  if (typeof snap === 'string') return snap;
  return '';
}

/** Sélection de base (toujours disponible). */
const BASE_COLUMNS_LIVREURS = 'id, type_vehicule, est_disponible, est_approuve, note_moyenne, nb_livraisons_reussies, utilisateur_id, entreprise_logistique_id';
/** Colonnes GPS (disponibles après migration SQL amendments-gps-tracking.sql). */
const GPS_COLUMNS_LIVREURS = ', latitude_actuelle, longitude_actuelle, derniere_position_at';
const BASE_COLUMNS_LIVRAISONS = '*';
const GPS_COLUMNS_LIVRAISONS = 'latitude_collecte, longitude_collecte, latitude_livraison, longitude_livraison';

/**
 * Vue temps réel des livreurs (position partagée UNIQUEMENT pendant une course) :
 *   - admin → toutes les entreprises logistiques ;
 *   - gestionnaire logistique → sa propre entreprise (companyId).
 *
 * Retourne pour chaque livreur son statut opérationnel, sa position courante
 * (si récente), sa course en cours et la distance restante jusqu'à l'adresse.
 *
 * Résilient : si les colonnes GPS n'existent pas encore dans la base,
 * la fonction fonctionne sans positions (fallback gracieux).
 */
async function getActiveCouriersTracking(db, { companyId } = {}) {
  // ── 1. Livreurs (GPS optionnel) ──────────────────────────────────────────
  let livreurs;
  let hasGpsColumns = false;

  // Tentative avec colonnes GPS
  try {
    let q = db
      .from('livreurs')
      .select(`${BASE_COLUMNS_LIVREURS}${GPS_COLUMNS_LIVREURS}`)
      .order('created_at', { ascending: false });
    if (companyId) q = q.eq('entreprise_logistique_id', companyId);
    const { data, error } = await q;
    if (error) throw error;
    livreurs = data;
    hasGpsColumns = true;
  } catch {
    // Colonnes GPS absentes → fallback sur base
    let q = db
      .from('livreurs')
      .select(BASE_COLUMNS_LIVREURS)
      .order('created_at', { ascending: false });
    if (companyId) q = q.eq('entreprise_logistique_id', companyId);
    const { data, error } = await q;
    if (error) throw error;
    livreurs = data;
    hasGpsColumns = false;
  }

  const userIds = [...new Set((livreurs || []).map((l) => l.utilisateur_id).filter(Boolean))];
  const { data: users } = userIds.length
    ? await db.from('utilisateurs').select('id, nom, telephone, est_actif').in('id', userIds)
    : { data: [] };
  const userMap = new Map((users || []).map((u) => [u.id, u]));

  const { data: companies } = companyId
    ? { data: [] }
    : await db.from('entreprises_logistiques').select('id, nom');
  const companyMap = new Map((companies || []).map((c) => [c.id, c]));

  // ── 2. Courses en cours (GPS optionnel) ───────────────────────────────────
  let activeDeliveries;
  let deliveriesHaveGps = false;

  try {
    const { data, error } = await db
      .from('livraisons')
      .select(`${BASE_COLUMNS_LIVRAISONS}, ${GPS_COLUMNS_LIVRAISONS}`)
      .in('statut', [...ACTIVE_COURSE_STATUTS]);
    if (error) throw error;
    activeDeliveries = data;
    deliveriesHaveGps = true;
  } catch {
    const { data, error } = await db
      .from('livraisons')
      .select(BASE_COLUMNS_LIVRAISONS)
      .in('statut', [...ACTIVE_COURSE_STATUTS]);
    if (error) throw error;
    activeDeliveries = data;
    deliveriesHaveGps = false;
  }

  // Référence lisible de la course (numéro de commande) via sous-commandes.
  const scIds = [...new Set((activeDeliveries || []).map((l) => l.sous_commande_id).filter(Boolean))];
  const { data: scs } = scIds.length
    ? await db.from('sous_commandes').select('id, commande_id').in('id', scIds)
    : { data: [] };
  const commandeIds = [...new Set((scs || []).map((s) => s.commande_id).filter(Boolean))];
  const { data: commandes } = commandeIds.length
    ? await db.from('commandes').select('id, numero').in('id', commandeIds)
    : { data: [] };
  const commandeIdBySc = new Map((scs || []).map((s) => [s.id, s.commande_id]));
  const numeroByCommande = new Map((commandes || []).map((c) => [c.id, c.numero]));

  const deliveryByCourier = new Map();
  for (const liv of activeDeliveries || []) {
    if (!liv.livreur_id) continue;
    const commandeId = commandeIdBySc.get(liv.sous_commande_id);
    const reference = numeroByCommande.get(commandeId) || liv.id.slice(0, 8).toUpperCase();

    const course = {
      id: liv.id,
      reference,
      statut: liv.statut,
      adresse_retrait: deliveryAddressFromSnapshot(liv.adresse_collecte_snapshot),
      adresse_livraison: deliveryAddressFromSnapshot(liv.adresse_livraison_snapshot),
      retrait: null,
      destination: null,
    };

    if (deliveriesHaveGps) {
      if (liv.latitude_collecte != null && liv.longitude_collecte != null) {
        course.retrait = { latitude: Number(liv.latitude_collecte), longitude: Number(liv.longitude_collecte) };
      }
      if (liv.latitude_livraison != null && liv.longitude_livraison != null) {
        course.destination = { latitude: Number(liv.latitude_livraison), longitude: Number(liv.longitude_livraison) };
      }
    }

    deliveryByCourier.set(liv.livreur_id, course);
  }

  const now = Date.now();
  const couriers = [];

  for (const l of livreurs || []) {
    const user = userMap.get(l.utilisateur_id) || null;
    const compteActif = user?.est_actif !== false;
    const course = deliveryByCourier.get(l.id) || null;

    // Position : uniquement si récente (≤ 15 min) et colonnes GPS disponibles.
    let position = null;
    let position_age_min = null;

    if (hasGpsColumns && l.latitude_actuelle != null && l.longitude_actuelle != null && l.derniere_position_at) {
      const age = now - new Date(l.derniere_position_at).getTime();
      if (Number.isFinite(age) && age >= 0 && age <= POSITION_MAX_AGE_MS) {
        position = {
          latitude: Number(l.latitude_actuelle),
          longitude: Number(l.longitude_actuelle),
          at: l.derniere_position_at,
        };
        position_age_min = Math.floor(age / 60000);
      }
    }

    const statut = course
      ? 'en_course'
      : l.est_disponible && l.est_approuve && compteActif
        ? 'disponible'
        : 'hors_ligne';

    let distance_km_restant = null;
    if (course?.destination && position) {
      const d = haversineKm(
        position.latitude,
        position.longitude,
        course.destination.latitude,
        course.destination.longitude,
      );
      distance_km_restant = Number.isFinite(d) ? Number(d.toFixed(2)) : null;
    }

    couriers.push({
      id: l.id,
      nom: user?.nom || 'Livreur',
      telephone: user?.telephone || null,
      type_vehicule: l.type_vehicule || null,
      note_moyenne: l.note_moyenne != null ? Number(l.note_moyenne) : null,
      nb_livraisons_reussies: Number(l.nb_livraisons_reussies || 0),
      entreprise_id: l.entreprise_logistique_id || null,
      entreprise_nom: companyId ? null : companyMap.get(l.entreprise_logistique_id)?.nom || null,
      compte_actif: compteActif,
      statut,
      position,
      position_age_min,
      course,
      distance_km_restant,
    });
  }

  const resume = {
    en_course: couriers.filter((c) => c.statut === 'en_course').length,
    disponibles: couriers.filter((c) => c.statut === 'disponible').length,
    hors_ligne: couriers.filter((c) => c.statut === 'hors_ligne').length,
    avec_position: couriers.filter((c) => c.position).length,
    total: couriers.length,
  };

  // ── Stats live : livraisons terminées aujourd'hui, délai moyen, taux ──
  const courierIds = couriers.map((c) => c.id);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();

  let todayDelivered = [];
  let todayAll = [];
  if (courierIds.length > 0) {
    const { data: todayLivs } = await db
      .from('livraisons')
      .select('id, statut, livreur_id, created_at, attribuee_at, livree_at')
      .in('livreur_id', courierIds)
      .gte('created_at', todayIso);
    todayAll = todayLivs || [];
    todayDelivered = todayAll.filter((l) => l.statut === 'livree' && l.livree_at);
  }

  let delaiMoyenMinutes = null;
  if (todayDelivered.length > 0) {
    const totalMs = todayDelivered.reduce((acc, l) => {
      const start = new Date(l.attribuee_at || l.created_at).getTime();
      const end = new Date(l.livree_at).getTime();
      return acc + Math.max(0, end - start);
    }, 0);
    delaiMoyenMinutes = Math.round(totalMs / todayDelivered.length / 60_000);
  }

  const stats = {
    livraisons_aujourdhui: todayAll.length,
    livraisons_terminees: todayDelivered.length,
    delai_moyen_minutes: delaiMoyenMinutes,
  };

  return { generated_at: new Date().toISOString(), couriers, resume, stats };
}

module.exports = { getActiveCouriersTracking };
