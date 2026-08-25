/**
 * Delivery Monitor Service
 *
 * Vérifie périodiquement toutes les livraisons actives et gère
 * l'escalade des incidents :
 *   - 0-30 min   : normal
 *   - 30 min     : ⚠️ EN RETARD — alerte livreur + restaurant
 *   - 1 h        : 🔴 INCIDENT — notification + temps écoulé affiché
 *   - 2 h        : 🚨 ANOMALIE — action requise, intervention GoLivra
 *   - 24 h       : 💀 BLOQUÉE — intervention admin obligatoire
 *
 * Le livreur reste "occupé" tant que la course n'est pas
 * LIVRÉE / ANNULÉE / RÉASSIGNÉE.
 */

const { getDb } = require('../config/db');

// Intervalles en millisecondes
const DELAY_30_MIN = 30 * 60 * 1000;
const DELAY_1_HOUR = 60 * 60 * 1000;
const DELAY_2_HOURS = 2 * 60 * 60 * 1000;
const DELAY_24_HOURS = 24 * 60 * 60 * 1000;

/** Statuts de livraison actifs (le livreur est toujours responsable). */
const ACTIVE_DELIVERY_STATUSES = [
  'attribuee',
  'en_collecte',
  'collectee',
  'en_route',
];

/** Niveaux d'incident. */
const INCIDENT_NONE = null;
const INCIDENT_RETARD = 'retard';       // 30 min
const INCIDENT_INCIDENT = 'incident';   // 1 h
const INCIDENT_ANOMALIE = 'anomalie';   // 2 h
const INCIDENT_BLOQUE = 'bloquee';      // 24 h

/**
 * Détermine le niveau d'incident en fonction du temps écoulé
 * depuis le début de la phase active (attribuee_at ou collectee_at).
 */
function computeIncidentLevel(elapsedMs) {
  if (elapsedMs >= DELAY_24_HOURS) return INCIDENT_BLOQUE;
  if (elapsedMs >= DELAY_2_HOURS) return INCIDENT_ANOMALIE;
  if (elapsedMs >= DELAY_1_HOUR) return INCIDENT_INCIDENT;
  if (elapsedMs >= DELAY_30_MIN) return INCIDENT_RETARD;
  return INCIDENT_NONE;
}

/**
 * Retourne le libellé humain d'un niveau d'incident.
 */
function incidentLabel(level) {
  switch (level) {
    case INCIDENT_RETARD: return '⚠️ En retard';
    case INCIDENT_INCIDENT: return '🔴 Incident';
    case INCIDENT_ANOMALIE: return '🚨 Anomalie';
    case INCIDENT_BLOQUE: return '💀 Bloquée — intervention requise';
    default: return null;
  }
}

/**
 * Calcule le temps écoulé en minutes depuis une date ISO.
 */
function minutesSince(isoDate) {
  if (!isoDate) return 0;
  return Math.round((Date.now() - new Date(isoDate).getTime()) / 60_000);
}

/**
 * Envoie une notification push + DB à un utilisateur.
 */
async function notifyUserSafe(db, { utilisateurId, type, titre, corps, data }) {
  try {
    const { notifyUser } = require('./order-notify.service');
    await notifyUser(db, { utilisateurId, type, titre, corps, data });
  } catch {
    // Fallback : insert direct en DB
    try {
      await db.from('notifications').insert({
        utilisateur_id: utilisateurId,
        type: type || 'livraison_incident',
        titre,
        corps,
        data: data || {},
        lue: false,
      });
    } catch { /* swallow */ }
  }
}

/**
 * Résout l'utilisateur propriétaire d'un commerce.
 */
async function resolveVendorUserId(db, restaurantId, boutiqueId) {
  if (restaurantId) {
    const { data } = await db.from('restaurants').select('proprietaire_id').eq('id', restaurantId).maybeSingle();
    return data?.proprietaire_id || null;
  }
  if (boutiqueId) {
    const { data } = await db.from('boutiques').select('proprietaire_id').eq('id', boutiqueId).maybeSingle();
    return data?.proprietaire_id || null;
  }
  return null;
}

/**
 * Résout l'utilisateur livreur.
 */
