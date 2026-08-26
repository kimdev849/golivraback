/**
 * Incident Management Service
 *
 * Système professionnel de gestion des incidents de livraison.
 *
 * Niveaux de retard :
 *   - Niveau 1 (Léger)    : +5 à +15 min  → notification automatique au livreur
 *   - Niveau 2 (Significatif) : +15 à +30 min → demande motif au livreur
 *   - Niveau 3 (Incident)  : +30 min       → incident admin, intervention requise
 *
 * Niveaux de risque :
 *   - NORMAL        : course dans les temps
 *   - A_SURVEILLER  : petit retard
 *   - RETARD        : retard important
 *   - INCIDENT      : retard + problème identifié
 *   - CRITIQUE      : livreur injoignable / colis bloqué / sécurité
 *
 * Flow : détection → qualification → notification → intervention → résolution → traçabilité
 */

const { getDb } = require('../config/db');
const { createHttpError } = require('../utils/http');
const { resolveVendorUserId } = require('../utils/resolve-users');

// ── Seuils de retard (en minutes) ──────────────────────────────────────────
const DELAY_LEVEL_1_MIN = 5;    // Niveau 1 : +5 min
const DELAY_LEVEL_2_MIN = 15;   // Niveau 2 : +15 min
const DELAY_LEVEL_3_MIN = 30;   // Niveau 3 : +30 min (incident)
const DELAY_CRITICAL_MIN = 60;  // Critique : +60 min

// ── Motifs rapides pour le livreur ──────────────────────────────────────────
const DELAY_REASONS = [
  { key: 'trafic',          label: 'Trafic important',           emoji: '🚗' },
  { key: 'client_difficile', label: 'Client difficile à trouver', emoji: '🏠' },
  { key: 'adresse_incorrecte', label: 'Adresse incorrecte',       emoji: '📍' },
  { key: 'probleme_vehicule', label: 'Problème véhicule',        emoji: '🛵' },
  { key: 'client_injoignable', label: 'Client injoignable',       emoji: '📞' },
  { key: 'autre',           label: 'Autre problème',             emoji: '⚠️' },
];

// ── Niveaux de risque ──────────────────────────────────────────────────────
const RISK_LEVELS = {
  NORMAL:       { label: 'Normal',              color: '#22C55E', emoji: '🟢', order: 0 },
  A_SURVEILLER: { label: 'À surveiller',        color: '#F59E0B', emoji: '🟡', order: 1 },
  RETARD:       { label: 'Retard',              color: '#F97316', emoji: '🟠', order: 2 },
  INCIDENT:     { label: 'Incident',            color: '#EF4444', emoji: '🔴', order: 3 },
  CRITIQUE:     { label: 'Critique',            color: '#DC2626', emoji: '🔴🔴', order: 4 },
};

// ── Niveaux d'incident ─────────────────────────────────────────────────────
const INCIDENT_LEVELS = {
  NIVEAU_1: { key: 'niveau_1', label: 'Retard léger',        color: '#F59E0B', emoji: '🟡', delayRange: '+5 à +15 min' },
  NIVEAU_2: { key: 'niveau_2', label: 'Retard significatif', color: '#F97316', emoji: '🟠', delayRange: '+15 à +30 min' },
  NIVEAU_3: { key: 'niveau_3', label: 'Incident',            color: '#EF4444', emoji: '🔴', delayRange: '+30 min' },
};

// ── Actions opérateur ──────────────────────────────────────────────────────
const OPERATOR_ACTIONS = [
  'contacter_livreur',
  'contacter_client',
  'contacter_restaurant',
  'reassigner',
  'annuler_livraison',
  'resoudre_incident',
  'ajouter_note',
  'escalader',
];

// ── Statuts actifs ─────────────────────────────────────────────────────────
const ACTIVE_STATUSES = ['attribuee', 'en_collecte', 'collectee', 'en_route', 'incident', 'reassigning', 'transferring'];



