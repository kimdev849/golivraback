/**
 * Incident Workflow Service
 *
 * Gestion complète du cycle de vie d'un incident de livraison.
 *
 * Chaîne de fallback (du meilleur au dernier recours) :
 *   1. Le problème est résolu → le livreur original continue
 *   2. Autre livreur de la MÊME entreprise → transfert interne
 *   3. Autre entreprise PARTenaire GoLivra → transfert cross-company
 *   4. Aucune solution → annulation définitive → remboursement éligible
 *
 * Principe :
 *   - Problème d'un livreur ≠ remboursement
 *   - Problème d'une entreprise ≠ remboursement
 *   - Seul l'échec de TOUTES les solutions → annulation → remboursement éventuel
 *
 * Statuts de livraison :
 *   attribuee → en_collecte → collectee → en_route → livree
 *                                              ↓
 *                                          incident
 *                                              ↓
 *                                         reassigning (même entreprise)
 *                                              ↓
 *                                         transferring (transfert physique)
 *                                              ↓
 *                                         en_route (reprise)
 *                                              ↓
 *                                           livree
 *
 *   OU : annulee (uniquement si impossibilité définitive)
 */

const { getDb } = require('../config/db');
const { createHttpError } = require('../utils/http');
const { notifyUserSafe } = require('./notification.service');

// ── Statuts de livraison ───────────────────────────────────────────────────
const DELIVERY_STATUSES = {
  ASSIGNEE: 'attribuee',
  EN_COLLECTE: 'en_collecte',
  COLLECTEE: 'collectee',
  EN_ROUTE: 'en_route',
  LIVREE: 'livree',
  ANNULEE: 'annulee',
  // Nouveaux statuts pour le workflow d'incident
  INCIDENT: 'incident',
  REASSIGNING: 'reassigning',
  TRANSFERRING: 'transferring',
};

// ── Motifs de problème (côté livreur) ──────────────────────────────────────
const PROBLEM_REASONS = [
  { key: 'panne_vehicule', label: 'Panne du véhicule', emoji: '🛵', severity: 'high' },
  { key: 'accident', label: 'Accident / incident routier', emoji: '🚧', severity: 'critical' },
  { key: 'trafic', label: 'Trafic important', emoji: '🚦', severity: 'medium' },
  { key: 'probleme_colis', label: 'Problème avec le colis', emoji: '📦', severity: 'high' },
  { key: 'adresse_incorrecte', label: "Problème d'accès / localisation", emoji: '📍', severity: 'medium' },
  { key: 'probleme_technique', label: 'Problème technique', emoji: '📱', severity: 'medium' },
  { key: 'incident_grave', label: 'Incident grave', emoji: '🚨', severity: 'critical' },
  { key: 'client_injoignable', label: 'Client injoignable', emoji: '📞', severity: 'medium' },
  { key: 'autre', label: 'Autre', emoji: '⚠️', severity: 'medium' },
];

function minutesSince(isoDate) {
  if (!isoDate) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(isoDate).getTime()) / 60000));
}