async function resolveCourierUserId(db, livreurId) {
  if (!livreurId) return null;
  const { data } = await db.from('livreurs').select('utilisateur_id').eq('id', livreurId).maybeSingle();
  return data?.utilisateur_id || null;
}

/**
 * Met à jour le niveau d'incident et envoie les notifications appropriées.
 * Ne notifie que si le niveau a changé (évite le spam).
 */
async function escalateDelivery(db, liv, newLevel, elapsedMinutes) {
  const previousLevel = liv.incident_niveau || null;
  if (newLevel === previousLevel) return; // déjà au bon niveau

  const vendorUserId = await resolveVendorUserId(db, liv.restaurant_id, liv.boutique_id);
  const courierUserId = await resolveCourierUserId(db, liv.livreur_id);
  const data = { livraison_id: liv.id, action: 'vendor_delivery' };

  // Mettre à jour le niveau d'incident
  const patch = { incident_niveau: newLevel, updated_at: new Date().toISOString() };
  if (newLevel && !liv.incident_depuis) patch.incident_depuis = new Date().toISOString();
  if (!newLevel) {
    patch.incident_depuis = null;
    patch.incident_raison = null;
  }
  patch.derniere_alerte_at = new Date().toISOString();

  await db.from('livraisons').update(patch).eq('id', liv.id);

  const livraisonRef = `Livraison #${liv.id.slice(0, 8)}`;
  const destName = liv.client_nom || 'votre client';

  switch (newLevel) {
    case INCIDENT_RETARD:
      // 30 min → alerte livreur + restaurant
      if (courierUserId) {
        await notifyUserSafe(db, {
          utilisateurId: courierUserId,
          type: 'livraison_retard',
          titre: '⚠️ Livraison en retard',
          corps: `La livraison pour ${destName} dépasse le délai habituel (${elapsedMinutes} min). Veuillez vérifier la course et avancer le statut.`,
          data,
        });
      }
      if (vendorUserId) {
        await notifyUserSafe(db, {
          utilisateurId: vendorUserId,
          type: 'livraison_retard',
          titre: '⚠️ Livraison en retard',
          corps: `La livraison pour ${destName} prend du retard (${elapsedMinutes} min). Le livreur a été notifié.`,
          data,
        });
      }
      break;

    case INCIDENT_INCIDENT:
      // 1 h → notification renforcée
      if (courierUserId) {
        await notifyUserSafe(db, {
          utilisateurId: courierUserId,
          type: 'livraison_incident',
          titre: '🔴 Livraison en incident',
          corps: `La livraison pour ${destName} est en incident depuis ${elapsedMinutes} min. Contactez le support GoLivra ou avancez la livraison immédiatement.`,
          data,
        });
      }
      if (vendorUserId) {
        await notifyUserSafe(db, {
          utilisateurId: vendorUserId,
          type: 'livraison_incident',
          titre: '🔴 Incident de livraison',
          corps: `La livraison pour ${destName} est en incident (${elapsedMinutes} min). GoLivra prend en charge la situation.`,
          data,
        });
      }
      break;

    case INCIDENT_ANOMALIE:
      // 2 h → anomalie, GoLivra intervient
      if (vendorUserId) {
        await notifyUserSafe(db, {
          utilisateurId: vendorUserId,
          type: 'livraison_anomalie',
          titre: '🚨 Anomalie de livraison',
          corps: `La livraison pour ${destName} est en anomalie depuis ${elapsedMinutes} min. L'équipe GoLivra intervient. Vous serez tenu informé.`,
          data,
        });
      }
      // Notifier aussi les admins
      try {
        const { data: admins } = await db.from('utilisateurs').select('id').eq('role', 'admin').eq('est_actif', true);
        for (const admin of (admins || [])) {
          await notifyUserSafe(db, {
            utilisateurId: admin.id,
            type: 'livraison_anomalie_admin',
            titre: '🚨 Anomalie livraison',
            corps: `${livraisonRef} pour ${destName} — ${elapsedMinutes} min sans progression. Intervention requise.`,
            data,
          });
        }
      } catch { /* swallow */ }
      break;

    case INCIDENT_BLOQUE:
      // 24 h → bloquée, intervention admin obligatoire
      try {
        const { data: admins } = await db.from('utilisateurs').select('id').eq('role', 'admin').eq('est_actif', true);
        for (const admin of (admins || [])) {
          await notifyUserSafe(db, {
            utilisateurId: admin.id,
            type: 'livraison_bloquee',
            titre: '💀 Livraison bloquée',
            corps: `${livraisonRef} pour ${destName} — bloquée depuis ${Math.round(elapsedMinutes / 60)}h. Intervention admin obligatoire.`,
            data,
          });
        }
      } catch { /* swallow */ }
      if (vendorUserId) {
        await notifyUserSafe(db, {
          utilisateurId: vendorUserId,
          type: 'livraison_bloquee',
          titre: '💀 Livraison bloquée',
          corps: `La livraison pour ${destName} est bloquée depuis ${Math.round(elapsedMinutes / 60)}h. GoLivra prend en charge la résolution.`,
          data,
        });
      }
      break;
  }
}