function minutesSince(isoDate) {
  if (!isoDate) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(isoDate).getTime()) / 60000));
}

function formatElapsed(minutes) {
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h}h${String(m).padStart(2, '0')}min` : `${h}h`;
  }
  return `${minutes} min`;
}

/**
 * Calcule le niveau d'incident en minutes de retard.
 */
function computeDelayLevel(elapsedMinutes) {
  if (elapsedMinutes >= DELAY_LEVEL_3_MIN) return 3;
  if (elapsedMinutes >= DELAY_LEVEL_2_MIN) return 2;
  if (elapsedMinutes >= DELAY_LEVEL_1_MIN) return 1;
  return 0;
}

/**
 * Calcule le niveau de risque d'une livraison.
 */
function computeRiskLevel(livraison) {
  if (livraison.statut === 'livree' || livraison.statut === 'annulee') {
    return 'NORMAL';
  }

  const referenceDate = livraison.collectee_at || livraison.attribuee_at || livraison.created_at;
  const elapsed = minutesSince(referenceDate);

  // Si le livreur est injoignable (pas d'activité depuis longtemps)
  if (livraison.derniere_position_at) {
    const posElapsed = minutesSince(livraison.derniere_position_at);
    if (posElapsed >= 60) return 'CRITIQUE';
  }

  if (elapsed >= DELAY_CRITICAL_MIN) return 'CRITIQUE';
  if (elapsed >= DELAY_LEVEL_3_MIN) return 'INCIDENT';
  if (elapsed >= DELAY_LEVEL_2_MIN) return 'RETARD';
  if (elapsed >= DELAY_LEVEL_1_MIN) return 'A_SURVEILLER';
  return 'NORMAL';
}

/**
 * Détermine le niveau d'incident basé sur le retard.
 */
function computeIncidentLevel(elapsedMinutes) {
  if (elapsedMinutes >= DELAY_LEVEL_3_MIN) return 'niveau_3';
  if (elapsedMinutes >= DELAY_LEVEL_2_MIN) return 'niveau_2';
  if (elapsedMinutes >= DELAY_LEVEL_1_MIN) return 'niveau_1';
  return null;
}

/**
 * Résout les informations complètes d'une livraison pour l'incident center.
 */
async function resolveDeliveryInfo(db, livraison) {
  const result = {
    id: livraison.id,
    statut: livraison.statut,
    type_livraison: livraison.type_livraison || 'commande',
    created_at: livraison.created_at,
    attribuee_at: livraison.attribuee_at,
    collectee_at: livraison.collectee_at,
    livree_at: livraison.livree_at,
    montant_total: livraison.montant_total,
    note: livraison.note || null,

    // Livreur
    livreur: null,
    // Client
    client: null,
    // Commerce
    commerce: null,
    // Adresse
    adresse_livraison: '',
    adresse_retrait: '',

    // Incident data
    delay_minutes: 0,
    delay_label: '',
    risk_level: 'NORMAL',
    risk_info: RISK_LEVELS.NORMAL,
    incident_level: null,
    incident_level_info: null,
    incident_since: null,
    incident_reason: null,
    last_activity_ago: null,

    // Physical custody of the package
    colis_recupere: false,
    colis_recupere_at: null,
    colis_detenteur: null, // 'livreur' | null
    colis_peut_etre_reattribue: true, // false if picked up
    colis_necessite_transfert: false, // true if picked up + incident

    // Delay detail
    delai_prevu_minutes: null,
    delai_prevu_at: null,

    // Timeline
    timeline: [],
    // Operator actions history
    operator_actions: [],
  };

  // ── Colis : statut physique ──────────────────────────────────────────────
  const colisRecupere = !!(livraison.collectee_at);
  result.colis_recupere = colisRecupere;
  result.colis_recupere_at = livraison.collectee_at || null;
  result.colis_peut_etre_reattribue = !colisRecupere;
  result.colis_necessite_transfert = colisRecupere && !!livraison.incident_niveau;
  if (colisRecupere && livraison.livreur_id) {
    result.colis_detenteur = 'livreur';
  }

  // ── Résoudre livreur ─────────────────────────────────────────────────────
  if (livraison.livreur_id) {
    try {
      const { data: lr } = await db
        .from('livreurs')
        .select('id, type_vehicule, utilisateur_id, latitude_actuelle, longitude_actuelle, derniere_position_at')
        .eq('id', livraison.livreur_id)
        .maybeSingle();
      if (lr?.utilisateur_id) {
        const { data: u } = await db
          .from('utilisateurs')
          .select('id, nom, telephone, avatar_url, est_actif')
          .eq('id', lr.utilisateur_id)
          .maybeSingle();
        result.livreur = {
          id: lr.id,
          nom: u?.nom || 'Livreur',
          telephone: u?.telephone || null,
          avatar_url: u?.avatar_url || null,
          type_vehicule: lr.type_vehicule || null,
          est_actif: u?.est_actif !== false,
          position: lr.latitude_actuelle != null && lr.longitude_actuelle != null
            ? { latitude: lr.latitude_actuelle, longitude: lr.longitude_actuelle, at: lr.derniere_position_at }
            : null,
          derniere_activite_at: lr.derniere_position_at || null,
        };
        if (lr.derniere_position_at) {
          result.last_activity_ago = minutesSince(lr.derniere_position_at);
        }
      }
    } catch { /* swallow */ }
  }

  // ── Résoudre client ──────────────────────────────────────────────────────
  let clientId = null;
  if (livraison.client_nom || livraison.client_telephone) {
    result.client = {
      nom: livraison.client_nom || null,
      telephone: livraison.client_telephone || null,
    };
  }
  // Try to resolve client from order
  if (livraison.sous_commande_id) {
    try {
      const { data: sc } = await db.from('sous_commandes').select('commande_id').eq('id', livraison.sous_commande_id).maybeSingle();
      if (sc?.commande_id) {
        const { data: c } = await db.from('commandes').select('client_id').eq('id', sc.commande_id).maybeSingle();
        clientId = c?.client_id;
        if (clientId) {
          const { data: cu } = await db.from('utilisateurs').select('id, nom, telephone').eq('id', clientId).maybeSingle();
          if (cu) {
            result.client = { ...result.client, id: cu.id, nom: cu.nom || result.client?.nom, telephone: cu.telephone || result.client?.telephone };
          }
        }
      }
    } catch { /* swallow */ }
  }

  // ── Résoudre commerce ────────────────────────────────────────────────────
  if (livraison.restaurant_id) {
    try {
      const { data: r } = await db
        .from('restaurants')
        .select('id, nom, telephone, proprietaire_id')
        .eq('id', livraison.restaurant_id)
        .maybeSingle();
      if (r) {
        result.commerce = { id: r.id, type: 'restaurant', nom: r.nom, telephone: r.telephone };
        // Resolve vendor user
        if (r.proprietaire_id) {
          const { data: vu } = await db.from('utilisateurs').select('id, telephone').eq('id', r.proprietaire_id).maybeSingle();
          result.commerce.utilisateur_id = vu?.id || null;
          result.commerce.telephone = vu?.telephone || r.telephone;
        }
      }
    } catch { /* swallow */ }
  }
  if (livraison.boutique_id) {
    try {
      const { data: b } = await db
        .from('boutiques')
        .select('id, nom, telephone, proprietaire_id')
        .eq('id', livraison.boutique_id)
        .maybeSingle();
      if (b) {
        result.commerce = { id: b.id, type: 'boutique', nom: b.nom, telephone: b.telephone };
        if (b.proprietaire_id) {
          const { data: vu } = await db.from('utilisateurs').select('id, telephone').eq('id', b.proprietaire_id).maybeSingle();
          result.commerce.utilisateur_id = vu?.id || null;
          result.commerce.telephone = vu?.telephone || b.telephone;
        }
      }
    } catch { /* swallow */ }
  }

  // ── Adresses ─────────────────────────────────────────────────────────────
  const snapLivraison = livraison.adresse_livraison_snapshot;
  if (snapLivraison && typeof snapLivraison === 'object') {
    result.adresse_livraison = snapLivraison.texte || '';
  }
  const snapCollecte = livraison.adresse_collecte_snapshot;
  if (snapCollecte && typeof snapCollecte === 'object') {
    result.adresse_retrait = snapCollecte.texte || '';
  }

  // ── Calculs de retard ────────────────────────────────────────────────────
  const referenceDate = livraison.collectee_at || livraison.attribuee_at || livraison.created_at;
  const delayMinutes = minutesSince(referenceDate);
  result.delay_minutes = delayMinutes;
  result.delay_label = formatElapsed(delayMinutes);
  result.risk_level = computeRiskLevel(livraison);
  result.risk_info = RISK_LEVELS[result.risk_level] || RISK_LEVELS.NORMAL;
  result.incident_level = livraison.incident_niveau || computeIncidentLevel(delayMinutes);
  result.incident_level_info = result.incident_level ? INCIDENT_LEVELS[result.incident_level?.toUpperCase()] || null : null;
  result.incident_since = livraison.incident_depuis || null;
  result.incident_reason = livraison.incident_raison || null;

  // ── Timeline ─────────────────────────────────────────────────────────────
  result.timeline = buildTimeline(livraison);

  // ── Actions opérateur ────────────────────────────────────────────────────
  try {
    const { data: actions } = await db
      .from('incident_actions')
      .select('*')
      .eq('livraison_id', livraison.id)
      .order('created_at', { ascending: false })
      .limit(50);
    result.operator_actions = (actions || []).map(mapActionRow);
  } catch { /* swallow - table may not exist */ }

  return result;
}

/**
 * Construit la timeline complète d'une livraison.
 */
function buildTimeline(livraison) {
  const events = [];

  const addEvent = (titre, date, type = 'fait', details = null) => {
    if (date) {
      events.push({
        titre,
        date,
        date_label: formatDateFr(date),
        type,
        details,
      });
    }
  };

  // Commande créée
  addEvent('Commande créée', livraison.created_at, 'fait');

  // Livreur assigné
  addEvent('Livreur assigné', livraison.attribuee_at, 'fait');

  // Colis récupéré
  addEvent('Colis récupéré', livraison.collectee_at, 'fait');

  // Livraison terminée
  if (livraison.statut === 'livree') {
    addEvent('Livraison terminée', livraison.livree_at, 'fait');
    if (livraison.proof_photo_url) {
      addEvent('Preuve de livraison enregistrée', livraison.livree_at, 'fait');
    }
  }

  // Retard détecté
  if (livraison.incident_niveau) {
    addEvent(
      `⚠️ Retard détecté (${livraison.incident_niveau})`,
      livraison.incident_depuis || livraison.attribuee_at,
      'alerte',
    );
  }

  // Motif du livreur
  if (livraison.delay_reason) {
    const reasonInfo = DELAY_REASONS.find((r) => r.key === livraison.delay_reason);
    addEvent(
      `Livreur indique : ${reasonInfo ? `${reasonInfo.emoji} ${reasonInfo.label}` : livraison.delay_reason}`,
      livraison.delay_reason_at || livraison.incident_depuis,
      'info',
      livraison.delay_reason_detail || null,
    );
  }

  // Annulée
  if (livraison.statut === 'annulee') {
    addEvent('Livraison annulée', livraison.annulee_at, 'annulation');
  }

  // Trier par date
  events.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  return events;
}

function formatDateFr(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch { return iso; }
}

function mapActionRow(row) {
  return {
    id: row.id,
    action: row.action,
    action_label: formatActionLabel(row.action),
    operateur_nom: row.operateur_nom || 'Système',
    details: row.details || null,
    created_at: row.created_at,
    created_at_label: formatDateFr(row.created_at),
  };
}

function formatActionLabel(action) {
  const labels = {
    contacter_livreur: '📞 Contact livreur',
    contacter_client: '📞 Contact client',
    contacter_restaurant: '📞 Contact restaurant',
    reassigner: '🔄 Réassignation',
    annuler_livraison: '❌ Annulation',
    resoudre_incident: '✅ Résolution',
    ajouter_note: '📝 Note ajoutée',
    escalader: '🚨 Escalade',
    delay_reason_reported: '📋 Motif signalé',
  };
  return labels[action] || action;
}

/**
 * Liste les incidents pour une entreprise logistique.
 */
async function listIncidentsForCompany(db, companyId) {
  // Récupérer les livreurs de l'entreprise
  const { data: couriers } = await db
    .from('livreurs')
    .select('id')
    .eq('entreprise_logistique_id', companyId);

  const courierIds = (couriers || []).map((c) => c.id);
  if (courierIds.length === 0) return [];

  // Livraisons actives avec retard
  const { data: livraisons } = await db
    .from('livraisons')
    .select('*')
    .in('livreur_id', courierIds)
    .in('statut', ACTIVE_STATUSES)
    .order('created_at', { ascending: false });

  const INCIDENT_STATUSES = ['incident', 'reassigning', 'transferring'];
  const incidents = [];
  for (const liv of (livraisons || [])) {
    const isIncidentStatus = INCIDENT_STATUSES.includes(liv.statut);
    const referenceDate = liv.collectee_at || liv.attribuee_at || liv.created_at;
    const delay = minutesSince(referenceDate);
    const level = computeIncidentLevel(delay);
    // Inclure si statut incident OU retard >= 5 min OU incident_niveau déjà défini
    if (!isIncidentStatus && !level && !liv.incident_niveau) continue;

    // Forcer le niveau d'incident pour les statuts incident workflow
    if (isIncidentStatus && !liv.incident_niveau) {
      liv.incident_niveau = 'niveau_2';
    }

    const info = await resolveDeliveryInfo(db, liv);
    incidents.push(info);
  }

  // Trier par niveau d'incident (le plus grave en premier)
  incidents.sort((a, b) => {
    const levelOrder = { niveau_3: 3, niveau_2: 2, niveau_1: 1 };
    return (levelOrder[b.incident_level] || 0) - (levelOrder[a.incident_level] || 0);
  });

  return incidents;
}

/**
 * Liste TOUTES les livraisons actives avec leur niveau de risque (dashboard).
 */
async function listAllActiveDeliveriesForCompany(db, companyId) {
  const { data: couriers } = await db
    .from('livreurs')
    .select('id')
    .eq('entreprise_logistique_id', companyId);

  const courierIds = (couriers || []).map((c) => c.id);
  if (courierIds.length === 0) return [];

  const { data: livraisons } = await db
    .from('livraisons')
    .select('*')
    .in('livreur_id', courierIds)
    .in('statut', ACTIVE_STATUSES)
    .order('created_at', { ascending: false });

  const results = [];
  for (const liv of (livraisons || [])) {
    const info = await resolveDeliveryInfo(db, liv);
    results.push(info);
  }

  return results;
}

/**
 * Rapporte le motif de retard par un livreur.
 */
async function reportDelayReason(db, deliveryId, livreurId, reasonKey, detail) {
  const reason = DELAY_REASONS.find((r) => r.key === reasonKey);
  if (!reason && reasonKey !== 'autre') {
    throw createHttpError(400, 'Motif de retard invalide.');
  }

  const { data: liv, error } = await db
    .from('livraisons')
    .select('*')
    .eq('id', deliveryId)
    .eq('livreur_id', livreurId)
    .maybeSingle();
  if (error) throw error;
  if (!liv) throw createHttpError(404, 'Livraison introuvable.');

  const now = new Date().toISOString();
  const patch = {
    delay_reason: reasonKey || 'autre',
    delay_reason_at: now,
    delay_reason_detail: detail ? String(detail).slice(0, 500) : null,
    updated_at: now,
  };

  const { error: updErr } = await db.from('livraisons').update(patch).eq('id', deliveryId);
  if (updErr) throw updErr;

  // Log action
  try {
    await logOperatorAction(db, deliveryId, 'delay_reason_reported', null, `Motif : ${reason ? reason.label : reasonKey}${detail ? ` — ${detail}` : ''}`);
  } catch { /* swallow */ }

  return { success: true, reason: reasonKey };
}

/**
 * Enregistre une action opérateur.
 */
async function logOperatorAction(db, deliveryId, action, operateurNom, details) {
  try {
    await db.from('incident_actions').insert({
      livraison_id: deliveryId,
      action,
      operateur_nom: operateurNom || 'Système',
      details: details || null,
      created_at: new Date().toISOString(),
    });
  } catch {
    // Table may not exist — swallow
  }
}

/**
 * Résout un incident (appelé par l'admin/gestionnaire).
 * Notifie toutes les parties.
 */
async function resolveIncident(db, deliveryId, resolution, operateurNom) {
  const { data: liv, error } = await db
    .from('livraisons')
    .select('*')
    .eq('id', deliveryId)
    .maybeSingle();
  if (error) throw error;
  if (!liv) throw createHttpError(404, 'Livraison introuvable.');

  const now = new Date().toISOString();
  // Restaurer le statut actif si la livraison était en 'incident'
  const statutPatch = {
    incident_niveau: null,
    incident_depuis: null,
    incident_raison: resolution || 'Résolu par opérateur',
    updated_at: now,
  };
  if (liv.statut === 'incident') {
    // Reprendre le statut d'avant l'incident
    statutPatch.statut = liv.collectee_at ? 'en_route' : 'en_collecte';
  }
  const { error: updErr } = await db.from('livraisons').update(statutPatch).eq('id', deliveryId);
  if (updErr) throw updErr;

  await logOperatorAction(db, deliveryId, 'resoudre_incident', operateurNom, resolution);

  // Notifier les parties concernees
  const { notifyUserSafe } = require('./notification.service');
  const livraisonRef = `Livraison #${deliveryId.slice(0, 8)}`;
  const data = { livraison_id: deliveryId, action: 'vendor_delivery' };

  // Notifier le livreur
  if (liv.livreur_id) {
    try {
      const { data: lr } = await db.from('livreurs').select('utilisateur_id').eq('id', liv.livreur_id).maybeSingle();
      if (lr?.utilisateur_id) {
        await notifyUserSafe(db, {
          utilisateurId: lr.utilisateur_id,
          type: 'livraison_incident_resolu',
          titre: 'Incident resolu',
          corps: `${livraisonRef} : l'incident est resolu. La livraison continue normalement.`,
          data: { livraison_id: deliveryId, action: 'courier_missions' },
        });
      }
    } catch { /* swallow */ }
  }

  // Notifier le commerce
  try {
    const vendorUserId = await resolveVendorUserId(db, liv.restaurant_id, liv.boutique_id);
    if (vendorUserId) {
      await notifyUserSafe(db, {
        utilisateurId: vendorUserId,
        type: 'livraison_incident_resolu',
        titre: 'Incident resolu',
        corps: `${livraisonRef} : l'incident est resolu. La livraison continue.`,
        data,
      });
    }
  } catch { /* swallow */ }

  return { success: true };
}