function formatDateFr(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('fr-FR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
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
 * Enregistre une action opérateur dans incident_actions (legacy).
 */
async function logAction(db, deliveryId, action, operateurNom, details) {
  try {
    await db.from('incident_actions').insert({
      livraison_id: deliveryId,
      action,
      operateur_nom: operateurNom || 'Système',
      details: details || null,
      created_at: new Date().toISOString(),
    });
  } catch { /* swallow - table may not exist */ }
}

/**
 * Enregistre un événement dans l'audit log immuable.
 * Chaque action importante est tracée avec l'acteur, le rôle, les états.
 */
async function auditLog(db, payload) {
  try {
    await db.from('incident_event_logs').insert({
      livraison_id: payload.deliveryId,
      acteur_id: payload.acteurId || null,
      acteur_role: payload.acteurRole || 'systeme',
      acteur_nom: payload.acteurNom || 'Système',
      action: payload.action,
      action_detail: payload.detail || null,
      statut_avant: payload.statutAvant || null,
      statut_apres: payload.statutApres || null,
      livreur_avant_id: payload.livreurAvantId || null,
      livreur_apres_id: payload.livreurApresId || null,
      entreprise_avant_id: payload.entrepriseAvantId || null,
      entreprise_apres_id: payload.entrepriseApresId || null,
      metadata: payload.metadata || null,
      created_at: new Date().toISOString(),
    });
  } catch { /* swallow - table may not exist */ }
}

// ════════════════════════════════════════════════════════════════════════════
// 1. LIVREUR SIGNALE UN PROBLÈME
// ════════════════════════════════════════════════════════════════════════════

/**
 * Le livreur signale un problème pendant la livraison.
 * → Crée un incident (met à jour les colonnes incident_* sur la livraison)
 * → Passe le statut en 'incident'
 * → Notifie l'entreprise logistique
 */
async function reportProblemFromCourier(db, deliveryId, courierId, reasonKey, detail) {
  const { data: liv, error } = await db
    .from('livraisons')
    .select('*')
    .eq('id', deliveryId)
    .maybeSingle();
  if (error) throw error;
  if (!liv) throw createHttpError(404, 'Livraison introuvable.');
  if (liv.livreur_id !== courierId) throw createHttpError(403, 'Cette livraison ne vous est pas assignée.');

  const activeStatuses = ['en_collecte', 'collectee', 'en_route'];
  if (!activeStatuses.includes(liv.statut)) {
    throw createHttpError(400, `Impossible de signaler un problème pour une livraison en statut "${liv.statut}".`);
  }

  const reason = PROBLEM_REASONS.find((r) => r.key === reasonKey) || PROBLEM_REASONS.find((r) => r.key === 'autre');
  const now = new Date().toISOString();

  // Mettre à jour la livraison : incident + statut
  const { error: updErr } = await db.from('livraisons').update({
    statut: DELIVERY_STATUSES.INCIDENT,
    incident_niveau: reason.severity === 'critical' ? 'niveau_3' : reason.severity === 'high' ? 'niveau_2' : 'niveau_1',
    incident_depuis: now,
    delay_reason: reasonKey,
    delay_reason_at: now,
    delay_reason_detail: detail ? String(detail).slice(0, 500) : null,
    updated_at: now,
  }).eq('id', deliveryId);
  if (updErr) throw updErr;  await logAction(db, deliveryId, 'delay_reason_reported', liv.livreur_id, `Motif : ${reason.emoji} ${reason.label}${detail ? ` — ${detail}` : ''}`);

  // Audit log
  await auditLog(db, {
    deliveryId,
    acteurId: courierId,
    acteurRole: 'livreur',
    acteurNom: liv.livreur_id,
    action: 'problem_reported',
    detail: `${reason.emoji} ${reason.label}${detail ? ` — ${detail}` : ''}`,
    statutAvant: liv.statut,
    statutApres: DELIVERY_STATUSES.INCIDENT,
    livreurAvantId: liv.livreur_id,
    livreurApresId: liv.livreur_id,
    metadata: { reason_key: reasonKey, severity: reason.severity },
  });


  // ── Notifier l'entreprise logistique ────────────────────────────────────
  const livraisonRef = `Livraison #${deliveryId.slice(0, 8)}`;
  const orderNum = liv.sous_commande_id ? ` (commande liée)` : '';
  const corps = `${livraisonRef}${orderNum} : le livreur a signalé un problème — ${reason.emoji} ${reason.label}. ${detail || ''}`;

  // Notifier le gestionnaire de l'entreprise
  if (liv.entreprise_logistique_id) {
    try {
      const { data: company } = await db
        .from('entreprises_logistiques')
        .select('gestionnaire_id')
        .eq('id', liv.entreprise_logistique_id)
        .maybeSingle();
      if (company?.gestionnaire_id) {
        await notifyUserSafe(db, {
          utilisateurId: company.gestionnaire_id,
          type: 'livraison_incident',
          titre: '🚨 Incident de livraison',
          corps,
          data: { livraison_id: deliveryId, action: 'open_incident' },
        });
      }
    } catch { /* swallow */ }
  }

  // Notifier les admins GoLivra si incident critique
  if (reason.severity === 'critical') {
    try {
      const { data: admins } = await db.from('utilisateurs').select('id')
        .eq('role_id', (await db.from('roles').select('id').eq('nom', 'admin').maybeSingle()).data?.id)
        .eq('est_actif', true);
      for (const admin of (admins || [])) {
        await notifyUserSafe(db, {
          utilisateurId: admin.id,
          type: 'livraison_incident_admin',
          titre: '🚨 Incident critique',
          corps,
          data: { livraison_id: deliveryId, action: 'open_delivery' },
        });
      }
    } catch { /* swallow */ }
  }

  // Notifier le commerce
  const vendorUserId = await resolveVendorUserId(db, liv.restaurant_id, liv.boutique_id);
  if (vendorUserId) {
    await notifyUserSafe(db, {
      utilisateurId: vendorUserId,
      type: 'livraison_incident',
      titre: '⚠️ Incident de livraison',
      corps: `${livraisonRef} : le livreur a rencontré un problème. Une prise en charge est en cours. Retard estimé.`,
      data: { livraison_id: deliveryId, action: 'vendor_delivery' },
    });
  }

  // Notifier le client (si commande liée)
  if (liv.sous_commande_id) {
    try {
      const { data: sc } = await db.from('sous_commandes').select('commande_id').eq('id', liv.sous_commande_id).maybeSingle();
      if (sc?.commande_id) {
        const { data: cmd } = await db.from('commandes').select('client_id').eq('id', sc.commande_id).maybeSingle();
        if (cmd?.client_id) {
          await notifyUserSafe(db, {
            utilisateurId: cmd.client_id,
            type: 'livraison_incident',
            titre: '⚠️ Mise à jour de votre livraison',
            corps: 'Votre livreur a rencontré un problème pendant la livraison. Nous organisons la prise en charge. Votre livraison peut subir un retard supplémentaire.',
            data: { livraison_id: deliveryId, action: 'open_order_tracking' },
          });
        }
      }
    } catch { /* swallow */ }
  }

  return { success: true, status: DELIVERY_STATUSES.INCIDENT, incident_level: liv.incident_niveau };
}


// ════════════════════════════════════════════════════════════════════════════
// 2. ENTREPRISE RÉATTRIBUE LA LIVRAISON
// ════════════════════════════════════════════════════════════════════════════

/**
 * L'entreprise assigne un nouveau livreur à la livraison.
 * → Libère l'ancien livreur
 * → Assigne le nouveau livreur
 * → Passe en statut 'reassigning' si le colis n'a pas été récupéré, 
 *   ou 'transferring' si le colis est chez l'ancien livreur
 * → Notifie le nouveau livreur, le client, le commerce
 */
async function reassignDelivery(db, deliveryId, newCourierId, operateurNom) {
  const { data: liv, error } = await db
    .from('livraisons')
    .select('*')
    .eq('id', deliveryId)
    .maybeSingle();
  if (error) throw error;
  if (!liv) throw createHttpError(404, 'Livraison introuvable.');
  if (liv.statut !== DELIVERY_STATUSES.INCIDENT && liv.statut !== DELIVERY_STATUSES.REASSIGNING) {
    throw createHttpError(400, `Réattribution impossible pour une livraison en statut "${liv.statut}".`);
  }

  const now = new Date().toISOString();
  const colisRecupere = !!liv.collectee_at;
  const newStatus = colisRecupere ? DELIVERY_STATUSES.TRANSFERRING : DELIVERY_STATUSES.REASSIGNING;

  // Assigner le nouveau livreur
  const { error: updErr } = await db.from('livraisons').update({
    livreur_id: newCourierId,
    statut: newStatus,
    updated_at: now,
  }).eq('id', deliveryId);
  if (updErr) throw updErr;

  await logAction(db, deliveryId, 'reassigner', operateurNom,
    `Nouveau livreur assigné. ${colisRecupere ? 'Transfert physique nécessaire (colis chez l\'ancien livreur).' : 'Colis pas encore récupéré, nouveau livreur en route vers le commerce.'}`);

  // Audit log
  await auditLog(db, {
    deliveryId,
    acteurId: operateurNom,
    acteurRole: 'gestionnaire',
    action: 'courier_reassigned',
    detail: `Ancien livreur → nouveau livreur. ${colisRecupere ? 'Transfert physique nécessaire.' : 'Colis pas encore récupéré.'}`,
    statutAvant: liv.statut,
    statutApres: newStatus,
    livreurAvantId: liv.livreur_id,
    livreurApresId: newCourierId,
    metadata: { colis_recupere: colisRecupere },
  });

  const livraisonRef = `Livraison #${deliveryId.slice(0, 8)}`;

  // Notifier le nouveau livreur
  try {
    const newCourierUserId = await resolveCourierUserId(db, newCourierId);
    if (newCourierUserId) {
      await notifyUserSafe(db, {
        utilisateurId: newCourierUserId,
        type: 'livraison_reassignee',
        titre: '📦 Nouvelle course assignée',
        corps: colisRecupere
          ? `${livraisonRef} : un transfert de colis est nécessaire. Rendez-vous chez le livreur précédent pour récupérer le colis.`
          : `${livraisonRef} : vous avez été assigné à cette livraison. Récupérez la commande chez le commerce.`,
        data: { livraison_id: deliveryId, action: 'courier_missions' },
      });
    }
  } catch { /* swallow */ }

  // Libérer l'ancien livreur (notification)
  if (liv.livreur_id && liv.livreur_id !== newCourierId) {
    try {
      const oldCourierUserId = await resolveCourierUserId(db, liv.livreur_id);
      if (oldCourierUserId) {
        await notifyUserSafe(db, {
          utilizationId: oldCourierUserId,
          type: 'livraison_reassignee',
          titre: '🔄 Livraison réassignée',
          corps: `${livraisonRef} a été réassignée à un autre livreur. Vous êtes libre pour une nouvelle course.`,
          data: { livraison_id: deliveryId, action: 'courier_missions' },
        });
      }
    } catch { /* swallow */ }
  }

  // Notifier le commerce
  const vendorUserId = await resolveVendorUserId(db, liv.restaurant_id, liv.boutique_id);
  if (vendorUserId) {
    await notifyUserSafe(db, {
      utilisateurId: vendorUserId,
      type: 'livraison_reassignee',
      titre: '🔄 Livreur remplacé',
      corps: `${livraisonRef} : un nouveau livreur a été assigné. ${colisRecupere ? 'Un transfert de colis est en cours.' : 'Le nouveau livreur se rend chez vous.'}`,
      data: { livraison_id: deliveryId, action: 'vendor_delivery' },
    });
  }

  // Notifier le client
  if (liv.sous_commande_id) {
    try {
      const { data: sc } = await db.from('sous_commandes').select('commande_id').eq('id', liv.sous_commande_id).maybeSingle();
      if (sc?.commande_id) {
        const { data: cmd } = await db.from('commandes').select('client_id').eq('id', sc.commande_id).maybeSingle();
        if (cmd?.client_id) {
          await notifyUserSafe(db, {
            utilisateurId: cmd.client_id,
            type: 'livraison_reassignee',
            titre: '🚚 Un nouveau livreur prend en charge votre livraison',
            corps: colisRecupere
              ? 'Un transfert de colis est en cours. Votre livraison peut subir un léger retard supplémentaire.'
              : 'Un nouveau livreur a été assigné et se rend récupérer votre commande.',
            data: { livraison_id: deliveryId, action: 'open_order_tracking' },
          });
        }
      }
    } catch { /* swallow */ }
  }

  return { success: true, status: newStatus, colis_recupere: colisRecupere };
}


// ════════════════════════════════════════════════════════════════════════════
// 3. CONFIRMER LE TRANSFERT PHYSIQUE DU COLIS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Le nouveau livreur confirme avoir récupéré le colis de l'ancien livreur.
 * → Passe en 'en_route' (le nouveau livreur peut livrer)
 * → Résout l'incident
 * → Notifie le client : "Votre colis a été récupéré par le nouveau livreur"
 */
async function confirmTransfer(db, deliveryId, newCourierId, operateurNom) {
  const { data: liv, error } = await db
    .from('livraisons')
    .select('*')
    .eq('id', deliveryId)
    .maybeSingle();
  if (error) throw error;
  if (!liv) throw createHttpError(404, 'Livraison introuvable.');
  if (liv.statut !== DELIVERY_STATUSES.TRANSFERRING) {
    throw createHttpError(400, `Transfert impossible pour une livraison en statut "${liv.statut}".`);
  }
  if (liv.livreur_id !== newCourierId) {
    throw createHttpError(403, 'Vous n\'êtes pas le livreur assigné à cette livraison.');
  }

  const now = new Date().toISOString();

  // Le colis est récupéré → résoudre l'incident + reprendre la livraison
  const { error: updErr } = await db.from('livraisons').update({
    statut: DELIVERY_STATUSES.EN_ROUTE,
    incident_niveau: null,
    incident_depuis: null,
    incident_raison: 'Transfert réussi — nouveau livreur en route',
    updated_at: now,
  }).eq('id', deliveryId);
  if (updErr) throw updErr;

  await logAction(db, deliveryId, 'resoudre_incident', operateurNom, 'Transfert physique du colis confirmé. Nouveau livreur en route vers le client.');

  // Audit log
  await auditLog(db, {
    deliveryId,
    acteurId: newCourierId,
    acteurRole: 'livreur',
    action: 'transfer_completed',
    detail: 'Transfert physique du colis confirmé. Nouveau livreur en route vers le client.',
    statutAvant: DELIVERY_STATUSES.TRANSFERRING,
    statutApres: DELIVERY_STATUSES.EN_ROUTE,
    livreurAvantId: liv.livreur_id,
    livreurApresId: newCourierId,
    metadata: { transfer_confirmed_by: newCourierId },
  });

  const livraisonRef = `Livraison #${deliveryId.slice(0, 8)}`;

  // Notifier le client : votre colis est entre de bonnes mains
  if (liv.sous_commande_id) {
    try {
      const { data: sc } = await db.from('sous_commandes').select('commande_id').eq('id', liv.sous_commande_id).maybeSingle();
      if (sc?.commande_id) {
        const { data: cmd } = await db.from('commandes').select('client_id').eq('id', sc.commande_id).maybeSingle();
        if (cmd?.client_id) {
          await notifyUserSafe(db, {
            utilisateurId: cmd.client_id,
            type: 'livraison_transfert_ok',
            titre: '📦 Votre colis est en route',
            corps: 'Votre colis a été récupéré par le nouveau livreur. Livraison en cours.',
            data: { livraison_id: deliveryId, action: 'open_order_tracking' },
          });
        }
      }
    } catch { /* swallow */ }
  }

  // Notifier le commerce
  const vendorUserId = await resolveVendorUserId(db, liv.restaurant_id, liv.boutique_id);
  if (vendorUserId) {
    await notifyUserSafe(db, {
      utilisateurId: vendorUserId,
      type: 'livraison_transfert_ok',
      titre: '✅ Transfert réussi',
      corps: `${livraisonRef} : le nouveau livreur a récupéré le colis. Livraison en cours.`,
      data: { livraison_id: deliveryId, action: 'vendor_delivery' },
    });
  }

  return { success: true, status: DELIVERY_STATUSES.EN_ROUTE };
}


// ════════════════════════════════════════════════════════════════════════════
// 4. RÉATTRIBUTION CROSS-COMPANY (GoLivra assigne à une autre entreprise)
// ════════════════════════════════════════════════════════════════════════════

/**
 * GoLivra réattribue la livraison à une autre entreprise partenaire.
 * → L'entreprise A ne peut plus gérer
 * → GoLivra cherche une entreprise B avec des livreurs disponibles
 * → B accepte la mission → transfert physique du colis
 * → Pas de remboursement (la livraison continue)
 */
async function reassignCrossCompany(db, deliveryId, newCompanyId, newCourierId, operateurNom) {
  const { data: liv, error } = await db
    .from('livraisons')
    .select('*')
    .eq('id', deliveryId)
    .maybeSingle();
  if (error) throw error;
  if (!liv) throw createHttpError(404, 'Livraison introuvable.');

  const now = new Date().toISOString();
  const colisRecupere = !!liv.collectee_at;
  const oldCompanyId = liv.entreprise_logistique_id;

  // Mettre à jour la livraison : nouvelle entreprise + nouveau livreur
  const patch = {
    entreprise_logistique_id: newCompanyId,
    livreur_id: newCourierId,
    statut: colisRecupere ? DELIVERY_STATUSES.TRANSFERRING : DELIVERY_STATUSES.REASSIGNING,
    updated_at: now,
  };
  const { error: updErr } = await db.from('livraisons').update(patch).eq('id', deliveryId);
  if (updErr) throw updErr;

  await logAction(db, deliveryId, 'reassigner', operateurNom,
    `Réattribution cross-company : entreprise ${newCompanyId.slice(0, 8)}. ${colisRecupere ? 'Transfert physique nécessaire.' : 'Colis pas encore récupéré.'}`);

  const livraisonRef = `Livraison #${deliveryId.slice(0, 8)}`;

  // Notifier l'ancienne entreprise (elle est libérée)
  if (oldCompanyId) {
    try {
      const { data: oldCompany } = await db.from('entreprises_logistiques').select('gestionnaire_id').eq('id', oldCompanyId).maybeSingle();
      if (oldCompany?.gestionnaire_id) {
        await notifyUserSafe(db, {
          utilisateurId: oldCompany.gestionnaire_id,
          type: 'livraison_reassignee',
          titre: '🔄 Livraison réattribuée à une autre entreprise',
          corps: `${livraisonRef} a été réattribuée à une autre entreprise logistique. Vous êtes libéré de cette course.`,
          data: { livraison_id: deliveryId, action: 'courier_missions' },
        });
      }
    } catch { /* swallow */ }
  }

  // Notifier la nouvelle entreprise
  try {
    const { data: newCompany } = await db.from('entreprises_logistiques').select('gestionnaire_id').eq('id', newCompanyId).maybeSingle();
    if (newCompany?.gestionnaire_id) {
      await notifyUserSafe(db, {
        utilisateurId: newCompany.gestionnaire_id,
        type: 'livraison_reassignee',
        titre: '📦 Nouvelle livraison assignée par GoLivra',
        corps: `${livraisonRef} : GoLivra vous a assigné cette livraison. ${colisRecupere ? 'Un transfert de colis est nécessaire.' : 'Récupérez la commande chez le commerce.'}`,
        data: { livraison_id: deliveryId, action: 'vendor_delivery' },
      });
    }
  } catch { /* swallow */ }

  // Notifier le nouveau livreur
  try {
    const courierUserId = await resolveCourierUserId(db, newCourierId);
    if (courierUserId) {
      await notifyUserSafe(db, {
        utilizationId: courierUserId,
        type: 'livraison_reassignee',
        titre: '📦 Nouvelle course assignée par GoLivra',
        corps: colisRecupere
          ? `${livraisonRef} : un transfert de colis est nécessaire. Rendez-vous chez le livreur précédent."
          : `${livraisonRef} : vous avez été assigné à cette livraison. Récupérez la commande chez le commerce.`,
        data: { livraison_id: deliveryId, action: 'courier_missions' },
      });
    }
  } catch { /* swallow */ }

  // Notifier le client
  if (liv.sous_commande_id) {
    try {
      const { data: sc } = await db.from('sous_commandes').select('commande_id').eq('id', liv.sous_commande_id).maybeSingle();
      if (sc?.commande_id) {
        const { data: cmd } = await db.from('commandes').select('client_id').eq('id', sc.commande_id).maybeSingle();
        if (cmd?.client_id) {
          await notifyUserSafe(db, {
            utilisateurId: cmd.client_id,
            type: 'livraison_reassignee',
            titre: '🚚 Un nouveau livreur prend en charge votre livraison',
            corps: 'Une nouvelle entreprise de livraison a été assignée. Votre livraison continue. Un léger retard supplémentaire est possible.',
            data: { livraison_id: deliveryId, action: 'open_order_tracking' },
          });
        }
      }
    } catch { /* swallow */ }
  }

  return { success: true, status: patch.statut, cross_company: true };
}


// ════════════════════════════════════════════════════════════════════════════
// 5. ANNULATION DÉFINITIVE (dernier recours — TOUTES les solutions épuisées)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Annulation définitive d'une livraison.
 * ⚠️ Cette fonction ne doit être appelée QUE si :
 *   - Le problème n'est pas résolu au niveau du livreur
 *   - Aucun autre livreur de la même entreprise n'est disponible
 *   - Aucune autre entreprise partenaire ne peut reprendre
 *
 * → Met à jour sous_commande si applicable
 * → Recalcule le statut de la commande parente
 * → Notifie toutes les parties
 * → Vérifie l'éligibilité au remboursement (pas de remboursement automatique)
 */
async function cancelDeliveryDefinitive(db, deliveryId, raison, operateurNom) {
  const { data: liv, error } = await db
    .from('livraisons')
    .select('*')
    .eq('id', deliveryId)
    .maybeSingle();
  if (error) throw error;
  if (!liv) throw createHttpError(404, 'Livraison introuvable.');

  const now = new Date().toISOString();

  // 1. Annuler la livraison
  const { error: updErr } = await db.from('livraisons').update({
    statut: DELIVERY_STATUSES.ANNULEE,
    annulee_at: now,
    incident_niveau: null,
    incident_depuis: null,
    incident_raison: raison || 'Annulée définitivement',
    updated_at: now,
  }).eq('id', deliveryId);
  if (updErr) throw updErr;

  await logAction(db, deliveryId, 'annuler_livraison', operateurNom, raison);

  // Audit log
  await auditLog(db, {
    deliveryId,
    acteurId: operateurNom,
    acteurRole: 'gestionnaire',
    action: 'delivery_cancelled_definitive',
    detail: raison || 'Annulée définitivement — toutes les solutions épuisées',
    statutAvant: liv.statut,
    statutApres: DELIVERY_STATUSES.ANNULEE,
    livreurAvantId: liv.livreur_id,
    livreurApresId: null,
    metadata: { raison, solutions_epuisees: true },
  });

  // 2. Mettre à jour la sous_commande si applicable
  let sousCommandeId = liv.sous_commande_id;
  if (sousCommandeId) {
    try {
      const { error: scErr } = await db.from('sous_commandes').update({
        statut: 'annulee',
        updated_at: now,
      }).eq('id', sousCommandeId);
      if (scErr) console.warn('[incident-workflow] Erreur maj sous_commande:', scErr.message);

      // 3. Recalculer le statut de la commande parente
      const { data: sc } = await db.from('sous_commandes').select('commande_id').eq('id', sousCommandeId).maybeSingle();
      if (sc?.commande_id) {
        await recomputeOrderStatus(db, sc.commande_id);
      }
    } catch { /* swallow */ }
  }

  // 4. Notifier toutes les parties
  const livraisonRef = `Livraison #${deliveryId.slice(0, 8)}`;

  // Livreur
  if (liv.livreur_id) {
    try {
      const courierUserId = await resolveCourierUserId(db, liv.livreur_id);
      if (courierUserId) {
        await notifyUserSafe(db, {
          utilisateurId: courierUserId,
          type: 'livraison_annulee',
          titre: '❌ Livraison annulée',
          corps: `${livraisonRef} a été annulée définitivement. Vous êtes libre pour une nouvelle course.`,
          data: { livraison_id: deliveryId, action: 'courier_missions' },
        });
      }
    } catch { /* swallow */ }
  }

  // Commerce
  const vendorUserId = await resolveVendorUserId(db, liv.restaurant_id, liv.boutique_id);
  if (vendorUserId) {
    await notifyUserSafe(db, {
      utilisateurId: vendorUserId,
      type: 'livraison_annulee',
      titre: '❌ Livraison annulée',
      corps: `${livraisonRef} a été annulée. Raison : ${raison || 'Non précisée'}.`,
      data: { livraison_id: deliveryId, action: 'vendor_delivery' },
    });
  }

  // Client
  if (liv.sous_commande_id) {
    try {
      const { data: sc } = await db.from('sous_commandes').select('commande_id').eq('id', liv.sous_commande_id).maybeSingle();
      if (sc?.commande_id) {
        const { data: cmd } = await db.from('commandes').select('client_id, statut').eq('id', sc.commande_id).maybeSingle();
        if (cmd?.client_id) {
          const alreadyRefunded = cmd.statut === 'remboursee' || cmd.statut === 'annulee';
          await notifyUserSafe(db, {
            utilisateurId: cmd.client_id,
            type: 'livraison_annulee',
            titre: '❌ Livraison annulée',
            corps: alreadyRefunded
              ? `${livraisonRef} a été annulée. Un remboursement est en cours de traitement.`
              : `${livraisonRef} a été annulée. ${raison || ''} Contactez le support pour plus d'informations.`,
            data: { livraison_id: deliveryId, action: 'open_order_tracking' },
          });
        }
      }
    } catch { /* swallow */ }
  }

  // 5. Vérifier éligibilité au remboursement
  let remboursement_declenche = false;
  if (liv.sous_commande_id) {
    try {
      const { data: sc } = await db.from('sous_commandes')
        .select('commande_id, statut_paiement')
        .eq('id', liv.sous_commande_id)
        .maybeSingle();
      if (sc?.statut_paiement === 'paye') {
        // Le client a payé mais la livraison est annulée → remboursement éligible
        remboursement_declenche = true;
        console.log(`[incident-workflow] Livraison ${deliveryId.slice(0, 8)} annulée — remboursement éligible`);
      }
    } catch { /* swallow */ }
  }

  return { success: true, remboursement_declenche };
}


// ════════════════════════════════════════════════════════════════════════════
// 5. RÉSOLUTION SIMPLE (le problème est réglé, le livreur peut continuer)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Résolution d'un incident sans changement de livreur.
 * → Le livreur reprend la livraison normalement
 */
async function resolveIncidentSimple(db, deliveryId, resolution, operateurNom) {
  const { data: liv, error } = await db
    .from('livraisons')
    .select('*')
    .eq('id', deliveryId)
    .maybeSingle();
  if (error) throw error;
  if (!liv) throw createHttpError(404, 'Livraison introuvable.');

  // Reprendre le statut d'avant l'incident
  let resumedStatus = DELIVERY_STATUSES.EN_ROUTE;
  if (liv.collectee_at && !liv.livree_at) resumedStatus = DELIVERY_STATUSES.EN_ROUTE;
  else if (liv.attribuee_at && !liv.collectee_at) resumedStatus = DELIVERY_STATUSES.EN_COLLECTE;

  const now = new Date().toISOString();
  const { error: updErr } = await db.from('livraisons').update({
    statut: resumedStatus,
    incident_niveau: null,
    incident_depuis: null,
    incident_raison: resolution || 'Résolu par opérateur',
    updated_at: now,
  }).eq('id', deliveryId);
  if (updErr) throw updErr;

  await logAction(db, deliveryId, 'resoudre_incident', operateurNom, resolution);

  const livraisonRef = `Livraison #${deliveryId.slice(0, 8)}`;

  // Notifier le livreur
  if (liv.livreur_id) {
    try {
      const courierUserId = await resolveCourierUserId(db, liv.livreur_id);
      if (courierUserId) {
        await notifyUserSafe(db, {
          utilisateurId: courierUserId,
          type: 'livraison_incident_resolu',
          titre: '✅ Incident résolu',
          corps: `${livraisonRef} : le problème est résolu. Continuez la livraison normalement.`,
          data: { livraison_id: deliveryId, action: 'courier_missions' },
        });
      }
    } catch { /* swallow */ }
  }

  // Notifier le client
  if (liv.sous_commande_id) {
    try {
      const { data: sc } = await db.from('sous_commandes').select('commande_id').eq('id', liv.sous_commande_id).maybeSingle();
      if (sc?.commande_id) {
        const { data: cmd } = await db.from('commandes').select('client_id').eq('id', sc.commande_id).maybeSingle();
        if (cmd?.client_id) {
          await notifyUserSafe(db, {
            utilisateurId: cmd.client_id,
            type: 'livraison_incident_resolu',
            titre: '✅ Votre livraison reprend',
            corps: 'Le problème a été résolu. Votre livreur continue la livraison.',
            data: { livraison_id: deliveryId, action: 'open_order_tracking' },
          });
        }
      }
    } catch { /* swallow */ }
  }

  return { success: true, status: resumedStatus };
}


// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Recalcule le statut de la commande parente à partir de ses sous_commandes.
 */
async function recomputeOrderStatus(db, orderId) {
  try {
    const { data: scs } = await db.from('sous_commandes').select('statut').eq('commande_id', orderId);
    if (!scs || scs.length === 0) return;

    const statuts = scs.map((s) => s.statut);
    let next = 'en_preparation';

    if (statuts.every((s) => s === 'remboursee')) next = 'remboursee';
    else if (statuts.every((s) => s === 'livree')) next = 'livree';
    else if (statuts.every((s) => s === 'annulee' || s === 'refusee' || s === 'remboursee')) next = 'annulee';
    else if (statuts.some((s) => s === 'livree')) next = 'partiellement_livree';
    else if (statuts.some((s) => s === 'collectee')) next = 'en_livraison';
    else if (statuts.some((s) => s === 'prete')) next = 'prete';
    else if (statuts.some((s) => s === 'en_preparation')) next = 'en_preparation';
    else if (statuts.every((s) => s === 'acceptee')) next = 'acceptee';
    else if (statuts.some((s) => s === 'acceptee')) next = 'partiellement_acceptee';

    const now = new Date().toISOString();
    const patch = { statut: next, updated_at: now };
    if (next === 'livree') patch.livree_at = now;
    if (next === 'remboursee') patch.expiree_at = now;

    await db.from('commandes').update(patch).eq('id', orderId);
  } catch (err) {
    console.warn('[incident-workflow] Erreur recomputeOrderStatus:', err?.message || err);
  }
}


module.exports = {
  DELIVERY_STATUSES,
  PROBLEM_REASONS,
  reportProblemFromCourier,
  reassignDelivery,
  reassignCrossCompany,
  confirmTransfer,
  cancelDeliveryDefinitive,
  resolveIncidentSimple,
  recomputeOrderStatus,
  auditLog,
};
