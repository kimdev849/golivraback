const { getDb } = require('../config/db');
const { createHttpError, requireFields } = require('../utils/http');

async function getLivreurIdForUser(db, userId) {
  const { data: liv, error } = await db.from('livreurs').select('id').eq('utilisateur_id', userId).maybeSingle();
  if (error) throw error;
  if (!liv) throw createHttpError(404, 'Profil livreur introuvable');
  return liv.id;
}

function userImageUrl(user) {
  return user?.avatar_url && String(user.avatar_url).trim().startsWith('http')
    ? String(user.avatar_url).trim()
    : null;
}

function deliveryAddressFromSnapshot(snap) {
  if (snap && typeof snap === 'object' && snap.texte) return String(snap.texte);
  if (typeof snap === 'string') return snap;
  return '';
}

function startOfTodayIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

async function mapCourierMissionRow(db, liv) {
  const isExterne = liv.type_livraison === 'externe' || !liv.sous_commande_id;

  if (isExterne) {
    let adresseRetrait = deliveryAddressFromSnapshot(liv.adresse_collecte_snapshot);
    let commerceNom = '';
    if (liv.restaurant_id) {
      const { data: r } = await db
        .from('restaurants')
        .select('nom, adresse_ligne1')
        .eq('id', liv.restaurant_id)
        .maybeSingle();
      commerceNom = r?.nom || '';
      if (!adresseRetrait) adresseRetrait = r?.adresse_ligne1 || r?.nom || '';
    }
    if (liv.boutique_id) {
      const { data: b } = await db
        .from('boutiques')
        .select('nom, adresse_ligne1')
        .eq('id', liv.boutique_id)
        .maybeSingle();
      commerceNom = b?.nom || '';
      if (!adresseRetrait) adresseRetrait = b?.adresse_ligne1 || b?.nom || '';
    }

    return {
      id: liv.id,
      statut: liv.statut,
      type_livraison: 'externe',
      created_at: liv.created_at,
      attribuee_at: liv.attribuee_at,
      livree_at: liv.livree_at,
      adresse_livraison: deliveryAddressFromSnapshot(liv.adresse_livraison_snapshot),
      adresse_retrait: adresseRetrait,
      client_nom: liv.client_nom || null,
      client_telephone: liv.client_telephone || null,
      commerce_nom: commerceNom || null,
      montant_total: liv.montant_total != null ? Number(liv.montant_total) : null,
      note: liv.note || null,
      commande: null,
    };
  }

  const { data: sc } = await db.from('sous_commandes').select('*').eq('id', liv.sous_commande_id).maybeSingle();

  let commande = null;
  let adresseRetrait = '';
  if (sc?.commande_id) {
    const { data: c } = await db
      .from('commandes')
      .select('id, numero, statut')
      .eq('id', sc.commande_id)
      .maybeSingle();
    commande = c;
  }
  if (sc?.restaurant_id) {
    const { data: r } = await db
      .from('restaurants')
      .select('nom, adresse_ligne1')
      .eq('id', sc.restaurant_id)
      .maybeSingle();
    adresseRetrait = r?.adresse_ligne1 || r?.nom || '';
  }
  if (sc?.boutique_id) {
    const { data: b } = await db
      .from('boutiques')
      .select('nom, adresse_ligne1')
      .eq('id', sc.boutique_id)
      .maybeSingle();
    adresseRetrait = b?.adresse_ligne1 || b?.nom || '';
  }

  return {
    id: liv.id,
    statut: liv.statut,
    type_livraison: 'commande',
    created_at: liv.created_at,
    attribuee_at: liv.attribuee_at,
    livree_at: liv.livree_at,
    adresse_livraison: deliveryAddressFromSnapshot(liv.adresse_livraison_snapshot),
    adresse_retrait: adresseRetrait,
    commande,
  };
}

async function getDeliveryStatus(req, res, next) {
  try {
    const { orderId } = req.params;
    const db = getDb();

    const { data: order, error: orderError } = await db
      .from('commandes')
      .select('id, statut, created_at, client_id')
      .eq('id', orderId)
      .single();
    if (orderError || !order) throw createHttpError(404, 'Commande introuvable');

    const role = req.auth.role;
    if (role === 'admin') {
      /* ok */
    } else if (role === 'client' && order.client_id !== req.auth.userId) {
      throw createHttpError(403, 'Accès à cette commande non autorisé');
    } else if (role === 'restaurateur' || role === 'commercant') {
      const owned = await findVendorSousCommandeIdsForOrder(db, req.auth.userId, orderId);
      if (owned.length === 0) throw createHttpError(403, 'Accès à cette commande non autorisé');
    } else if (role === 'livreur') {
      const livreurId = await getLivreurIdForUser(db, req.auth.userId);
      const { data: scs } = await db.from('sous_commandes').select('id').eq('commande_id', orderId);
      const ids = (scs || []).map((s) => s.id);
      const { data: livs } = await db.from('livraisons').select('id').in('sous_commande_id', ids).eq('livreur_id', livreurId);
      if (!livs || livs.length === 0) throw createHttpError(403, 'Accès à cette commande non autorisé');
    }

    const { data: scs } = await db.from('sous_commandes').select('id').eq('commande_id', orderId);
    const scIds = (scs || []).map((s) => s.id);
    const { data: deliveries } = await db.from('livraisons').select('*').in('sous_commande_id', scIds);

    const delivery = deliveries && deliveries[0] ? deliveries[0] : null;

    return res.json({
      orderId: order.id,
      orderStatus: order.statut,
      delivery,
      deliveries: deliveries || [],
      createdAt: order.created_at,
    });
  } catch (error) {
    return next(error);
  }
}