/**
 * Annule une livraison (appelé par l'admin/gestionnaire).
 * Libere le livreur et notifie toutes les parties.
 */
async function cancelDelivery(db, deliveryId, raison, operateurNom) {
  const { data: liv, error } = await db
    .from('livraisons')
    .select('*')
    .eq('id', deliveryId)
    .maybeSingle();
  if (error) throw error;
  if (!liv) throw createHttpError(404, 'Livraison introuvable.');

  const now = new Date().toISOString();
  const { error: updErr } = await db.from('livraisons').update({
    statut: 'annulee',
    annulee_at: now,
    incident_niveau: null,
    incident_depuis: null,
    incident_raison: raison || 'Annulée par opérateur',
    updated_at: now,
  }).eq('id', deliveryId);
  if (updErr) throw updErr;

  await logOperatorAction(db, deliveryId, 'annuler_livraison', operateurNom, raison);

  // Notifier toutes les parties
  const { notifyUserSafe } = require('./notification.service');
  const livraisonRef = `Livraison #${deliveryId.slice(0, 8)}`;
  const data = { livraison_id: deliveryId };

  // Notifier le livreur (il est libere)
  if (liv.livreur_id) {
    try {
      const { data: lr } = await db.from('livreurs').select('utilisateur_id').eq('id', liv.livreur_id).maybeSingle();
      if (lr?.utilisateur_id) {
        await notifyUserSafe(db, {
          utilisateurId: lr.utilisateur_id,
          type: 'livraison_annulee',
          titre: 'Livraison annulee',
          corps: `${livraisonRef} a ete annulee. Vous etes libre pour une nouvelle course.`,
          data: { livraison_id: deliveryId, action: 'courier_missions' },
        });
      }
    } catch { /* swallow */ }
  }

  // Notifier le commerce
  try {
    const vendorUserId = await resolveVendorUserId(db, liv.restaurant_id, liv.boutique_id);
    if (vendorUserId) {
      await notifyUserSafe(db, {
        utilisateurId: vendorUserId,
        type: 'livraison_annulee',
        titre: 'Livraison annulee',
        corps: `${livraisonRef} a ete annulee. Raison : ${raison || 'Non precisee'}.`,
        data: { ...data, action: 'vendor_delivery' },
      });
    }
  } catch { /* swallow */ }

  // Notifier le client (si commande liée)
  if (liv.sous_commande_id) {
    try {
      const { data: sc } = await db.from('sous_commandes').select('commande_id').eq('id', liv.sous_commande_id).maybeSingle();
      if (sc?.commande_id) {
        const { data: cmd } = await db.from('commandes').select('client_id, statut').eq('id', sc.commande_id).maybeSingle();
        if (cmd?.client_id) {
          await notifyUserSafe(db, {
            utilisateurId: cmd.client_id,
            type: 'livraison_annulee',
            titre: 'Livraison annulee',
            corps: `${livraisonRef} a ete annulee. ${raison || ''} Contactez le support pour plus d'informations.`,
            data: { livraison_id: deliveryId, action: 'open_order_tracking' },
          });
        }
      }
    } catch { /* swallow */ }
  }

  // Cascade : mettre à jour la sous_commande si applicable
  if (liv.sous_commande_id) {
    try {
      await db.from('sous_commandes').update({ statut: 'annulee', updated_at: now }).eq('id', liv.sous_commande_id);
      const { data: sc } = await db.from('sous_commandes').select('commande_id').eq('id', liv.sous_commande_id).maybeSingle();
      if (sc?.commande_id) {
        // Recalculer le statut de la commande parente
        const { data: scs } = await db.from('sous_commandes').select('statut').eq('commande_id', sc.commande_id);
        const statuts = (scs || []).map((s) => s.statut);
        let nextStatut = 'en_preparation';
        if (statuts.length > 0 && statuts.every((s) => s === 'annulee' || s === 'refusee' || s === 'remboursee')) nextStatut = 'annulee';
        else if (statuts.some((s) => s === 'livree')) nextStatut = 'partiellement_livree';
        await db.from('commandes').update({ statut: nextStatut, updated_at: now }).eq('id', sc.commande_id);
      }
    } catch { /* swallow */ }
  }

  return { success: true };
}