/**
 * Vérifie toutes les livraisons actives et applique l'escalade.
 * À appeler toutes les 5 minutes.
 */
async function monitorActiveDeliveries() {
  const db = getDb();

  const { data: livraisons, error } = await db
    .from('livraisons')
    .select('*')
    .in('statut', ACTIVE_DELIVERY_STATUSES)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[delivery-monitor] Error fetching active deliveries:', error.message);
    return;
  }

  const list = livraisons || [];
  if (list.length === 0) return;

  let escalations = 0;

  for (const liv of list) {
    // La date de référence est la dernière transition significative :
    // - attribuee_at : quand le livreur a accepté
    // - collectee_at : quand le colis a été récupéré
    // On utilise la plus récente pour calculer le retard.
    const referenceDate = liv.collectee_at || liv.attribuee_at || liv.created_at;
    const elapsedMs = Date.now() - new Date(referenceDate).getTime();
    const elapsedMinutes = minutesSince(referenceDate);

    const newLevel = computeIncidentLevel(elapsedMs);

    if (newLevel !== (liv.incident_niveau || null)) {
      await escalateDelivery(db, liv, newLevel, elapsedMinutes);
      escalations++;
    }
  }

  if (escalations > 0) {
    console.log(`[delivery-monitor] ${escalations} deliveries escalated out of ${list.length} active`);
  }
}

/**
 * Résout l'incident d'une livraison (appelé par l'admin).
 */
async function resolveIncident(db, livraisonId, resolution, adminUserId) {
  const { data: liv, error } = await db
    .from('livraisons')
    .select('*')
    .eq('id', livraisonId)
    .maybeSingle();
  if (error) throw error;
  if (!liv) throw new Error('Livraison introuvable');

  const patch = {
    incident_niveau: null,
    incident_depuis: null,
    incident_raison: resolution || 'Résolu par admin',
    updated_at: new Date().toISOString(),
  };

  await db.from('livraisons').update(patch).eq('id', livraisonId);

  // Notifier le restaurant et le livreur
  const vendorUserId = await resolveVendorUserId(db, liv.restaurant_id, liv.boutique_id);
  const courierUserId = await resolveCourierUserId(db, liv.livreur_id);
  const data = { livraison_id: livraisonId, action: 'vendor_delivery' };
  const msg = `Livraison #${livraisonId.slice(0, 8)} : incident résolu — ${resolution || 'Pris en charge par l\'équipe'}`;

  if (vendorUserId) {
    await notifyUserSafe(db, {
      utilisateurId: vendorUserId,
      type: 'livraison_incident_resolu',
      titre: '✅ Incident résolu',
      corps: msg,
      data,
    });
  }
  if (courierUserId) {
    await notifyUserSafe(db, {
      utilisateurId: courierUserId,
      type: 'livraison_incident_resolu',
      titre: '✅ Incident résolu',
      corps: msg,
      data: { livraison_id: livraisonId, action: 'courier_missions' },
    });
  }

  return { success: true };
}

/**
 * Annule une livraison bloquée (appelé par l'admin).
 */
