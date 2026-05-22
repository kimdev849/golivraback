const { createHttpError } = require('../utils/http');
const { getPricingConfig, splitDeliveryFee } = require('./pricing.service');

const ACTIVE_MISSION_STATUTS = ['attribuee', 'en_collecte', 'collectee', 'en_route'];
const { formatAddressText } = require('./address.service');

/** Une seule livraison active par sous-commande (évite erreurs maybeSingle + doublons livreur). */
async function findLivraisonBySousCommande(db, sousCommandeId) {
  const { data, error } = await db
    .from('livraisons')
    .select('*')
    .eq('sous_commande_id', sousCommandeId)
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

/** Annule les doublons « en attente » pour la même sous-commande (garde keepId). */
async function cancelDuplicateOpenLivraisons(db, sousCommandeId, keepId) {
  if (!sousCommandeId || !keepId) return;
  let { error } = await db
    .from('livraisons')
    .update({ statut: 'annulee' })
    .eq('sous_commande_id', sousCommandeId)
    .eq('statut', 'en_attente')
    .is('livreur_id', null)
    .neq('id', keepId);
  if (error && String(error.code) === '42703') {
    ({ error } = await db
      .from('livraisons')
      .update({ statut: 'annulee' })
      .eq('sous_commande_id', sousCommandeId)
      .eq('statut', 'en_attente')
      .neq('id', keepId));
  }
  if (error) throw error;
}

function dedupeOpenDeliveries(rows) {
  const bySous = new Map();
  const externe = [];
  for (const liv of rows || []) {
    if (!liv.sous_commande_id) {
      externe.push(liv);
      continue;
    }
    const key = liv.sous_commande_id;
    const prev = bySous.get(key);
    if (!prev) {
      bySous.set(key, liv);
      continue;
    }
    const prevTs = new Date(prev.created_at || 0).getTime();
    const curTs = new Date(liv.created_at || 0).getTime();
    if (curTs < prevTs) bySous.set(key, liv);
  }
  return [...externe, ...bySous.values()];
}

/** Crée la livraison interne quand la sous-commande passe « prête », puis assigne un livreur GoLivra. */
async function ensureLivraisonOnSousCommandeReady(db, sousCommandeId) {
  const { data: sc, error: scErr } = await db
    .from('sous_commandes')
    .select('*')
    .eq('id', sousCommandeId)
    .maybeSingle();
  if (scErr) throw scErr;
  if (!sc) return null;

  if ((sc.mode_livraison || 'golivra') !== 'golivra') {
    return null;
  }

  const existing = await findLivraisonBySousCommande(db, sousCommandeId);
  if (existing) {
    if (existing.id) {
      await cancelDuplicateOpenLivraisons(db, sousCommandeId, existing.id).catch(() => {});
    }
    return existing;
  }

  const { data: commande, error: cErr } = await db
    .from('commandes')
    .select('id, adresse_livraison_snapshot')
    .eq('id', sc.commande_id)
    .maybeSingle();
  if (cErr) throw cErr;

  const { collecte, livraison } = await buildAddressSnapshots(db, sc, commande);
  const fraisLivraison = Number(sc.frais_livraison ?? 0);
  const config = await getPricingConfig(db);
  const deliverySplit = splitDeliveryFee(fraisLivraison, config);

  if (livraison && typeof livraison === 'object') {
    livraison.payeur_type = 'client';
    livraison.createur_type = 'client';
    livraison.montant_livraison = fraisLivraison;
    livraison.split_livraison = {
      logistics_percent: config.delivery_logistics_percent,
      platform_percent: config.delivery_platform_percent,
      logistics_fcfa: deliverySplit.logistics,
      platform_fcfa: deliverySplit.platform,
    };
  }

  const { data: created, error: insErr } = await db
    .from('livraisons')
    .insert({
      type_livraison: 'commande',
      sous_commande_id: sousCommandeId,
      statut: 'en_attente',
      adresse_collecte_snapshot: collecte,
      adresse_livraison_snapshot: livraison,
      montant_livreur: 0,
      commission_logistique: deliverySplit.logistics,
      latitude_collecte: null,
      longitude_collecte: null,
      latitude_livraison: null,
      longitude_livraison: null,
      livreur_id: null,
      entreprise_logistique_id: null,
    })
    .select('*')
    .single();
  if (insErr) {
    if (insErr.code === '23505') {
      const again = await findLivraisonBySousCommande(db, sousCommandeId);
      if (again) return again;
    }
    throw insErr;
  }

  await cancelDuplicateOpenLivraisons(db, sousCommandeId, created.id).catch(() => {});

  return created;
}

async function buildAddressSnapshots(db, sc, commande) {
  let collecte = null;
  if (sc.restaurant_id) {
    const { data: r } = await db
      .from('restaurants')
      .select('nom, adresse_ligne1, adresse_quartier, adresse_ville')
      .eq('id', sc.restaurant_id)
      .maybeSingle();
    if (r) {
      const texte = [r.nom, r.adresse_quartier, r.adresse_ligne1, r.adresse_ville].filter(Boolean).join(' · ');
      collecte = {
        version: 2,
        texte,
        quartier: r.adresse_quartier || null,
        ligne1: r.adresse_ligne1 || null,
        ville: r.adresse_ville || 'Brazzaville',
        pays: 'Congo',
      };
    }
  }
  if (sc.boutique_id) {
    const { data: b } = await db
      .from('boutiques')
      .select('nom, adresse_ligne1, adresse_quartier, adresse_ville')
      .eq('id', sc.boutique_id)
      .maybeSingle();
    if (b) {
      const texte = [b.nom, b.adresse_quartier, b.adresse_ligne1, b.adresse_ville].filter(Boolean).join(' · ');
      collecte = {
        version: 2,
        texte,
        quartier: b.adresse_quartier || null,
        ligne1: b.adresse_ligne1 || null,
        ville: b.adresse_ville || 'Brazzaville',
        pays: 'Congo',
      };
    }
  }

  const snap = commande?.adresse_livraison_snapshot;
  if (snap && typeof snap === 'object' && snap.texte) {
    return {
      collecte,
      livraison: {
        ...snap,
        payeur_type: 'client',
      },
    };
  }
  if (typeof snap === 'string' && snap.trim()) {
    return { collecte, livraison: { version: 1, texte: snap.trim(), payeur_type: 'client' } };
  }

  return { collecte, livraison: null };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return Number.POSITIVE_INFINITY;
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function getBusyCourierIds(db) {
  const { data: active, error } = await db
    .from('livraisons')
    .select('livreur_id')
    .in('statut', ACTIVE_MISSION_STATUTS)
    .not('livreur_id', 'is', null);
  if (error) throw error;
  return new Set((active || []).map((r) => r.livreur_id));
}

async function courierHasActiveMission(db, livreurId) {
  const busy = await getBusyCourierIds(db);
  return busy.has(livreurId);
}

/** Livreur en ligne, approuvé, sans course en cours (= disponible pour une nouvelle mission). */
async function listAvailableCouriers(db) {
  const { data: livreurs, error } = await db
    .from('livreurs')
    .select(
      'id, type_vehicule, entreprise_logistique_id, nb_livraisons_total, utilisateur_id, est_disponible, est_approuve, disponibilite_bloquee_entreprise',
    )
    .eq('est_disponible', true)
    .eq('est_approuve', true)
    .eq('disponibilite_bloquee_entreprise', false);
  if (error) throw error;

  const busyIds = await getBusyCourierIds(db);

  const userIds = [...new Set((livreurs || []).map((l) => l.utilisateur_id))];
  const { data: users } = userIds.length
    ? await db.from('utilisateurs').select('id, est_actif').in('id', userIds)
    : { data: [] };
  const activeUserIds = new Set((users || []).filter((u) => u.est_actif !== false).map((u) => u.id));

  return (livreurs || [])
    .filter((l) => activeUserIds.has(l.utilisateur_id) && !busyIds.has(l.id))
    .sort((a, b) => Number(a.nb_livraisons_total ?? 0) - Number(b.nb_livraisons_total ?? 0));
}

async function listOpenDeliveries(db) {
  const { data: livraisons, error } = await db
    .from('livraisons')
    .select('*')
    .is('livreur_id', null)
    .eq('statut', 'en_attente')
    .order('created_at', { ascending: true });
  if (error) throw error;
  const deduped = dedupeOpenDeliveries(livraisons || []);
  const sousIds = [...new Set(deduped.map((r) => r.sous_commande_id).filter(Boolean))];
  if (sousIds.length === 0) return deduped;

  const { data: taken, error: tErr } = await db
    .from('livraisons')
    .select('sous_commande_id')
    .in('sous_commande_id', sousIds)
    .not('livreur_id', 'is', null)
    .not('statut', 'eq', 'annulee');
  if (tErr) return deduped;

  const takenSous = new Set((taken || []).map((t) => t.sous_commande_id));
  return deduped.filter((r) => !r.sous_commande_id || !takenSous.has(r.sous_commande_id));
}

/**
 * Commande « prête » : création livraison en attente + notification à tous les livreurs disponibles.
 */
async function onSousCommandeReady(db, sousCommandeId) {
  const created = await ensureLivraisonOnSousCommandeReady(db, sousCommandeId);
  if (!created) return null;
  if (created.livreur_id) return created;
  if (created.statut === 'en_attente') {
    const { notifyAvailableCouriersForDelivery } = require('./notification.service');
    await notifyAvailableCouriersForDelivery(db, created.id).catch(() => {});
  }
  return created;
}

/** Premier livreur qui accepte obtient la course (secours si assignation auto impossible). */
async function acceptOpenDelivery(db, livraisonId, livreurId) {
  const { acceptLivraisonForCourier } = require('./livraison-db');

  const { isMissingColumnError } = require('./livraison-db');
  let livreur;
  let lErr;
  ({ data: livreur, error: lErr } = await db
    .from('livreurs')
    .select('id, est_disponible, est_approuve, entreprise_logistique_id, utilisateur_id, disponibilite_bloquee_entreprise')
    .eq('id', livreurId)
    .maybeSingle());
  if (lErr && isMissingColumnError(lErr)) {
    ({ data: livreur, error: lErr } = await db
      .from('livreurs')
      .select('id, est_disponible, est_approuve, entreprise_logistique_id, utilisateur_id')
      .eq('id', livreurId)
      .maybeSingle());
  }
  if (lErr) throw lErr;
  if (!livreur) throw createHttpError(404, 'Livreur introuvable.');
  if (!livreur.est_disponible) throw createHttpError(403, 'Activez « recevoir des courses » pour accepter.');
  if (!livreur.est_approuve) throw createHttpError(403, 'Profil livreur non approuvé.');
  if (livreur.disponibilite_bloquee_entreprise === true) {
    throw createHttpError(403, 'Votre disponibilité est gérée par votre entreprise logistique.');
  }

  const { data: user } = await db
    .from('utilisateurs')
    .select('est_actif')
    .eq('id', livreur.utilisateur_id)
    .maybeSingle();
  if (user?.est_actif === false) throw createHttpError(403, 'Compte suspendu.');

  if (await courierHasActiveMission(db, livreurId)) {
    throw createHttpError(409, 'Terminez votre course en cours avant d’en accepter une autre.');
  }

  const data = await acceptLivraisonForCourier(db, livraisonId, livreur);

  if (data.sous_commande_id) {
    await cancelDuplicateOpenLivraisons(db, data.sous_commande_id, data.id).catch(() => {});
  }

  const { notifyDeliveryAccepted } = require('./order-notify.service');
  await notifyDeliveryAccepted(db, livraisonId).catch((err) => {
    console.warn('[notify] delivery accepted', livraisonId, err?.message || err);
  });

  return data;
}

const COURIER_STEP_TRANSITIONS = {
  attribuee: 'en_collecte',
  en_collecte: 'en_route',
};

/**
 * Avance le statut livraison (collecte → en route) et synchronise la sous-commande.
 */
async function advanceCourierDeliveryStep(db, livraisonId, livreurId) {
  const { advanceLivraisonStatut, isMissingColumnError } = require('./livraison-db');

  const { data: liv, error } = await db
    .from('livraisons')
    .select('*')
    .eq('id', livraisonId)
    .eq('livreur_id', livreurId)
    .maybeSingle();
  if (error) throw error;
  if (!liv) throw createHttpError(404, 'Livraison introuvable pour ce livreur.');

  const next = COURIER_STEP_TRANSITIONS[liv.statut];
  if (!next) {
    throw createHttpError(400, 'Aucune étape suivante pour cette livraison.');
  }

  const now = new Date().toISOString();
  const extra = next === 'en_route' ? { collectee_at: now } : {};
  const updated = await advanceLivraisonStatut(db, livraisonId, livreurId, next, extra);

  if (liv.sous_commande_id && next === 'en_collecte') {
    let scErr = null;
    ({ error: scErr } = await db
      .from('sous_commandes')
      .update({ statut: 'collectee', collectee_at: now, updated_at: now })
      .eq('id', liv.sous_commande_id));
    if (scErr && isMissingColumnError(scErr)) {
      ({ error: scErr } = await db
        .from('sous_commandes')
        .update({ statut: 'collectee' })
        .eq('id', liv.sous_commande_id));
    }
    if (scErr) throw scErr;
    const { data: sc } = await db
      .from('sous_commandes')
      .select('commande_id')
      .eq('id', liv.sous_commande_id)
      .maybeSingle();
    if (sc?.commande_id) {
      const { syncCommandeStatutFromSousCommandes } = require('./order.service');
      await syncCommandeStatutFromSousCommandes(db, sc.commande_id);
    }
  }

  const { notifyDeliveryStep } = require('./order-notify.service');
  await notifyDeliveryStep(db, livraisonId, next).catch((err) => {
    console.warn('[notify] delivery step', next, err?.message || err);
  });

  return updated;
}

/** Assignation automatique d’un livreur GoLivra (règle métier principale). */
async function autoAssignLivreur(db, livraisonId) {
  const { data: livraison, error } = await db.from('livraisons').select('*').eq('id', livraisonId).maybeSingle();
  if (error) throw error;
  if (!livraison) throw createHttpError(404, 'Livraison introuvable.');
  if (livraison.livreur_id) return livraison;
  if (livraison.statut === 'livree' || livraison.statut === 'annulee') return livraison;

  const couriers = await listAvailableCouriers(db);
  if (!couriers.length) return livraison;

  const picked = couriers[0];
  return assignLivreurToLivraison(db, livraisonId, picked.id, { source: 'systeme' });
}

async function assignLivreurManually(db, livraisonId, livreurId, source = 'admin') {
  const { data: liv } = await db.from('livreurs').select('id').eq('id', livreurId).maybeSingle();
  if (!liv) throw createHttpError(404, 'Livreur introuvable.');
  return assignLivreurToLivraison(db, livraisonId, livreurId, { source });
}

async function assignLivreurToLivraison(db, livraisonId, livreurId, { source } = {}) {
  const { data: livreur, error: lErr } = await db
    .from('livreurs')
    .select('id, entreprise_logistique_id, est_disponible, est_approuve')
    .eq('id', livreurId)
    .maybeSingle();
  if (lErr) throw lErr;
  if (!livreur) throw createHttpError(404, 'Livreur introuvable.');
  if (source === 'livreur' && !livreur.est_disponible) {
    throw createHttpError(403, 'Vous devez être disponible pour accepter une course.');
  }

  const { data: livraison, error: dErr } = await db
    .from('livraisons')
    .select('*')
    .eq('id', livraisonId)
    .maybeSingle();
  if (dErr) throw dErr;
  if (!livraison) throw createHttpError(404, 'Livraison introuvable.');
  if (livraison.statut === 'livree' || livraison.statut === 'annulee') {
    throw createHttpError(400, 'Cette livraison ne peut plus être modifiée.');
  }

  const now = new Date().toISOString();
  const { data, error } = await db
    .from('livraisons')
    .update({
      livreur_id: livreurId,
      entreprise_logistique_id: livreur.entreprise_logistique_id || null,
      statut: 'attribuee',
      attribuee_at: now,
    })
    .eq('id', livraisonId)
    .select('*')
    .single();
  if (error || !data) throw createHttpError(404, 'Livraison introuvable.');

  return data;
}

async function completeLivraisonAndSync(db, livraisonId, livreurId) {
  const { completeLivraisonRow, isMissingColumnError } = require('./livraison-db');
  const now = new Date().toISOString();
  const data = await completeLivraisonRow(db, livraisonId, livreurId);

  if (data.sous_commande_id) {
    let scErr = null;
    ({ error: scErr } = await db
      .from('sous_commandes')
      .update({ statut: 'livree', livree_at: now, updated_at: now })
      .eq('id', data.sous_commande_id));
    if (scErr && isMissingColumnError(scErr)) {
      ({ error: scErr } = await db
        .from('sous_commandes')
        .update({ statut: 'livree' })
        .eq('id', data.sous_commande_id));
    }
    if (scErr) throw scErr;

    const { data: sc } = await db
      .from('sous_commandes')
      .select('commande_id')
      .eq('id', data.sous_commande_id)
      .maybeSingle();
    if (sc?.commande_id) {
      const { syncCommandeStatutFromSousCommandes } = require('./order.service');
      await syncCommandeStatutFromSousCommandes(db, sc.commande_id);
    }
  }

  const { data: liv } = await db.from('livreurs').select('nb_livraisons_total, nb_livraisons_reussies').eq('id', livreurId).maybeSingle();
  if (liv) {
    await db
      .from('livreurs')
      .update({
        nb_livraisons_total: Number(liv.nb_livraisons_total ?? 0) + 1,
        nb_livraisons_reussies: Number(liv.nb_livraisons_reussies ?? 0) + 1,
      })
      .eq('id', livreurId);
  }

  const { settleDeliveryFeesOnComplete } = require('./wallet.service');
  await settleDeliveryFeesOnComplete(db, data).catch((err) => {
    console.error('[wallet] settleDeliveryFeesOnComplete', livraisonId, err?.message || err);
  });

  const { notifyDeliveryCompleted } = require('./order-notify.service');
  await notifyDeliveryCompleted(db, livraisonId).catch((err) => {
    console.warn('[notify] delivery completed', livraisonId, err?.message || err);
  });

  return data;
}

module.exports = {
  ensureLivraisonOnSousCommandeReady,
  autoAssignLivreur,
  assignLivreurManually,
  assignLivreurToLivraison,
  onSousCommandeReady,
  listAvailableCouriers,
  listOpenDeliveries,
  acceptOpenDelivery,
  advanceCourierDeliveryStep,
  completeLivraisonAndSync,
  courierHasActiveMission,
  getBusyCourierIds,
  haversineKm,
};