/**
 * Ajoute une note à un incident.
 */
async function addIncidentNote(db, deliveryId, note, operateurNom) {
  await logOperatorAction(db, deliveryId, 'ajouter_note', operateurNom, note);
  return { success: true };
}

/**
 * Escalade un incident vers GoLivra (passe au niveau supérieur + notifie les admins).
 */
async function escalateIncident(db, deliveryId, operateurNom) {
  const { data: liv, error } = await db
    .from('livraisons')
    .select('*')
    .eq('id', deliveryId)
    .maybeSingle();
  if (error) throw error;
  if (!liv) throw createHttpError(404, 'Livraison introuvable.');

  const now = new Date().toISOString();
  const currentLevel = liv.incident_niveau || 'niveau_1';
  const nextLevel = currentLevel === 'niveau_1' ? 'niveau_2' : currentLevel === 'niveau_2' ? 'niveau_3' : 'niveau_3';

  const { error: updErr } = await db.from('livraisons').update({
    incident_niveau: nextLevel,
    incident_depuis: liv.incident_depuis || now,
    updated_at: now,
  }).eq('id', deliveryId);
  if (updErr) throw updErr;

  await logOperatorAction(db, deliveryId, 'escalader', operateurNom, `Escalade de ${currentLevel} vers ${nextLevel} — Situation remontee a GoLivra`);

  // Notifier les admins GoLivra
  const { notifyUserSafe } = require('./notification.service');
  const livraisonRef = `Livraison #${deliveryId.slice(0, 8)}`;
  try {
    // Trouver le role_id pour 'admin'
    const { data: adminRole } = await db.from('roles').select('id').eq('nom', 'admin').maybeSingle();
    if (adminRole) {
      const { data: admins } = await db.from('utilisateurs').select('id').eq('role_id', adminRole.id).eq('est_actif', true);
      for (const admin of (admins || [])) {
        await notifyUserSafe(db, {
          utilisateurId: admin.id,
          type: 'livraison_incident_admin',
          titre: 'Incident eskale vers GoLivra',
          corps: `${livraisonRef} : l'entreprise a eskale la situation. Niveau ${nextLevel}. Intervention requise.`,
          data: { livraison_id: deliveryId, action: 'open_delivery' },
        });
      }
    }
  } catch { /* swallow */ }

  return { success: true, new_level: nextLevel };
}