async function cancelStuckDelivery(db, livraisonId, raison, adminUserId) {
  const { data: liv, error } = await db
    .from('livraisons')
    .select('*')
    .eq('id', livraisonId)
    .maybeSingle();
  if (error) throw error;
  if (!liv) throw new Error('Livraison introuvable');

  const now = new Date().toISOString();
  await db.from('livraisons').update({
    statut: 'annulee',
    annulee_at: now,
    incident_niveau: null,
    incident_depuis: null,
    incident_raison: raison || 'Annulée par admin',
    updated_at: now,
  }).eq('id', livraisonId);

  // Notifier toutes les parties
  const vendorUserId = await resolveVendorUserId(db, liv.restaurant_id, liv.boutique_id);
  const courierUserId = await resolveCourierUserId(db, liv.livreur_id);
  const data = { livraison_id: livraisonId };

  if (vendorUserId) {
    await notifyUserSafe(db, {
      utilisateurId: vendorUserId,
      type: 'livraison_annulee',
      titre: 'Livraison annulée',
      corps: `La livraison #${livraisonId.slice(0, 8)} a été annulée. Raison : ${raison || 'Non précisé'}.`,
      data: { ...data, action: 'vendor_delivery' },
    });
  }
  if (courierUserId) {
    await notifyUserSafe(db, {
      utilisateurId: courierUserId,
      type: 'livraison_annulee',
      titre: 'Livraison annulée',
      corps: `La livraison #${livraisonId.slice(0, 8)} a été annulée par l'admin.`,
      data: { ...data, action: 'courier_missions' },
    });
  }

  return { success: true };
}

/**
 * Liste les livraisons nécessitant une intervention (pour le dashboard admin).
 */
async function listDeliveriesNeedingIntervention(db) {
  const { data: livraisons, error } = await db
    .from('livraisons')
    .select('*')
    .not('incident_niveau', 'is', null)
    .order('incident_depuis', { ascending: true });

  if (error) throw error;

  const out = [];
  for (const liv of (livraisons || [])) {
    // Résoudre les noms
    let commerceNom = '';
    let livreurNom = '';
    let livreurTel = '';

    if (liv.restaurant_id) {
      const { data: r } = await db.from('restaurants').select('nom').eq('id', liv.restaurant_id).maybeSingle();
      commerceNom = r?.nom || '';
    } else if (liv.boutique_id) {
      const { data: b } = await db.from('boutiques').select('nom').eq('id', liv.boutique_id).maybeSingle();
      commerceNom = b?.nom || '';
    }

    if (liv.livreur_id) {
      const { data: lr } = await db.from('livreurs').select('utilisateur_id').eq('id', liv.livreur_id).maybeSingle();
      if (lr?.utilisateur_id) {
        const { data: u } = await db.from('utilisateurs').select('nom, telephone').eq('id', lr.utilisateur_id).maybeSingle();
        livreurNom = u?.nom || 'Livreur';
        livreurTel = u?.telephone || '';
      }
    }

    const referenceDate = liv.collectee_at || liv.attribuee_at || liv.created_at;
    const elapsedMinutes = minutesSince(referenceDate);

    out.push({
      id: liv.id,
      statut: liv.statut,
      type_livraison: liv.type_livraison || 'externe',
      client_nom: liv.client_nom || null,
      commerce_nom: commerceNom,
      livreur_nom: livreurNom,
      livreur_telephone: livreurTel,
      livreur_id: liv.livreur_id,
      incident_niveau: liv.incident_niveau,
      incident_depuis: liv.incident_depuis,
      incident_raison: liv.incident_raison || null,
      elapsed_minutes: elapsedMinutes,
      elapsed_label: elapsedMinutes >= 60
        ? `${Math.floor(elapsedMinutes / 60)}h${elapsedMinutes % 60 ? ` ${elapsedMinutes % 60}min` : ''}`
        : `${elapsedMinutes} min`,
      created_at: liv.created_at,
      attribuee_at: liv.attribuee_at,
      collectee_at: liv.collectee_at,
      derniere_alerte_at: liv.derniere_alerte_at,
      montant_total: liv.montant_total || 0,
      statut_label: incidentLabel(liv.incident_niveau),
    });
  }

  return out;
}

module.exports = {
  monitorActiveDeliveries,
  resolveIncident,
  cancelStuckDelivery,
  listDeliveriesNeedingIntervention,
  INCIDENT_RETARD,
  INCIDENT_INCIDENT,
  INCIDENT_ANOMALIE,
  INCIDENT_BLOQUE,
};
