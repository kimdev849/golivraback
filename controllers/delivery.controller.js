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
      proof_photo_url: liv.proof_photo_url || null,
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
  let commerceNom = null;
  if (sc?.restaurant_id) {
    const { data: r } = await db
      .from('restaurants')
      .select('nom, adresse_ligne1')
      .eq('id', sc.restaurant_id)
      .maybeSingle();
    commerceNom = r?.nom ?? null;
    adresseRetrait = r?.adresse_ligne1 || r?.nom || '';
  }
  if (sc?.boutique_id) {
    const { data: b } = await db
      .from('boutiques')
      .select('nom, adresse_ligne1')
      .eq('id', sc.boutique_id)
      .maybeSingle();
    commerceNom = b?.nom ?? null;
    adresseRetrait = b?.adresse_ligne1 || b?.nom || '';
  }

  return {
    id: liv.id,
    statut: liv.statut,
    type_livraison: 'commande',
    sous_commande_id: liv.sous_commande_id,
    created_at: liv.created_at,
    attribuee_at: liv.attribuee_at,
    livree_at: liv.livree_at,
    adresse_livraison: deliveryAddressFromSnapshot(liv.adresse_livraison_snapshot),
    adresse_retrait: adresseRetrait,
    commerce_nom: commerceNom,
    proof_photo_url: liv.proof_photo_url || null,
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

const DELIVERY_TIMELINE_STEPS = [
  { key: 'attribuee', titre: 'Livreur assigné', field: 'attribuee_at' },
  { key: 'en_collecte', titre: 'En route vers le commerce', field: 'attribuee_at' },
  { key: 'collectee', titre: 'Commande récupérée', field: 'collectee_at' },
  { key: 'en_route', titre: 'En route vers le client', field: 'collectee_at' },
  { key: 'livree', titre: 'Livraison terminée', field: 'livree_at' },
];

const DELIVERY_STATUS_ORDER = ['en_attente', 'attribuee', 'en_collecte', 'collectee', 'en_route', 'livree'];

function buildDeliveryTimeline(livraison) {
  const idx = DELIVERY_STATUS_ORDER.indexOf(livraison?.statut);
  const currentIdx = idx === -1 ? 0 : idx;
  return DELIVERY_TIMELINE_STEPS.map((s, i) => {
    const reachedIdx = DELIVERY_STATUS_ORDER.indexOf(s.key);
    let type = 'afaire';
    let date = null;
    if (reachedIdx !== -1 && reachedIdx <= currentIdx && livraison?.statut !== 'annulee') {
      type = reachedIdx === currentIdx ? 'encours' : 'fait';
      date = livraison?.[s.field] || livraison?.created_at || null;
    } else if (livraison?.statut === 'annulee') {
      type = i === 0 ? 'fait' : 'afaire';
    }
    return { titre: s.titre, date, type, key: s.key };
  });
}

async function getDeliveryDetails(req, res, next) {
  try {
    const { deliveryId } = req.params;
    const db = getDb();

    const { data: livraison, error: livErr } = await db
      .from('livraisons')
      .select('*')
      .eq('id', deliveryId)
      .maybeSingle();
    if (livErr) throw livErr;
    if (!livraison) throw createHttpError(404, 'Livraison introuvable');

    const isExterne = livraison.type_livraison === 'externe' || !livraison.sous_commande_id;

    let commande = null;
    let sousCommande = null;
    let articles = [];
    let client = null;
    let commerce = null;
    let livreurRow = null;
    let livreurUser = null;

    if (!isExterne && livraison.sous_commande_id) {
      const { data: sc } = await db
        .from('sous_commandes')
        .select('*')
        .eq('id', livraison.sous_commande_id)
        .maybeSingle();
      sousCommande = sc;
      if (sc?.commande_id) {
        const { data: c } = await db.from('commandes').select('*').eq('id', sc.commande_id).maybeSingle();
        commande = c;
      }
      if (sc) {
        const { data: items } = await db
          .from('sous_commande_items')
          .select('id, nom_produit, description_produit, quantite, prix_unitaire')
          .eq('sous_commande_id', sc.id);
        articles = items || [];
      }
      if (sc?.restaurant_id) {
        const { data: r } = await db
          .from('restaurants')
          .select('id, nom, telephone, adresse_ligne1, image_url')
          .eq('id', sc.restaurant_id)
          .maybeSingle();
        commerce = r ? { ...r, type: 'restaurant' } : null;
      }
      if (sc?.boutique_id) {
        const { data: b } = await db
          .from('boutiques')
          .select('id, nom, telephone, adresse_ligne1, image_url')
          .eq('id', sc.boutique_id)
          .maybeSingle();
        commerce = b ? { ...b, type: 'boutique' } : null;
      }
    } else {
      if (livraison.restaurant_id) {
        const { data: r } = await db
          .from('restaurants')
          .select('id, nom, telephone, adresse_ligne1, image_url')
          .eq('id', livraison.restaurant_id)
          .maybeSingle();
        commerce = r ? { ...r, type: 'restaurant' } : null;
      }
      if (livraison.boutique_id) {
        const { data: b } = await db
          .from('boutiques')
          .select('id, nom, telephone, adresse_ligne1, image_url')
          .eq('id', livraison.boutique_id)
          .maybeSingle();
        commerce = b ? { ...b, type: 'boutique' } : null;
      }
    }

    if (commande?.client_id) {
      const { data: u } = await db
        .from('utilisateurs')
        .select('id, nom, telephone, avatar_url')
        .eq('id', commande.client_id)
        .maybeSingle();
      client = u;
    }

    if (livraison.livreur_id) {
      const { data: lr } = await db
        .from('livreurs')
        .select('id, type_vehicule, note_moyenne, nb_livraisons_reussies, utilisateur_id, latitude_actuelle, longitude_actuelle, derniere_position_at')
        .eq('id', livraison.livreur_id)
        .maybeSingle();
      livreurRow = lr;
      if (lr?.utilisateur_id) {
        const { data: u } = await db
          .from('utilisateurs')
          .select('id, nom, telephone, avatar_url')
          .eq('id', lr.utilisateur_id)
          .maybeSingle();
        livreurUser = u;
      }
    }

    const role = req.auth.role;
    if (role === 'client') {
      if (commande && commande.client_id !== req.auth.userId) {
        throw createHttpError(403, 'Accès non autorisé à cette livraison');
      }
      if (isExterne) {
        throw createHttpError(403, 'Accès non autorisé');
      }
    } else if (role === 'restaurateur' || role === 'commercant') {
      const owns = commerce?.proprietaire_id === req.auth.userId;
      if (!owns) throw createHttpError(403, 'Accès non autorisé à cette livraison');
    } else if (role === 'livreur') {
      const myLivreurId = await getLivreurIdForUser(db, req.auth.userId);
      if (livraison.livreur_id !== myLivreurId) {
        throw createHttpError(403, 'Accès non autorisé à cette livraison');
      }
    }

    let paiement = null;
    if (commande?.id) {
      const { data: p } = await db
        .from('paiements')
        .select('id, statut, methode, montant, paye_at')
        .eq('commande_id', commande.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      paiement = p;
    }

    const adresseLivraison = livraison.adresse_livraison_snapshot && typeof livraison.adresse_livraison_snapshot === 'object'
      ? livraison.adresse_livraison_snapshot.texte
      : (typeof livraison.adresse_livraison_snapshot === 'string' ? livraison.adresse_livraison_snapshot : '');

    const adresseRetrait = livraison.adresse_collecte_snapshot && typeof livraison.adresse_collecte_snapshot === 'object'
      ? livraison.adresse_collecte_snapshot.texte
      : (typeof livraison.adresse_collecte_snapshot === 'string' ? livraison.adresse_collecte_snapshot : commerce?.adresse_ligne1 || '');

    const distanceKm = (() => {
      if (
        livreurRow?.latitude_actuelle != null &&
        livreurRow?.longitude_actuelle != null &&
        livraison?.latitude_livraison != null &&
        livraison?.longitude_livraison != null
      ) {
        const R = 6371;
        const toRad = (d) => (d * Math.PI) / 180;
        const dLat = toRad(livraison.latitude_livraison - livreurRow.latitude_actuelle);
        const dLon = toRad(livraison.longitude_livraison - livreurRow.longitude_actuelle);
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos(toRad(livreurRow.latitude_actuelle)) *
            Math.cos(toRad(livraison.latitude_livraison)) *
            Math.sin(dLon / 2) ** 2;
        return Number((R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) ).toFixed(2));
      }
      return null;
    })();

    return res.json({
      livraison: {
        id: livraison.id,
        statut: livraison.statut,
        type_livraison: isExterne ? 'externe' : 'commande',
        created_at: livraison.created_at,
        attribuee_at: livraison.attribuee_at,
        collectee_at: livraison.collectee_at,
        livree_at: livraison.livree_at,
        annulee_at: livraison.annulee_at || null,
        montant_total: livraison.montant_total != null ? Number(livraison.montant_total) : null,
        frais_livraison: livraison.frais_livraison != null ? Number(livraison.frais_livraison) : null,
        montant_livreur: livraison.montant_livreur != null ? Number(livraison.montant_livreur) : null,
        commission_logistique: livraison.commission_logistique != null ? Number(livraison.commission_logistique) : null,
        note: livraison.note || null,
        adresse_livraison: adresseLivraison || '',
        adresse_retrait: adresseRetrait || '',
        client_nom: livraison.client_nom || client?.nom || null,
        client_telephone: livraison.client_telephone || client?.telephone || null,
        proof_photo_url: livraison.proof_photo_url || null,
      },
      livreur: livreurRow
        ? {
            id: livreurRow.id,
            nom: livreurUser?.nom || 'Livreur',
            telephone: livreurUser?.telephone || null,
            image_url: livreurUser?.avatar_url || null,
            type_vehicule: livreurRow.type_vehicule || null,
            note_moyenne: livreurRow.note_moyenne != null ? Number(livreurRow.note_moyenne) : null,
            nb_livraisons_reussies: livreurRow.nb_livraisons_reussies || 0,
            position_actuelle:
              livreurRow.latitude_actuelle != null && livreurRow.longitude_actuelle != null
                ? { latitude: livreurRow.latitude_actuelle, longitude: livreurRow.longitude_actuelle, at: livreurRow.derniere_position_at }
                : null,
          }
        : null,
      commerce: commerce
        ? {
            id: commerce.id,
            type: commerce.type,
            nom: commerce.nom,
            telephone: commerce.telephone || null,
            adresse: commerce.adresse_ligne1 || null,
            image_url: commerce.image_url || null,
          }
        : null,
      commande: commande
        ? {
            id: commande.id,
            numero: commande.numero,
            statut: commande.statut,
            total: commande.total != null ? Number(commande.total) : null,
            cree_le: commande.created_at,
            methode_paiement: commande.methode_paiement || null,
          }
        : null,
      sous_commande: sousCommande
        ? {
            id: sousCommande.id,
            numero: sousCommande.numero,
            statut: sousCommande.statut,
            total: sousCommande.total != null ? Number(sousCommande.total) : null,
            frais_livraison: sousCommande.frais_livraison != null ? Number(sousCommande.frais_livraison) : null,
            mode_livraison: sousCommande.mode_livraison || 'golivra',
            prete_at: sousCommande.prete_at || null,
            collectee_at: sousCommande.collectee_at || null,
            livree_at: sousCommande.livree_at || null,
            reglee_at: sousCommande.reglee_at || null,
          }
        : null,
      articles: articles.map((a) => ({
        id: a.id,
        nom: a.nom_produit,
        description: a.description_produit || null,
        quantite: a.quantite,
        prix_unitaire: a.prix_unitaire != null ? Number(a.prix_unitaire) : null,
      })),
      paiement: paiement
        ? {
            id: paiement.id,
            statut: paiement.statut,
            methode: paiement.methode,
            montant: paiement.montant != null ? Number(paiement.montant) : null,
            paye_at: paiement.paye_at,
          }
        : null,
      distance_km: distanceKm,
      timeline: buildDeliveryTimeline(livraison),
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

function mapCourierMissionRowMinimal(liv) {
  const addr =
    liv.adresse_livraison_snapshot && typeof liv.adresse_livraison_snapshot === 'object'
      ? String(liv.adresse_livraison_snapshot.texte || '')
      : '';
  return {
    id: liv.id,
    statut: liv.statut,
    type_livraison: liv.type_livraison || 'commande',
    sous_commande_id: liv.sous_commande_id || null,
    created_at: liv.created_at,
    attribuee_at: liv.attribuee_at || liv.assigne_le || null,
    livree_at: liv.livree_at || liv.livre_le || null,
    adresse_livraison: addr,
    adresse_retrait: '',
    proof_photo_url: liv.proof_photo_url || null,
    commande: null,
    ouverte: false,
  };
}

async function acceptDelivery(req, res, next) {
  try {
    const { deliveryId } = req.params;
    const db = getDb();
    const courierId = await getLivreurIdForUser(db, req.auth.userId);

    const { acceptOpenDelivery } = require('../services/dispatch.service');
    const data = await acceptOpenDelivery(db, deliveryId, courierId);
    try {
      return res.json(await mapCourierMissionRow(db, data));
    } catch (mapErr) {
      console.warn('[courier] mapCourierMissionRow', mapErr?.message || mapErr);
      return res.json(mapCourierMissionRowMinimal(data));
    }
  } catch (error) {
    return next(error);
  }
}

async function advanceDelivery(req, res, next) {
  try {
    const { deliveryId } = req.params;
    const db = getDb();
    const courierId = await getLivreurIdForUser(db, req.auth.userId);

    const { advanceCourierDeliveryStep } = require('../services/dispatch.service');
    const data = await advanceCourierDeliveryStep(db, deliveryId, courierId);
    try {
      return res.json(await mapCourierMissionRow(db, data));
    } catch (mapErr) {
      console.warn('[courier] mapCourierMissionRow advance', mapErr?.message || mapErr);
      return res.json(mapCourierMissionRowMinimal(data));
    }
  } catch (error) {
    return next(error);
  }
}

async function completeDelivery(req, res, next) {
  try {
    const { deliveryId } = req.params;
    const db = getDb();
    const courierId = await getLivreurIdForUser(db, req.auth.userId);
    const proofPhotoUrl = typeof req.body?.proofPhotoUrl === 'string' ? req.body.proofPhotoUrl.trim() : undefined;

    const { completeLivraisonAndSync } = require('../services/dispatch.service');
    const data = await completeLivraisonAndSync(db, deliveryId, courierId, proofPhotoUrl);
    try {
      return res.json(await mapCourierMissionRow(db, data));
    } catch (mapErr) {
      console.warn('[courier] mapCourierMissionRow complete', mapErr?.message || mapErr);
      return res.json(mapCourierMissionRowMinimal(data));
    }
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getDeliveryStatus,
  getDeliveryDetails,
  getCourierProfile,
  listCourierMissions,
  updateCourierAvailability,
  updateCourierPosition,
  acceptDelivery,
  advanceDelivery,
  completeDelivery,
};