/**
 * Stats du centre d'incidents pour une entreprise.
 */
async function getIncidentStats(db, companyId) {
  const incidents = await listIncidentsForCompany(db, companyId);
  const allActive = await listAllActiveDeliveriesForCompany(db, companyId);

  return {
    total_incidents: incidents.length,
    niveau_1: incidents.filter((i) => i.incident_level === 'niveau_1').length,
    niveau_2: incidents.filter((i) => i.incident_level === 'niveau_2').length,
    niveau_3: incidents.filter((i) => i.incident_level === 'niveau_3').length,
    total_active: allActive.length,
    risk_breakdown: {
      NORMAL: allActive.filter((i) => i.risk_level === 'NORMAL').length,
      A_SURVEILLER: allActive.filter((i) => i.risk_level === 'A_SURVEILLER').length,
      RETARD: allActive.filter((i) => i.risk_level === 'RETARD').length,
      INCIDENT: allActive.filter((i) => i.risk_level === 'INCIDENT').length,
      CRITIQUE: allActive.filter((i) => i.risk_level === 'CRITIQUE').length,
    },
    livraisons: incidents,
    mis_a_jour_le: new Date().toISOString(),
  };
}

module.exports = {
  DELAY_LEVEL_1_MIN,
  DELAY_LEVEL_2_MIN,
  DELAY_LEVEL_3_MIN,
  DELAY_CRITICAL_MIN,
  DELAY_REASONS,
  RISK_LEVELS,
  INCIDENT_LEVELS,
  ACTIVE_STATUSES,
  minutesSince,
  formatElapsed,
  computeDelayLevel,
  computeRiskLevel,
  computeIncidentLevel,
  resolveDeliveryInfo,
  buildTimeline,
  listIncidentsForCompany,
  listAllActiveDeliveriesForCompany,
  reportDelayReason,
  logOperatorAction,
  resolveIncident,
  cancelDelivery,
  addIncidentNote,
  escalateIncident,
  getIncidentStats,
};