async function findVendorSousCommandeIdsForOrder(db, userId, commandeId) {
  const { data: scs, error } = await db
    .from('sous_commandes')
    .select('id, restaurant_id, boutique_id')
    .eq('commande_id', commandeId);
  if (error) throw error;

  const owned = [];
  for (const sc of scs || []) {
    if (sc.restaurant_id) {
      const { data: r } = await db.from('restaurants').select('proprietaire_id').eq('id', sc.restaurant_id).maybeSingle();
      if (r?.proprietaire_id === userId) owned.push(sc.id);
    }
    if (sc.boutique_id) {
      const { data: b } = await db.from('boutiques').select('proprietaire_id').eq('id', sc.boutique_id).maybeSingle();
      if (b?.proprietaire_id === userId) owned.push(sc.id);
    }
  }
  return owned;
}

async function getCourierProfile(req, res, next) {
  try {
    const db = getDb();
    const userId = req.auth.userId;

    const { data: livreur, error: livErr } = await db
      .from('livreurs')
      .select(
        'id, type_vehicule, est_disponible, est_approuve, nb_livraisons_total, nb_livraisons_reussies, plaque_immatriculation, entreprise_logistique_id, created_at',
      )
      .eq('utilisateur_id', userId)
      .maybeSingle();
    if (livErr) throw livErr;
    if (!livreur) throw createHttpError(404, 'Profil livreur introuvable');

    const { data: utilisateur, error: userErr } = await db
      .from('utilisateurs')
      .select('id, nom, telephone, email, est_actif, avatar_url')
      .eq('id', userId)
      .maybeSingle();
    if (userErr) throw userErr;

    let entreprise = null;
    if (livreur.entreprise_logistique_id) {
      const { data: c } = await db
        .from('entreprises_logistiques')
        .select('id, nom, telephone')
        .eq('id', livreur.entreprise_logistique_id)
        .maybeSingle();
      entreprise = c;
    }

    const { courierHasActiveMission } = require('../services/dispatch.service');
    const { data: missions } = await db.from('livraisons').select('id, statut, created_at').eq('livreur_id', livreur.id);
    const todayStart = startOfTodayIso();
    const activeStatuses = new Set(['attribuee', 'en_collecte', 'collectee', 'en_route']);
    const rows = missions || [];
    const enMission = await courierHasActiveMission(db, livreur.id);
    const missionsActives = enMission
      ? rows.filter((m) => activeStatuses.has(m.statut)).length || 1
      : rows.filter((m) => activeStatuses.has(m.statut)).length;
    const missionsAujourdhui = rows.filter((m) => m.created_at >= todayStart).length;

    return res.json({
      livreur: {
        id: livreur.id,
        type_vehicule: livreur.type_vehicule,
        est_disponible: livreur.est_disponible,
        statut_operationnel: enMission ? 'en_mission' : livreur.est_disponible ? 'disponible' : 'hors_ligne',
        est_approuve: livreur.est_approuve,
        nb_livraisons_total: livreur.nb_livraisons_total,
        nb_livraisons_reussies: livreur.nb_livraisons_reussies,
        plaque_immatriculation: livreur.plaque_immatriculation,
        created_at: livreur.created_at,
      },
      utilisateur: {
        id: utilisateur?.id,
        nom: utilisateur?.nom ?? null,
        telephone: utilisateur?.telephone ?? null,
        email: utilisateur?.email ?? null,
        est_actif: utilisateur?.est_actif !== false,
        imageUrl: userImageUrl(utilisateur),
      },
      entreprise,
      resume: {
        missions_actives: missionsActives,
        missions_aujourdhui: missionsAujourdhui,
        total_historique: Number(livreur.nb_livraisons_total ?? 0),
        reussies_historique: Number(livreur.nb_livraisons_reussies ?? 0),
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function listCourierMissions(req, res, next) {
  try {
    const db = getDb();
    const courierId = await getLivreurIdForUser(db, req.auth.userId);
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const scope = typeof req.query.scope === 'string' ? req.query.scope.trim() : 'all';

    const { listOpenDeliveries, courierHasActiveMission } = require('../services/dispatch.service');

    const { data: livreur } = await db
      .from('livreurs')
      .select('est_disponible, est_approuve, latitude_actuelle, longitude_actuelle')
      .eq('id', courierId)
      .maybeSingle();

    const out = [];
    const seen = new Set();

    const canSeeOpen =
      scope !== 'mine' &&
      livreur?.est_disponible &&
      livreur?.est_approuve &&
      !(await courierHasActiveMission(db, courierId));

    if (canSeeOpen) {
      const open = await listOpenDeliveries(db);
      for (const liv of open) {
        if (status && liv.statut !== status) continue;
        seen.add(liv.id);
        const row = await mapCourierMissionRow(db, liv);
        out.push({ ...row, ouverte: true });
      }
    }

    if (scope !== 'open') {
      let query = db
        .from('livraisons')
        .select('*')
        .eq('livreur_id', courierId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (status) query = query.eq('statut', status);

      const { data: livraisons, error } = await query;
      if (error) throw error;

      for (const liv of livraisons || []) {
        if (seen.has(liv.id)) continue;
        const row = await mapCourierMissionRow(db, liv);
        out.push({ ...row, ouverte: false });
      }
    }

    return res.json(out);
  } catch (error) {
    return next(error);
  }
}

async function updateCourierAvailability(req, res, next) {
  try {
    requireFields(req.body, ['disponible']);
    const db = getDb();
    const courierId = await getLivreurIdForUser(db, req.auth.userId);
    const disponible = Boolean(req.body.disponible);

    const { data: livreur, error: lErr } = await db
      .from('livreurs')
      .select('id, est_approuve, disponibilite_bloquee_entreprise, utilisateur_id')
      .eq('id', courierId)
      .maybeSingle();
    if (lErr) throw lErr;
    if (!livreur) throw createHttpError(404, 'Profil livreur introuvable');

    const { data: user } = await db
      .from('utilisateurs')
      .select('est_actif')
      .eq('id', livreur.utilisateur_id)
      .maybeSingle();
    if (user?.est_actif === false) {
      throw createHttpError(403, 'Compte suspendu — contactez votre entreprise.');
    }

    if (disponible) {
      if (!livreur.est_approuve) {
        throw createHttpError(403, 'Profil livreur en attente d\'approbation.');
      }
      if (livreur.disponibilite_bloquee_entreprise) {
        throw createHttpError(
          403,
          'Votre entreprise logistique vous a désactivé. Contactez-la pour repasser en ligne.',
        );
      }
    }

    const { data, error } = await db
      .from('livreurs')
      .update({ est_disponible: disponible })
      .eq('id', courierId)
      .select('*')
      .single();
    if (error) throw error;

    return res.json(data);
  } catch (error) {
    return next(error);
  }
}

async function updateCourierPosition(req, res, next) {
  try {
    requireFields(req.body, ['latitude', 'longitude']);
    const db = getDb();
    const courierId = await getLivreurIdForUser(db, req.auth.userId);

    await db
      .from('livreurs')
      .update({
        latitude_actuelle: req.body.latitude,
        longitude_actuelle: req.body.longitude,
        derniere_position_at: new Date().toISOString(),
      })
      .eq('id', courierId);

    const { data, error } = await db
      .from('positions_livreurs')
      .insert({
        livreur_id: courierId,
        latitude: req.body.latitude,
        longitude: req.body.longitude,
      })
      .select('*')
      .single();
    if (error) throw error;

    return res.status(201).json(data);
  } catch (error) {
    return next(error);
  }
}

async function acceptDelivery(req, res, next) {
  try {
    const { deliveryId } = req.params;
    const db = getDb();
    const courierId = await getLivreurIdForUser(db, req.auth.userId);

    const { acceptOpenDelivery } = require('../services/dispatch.service');
    const data = await acceptOpenDelivery(db, deliveryId, courierId);
    return res.json(await mapCourierMissionRow(db, data));
  } catch (error) {
    return next(error);
  }
}

async function completeDelivery(req, res, next) {
  try {
    const { deliveryId } = req.params;
    const db = getDb();
    const courierId = await getLivreurIdForUser(db, req.auth.userId);

    const { completeLivraisonAndSync } = require('../services/dispatch.service');
    const data = await completeLivraisonAndSync(db, deliveryId, courierId);
    return res.json(await mapCourierMissionRow(db, data));
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getDeliveryStatus,
  getCourierProfile,
  listCourierMissions,
  updateCourierAvailability,
  updateCourierPosition,
  acceptDelivery,
  completeDelivery,
};
