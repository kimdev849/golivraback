const { getDb } = require('../config/db');
const { createHttpError, requireFields } = require('../utils/http');
const {
  createOrderFromPayload,
  updateSousCommandeStatut,
  mapSousStatutToVendor,
  PAYABLE_SC_STATUTS,
} = require('../services/order.service');

/** Statuts autorisés pour une sous-commande (schéma v3). */
const ALLOWED_SOUS_STATUT = new Set([
  'en_attente',
  'acceptee',
  'refusee',
  'en_preparation',
  'prete',
  'collectee',
  'livree',
  'annulee',
  'remboursee',
]);

/** Statuts commande principale (admin). */
const ALLOWED_COMMANDE_STATUT = new Set([
  'en_attente',
  'partiellement_acceptee',
  'acceptee',
  'en_preparation',
  'prete',
  'en_livraison',
  'livree',
  'partiellement_livree',
  'annulee',
  'remboursee',
]);

function snapshotAddress(text) {
  return { texte: text, version: 1 };
}

function mapCommandeListRow(c, firstEstablishmentId, extra = {}) {
  const snap = c.adresse_livraison_snapshot;
  let addr = null;
  if (snap && typeof snap === 'object' && snap.texte) addr = snap.texte;
  else if (typeof snap === 'string') addr = snap;

  return {
    id: c.id,
    numero: c.numero,
    entreprise_id: firstEstablishmentId,
    statut: c.statut,
    prix_total: c.total,
    adresse_livraison: addr,
    cree_le: c.created_at,
    livree_le: c.livree_at ?? null,
    created_at: c.created_at,
    total: c.total,
    ...extra,
  };
}

async function resolveEstablishmentRow(db, establishmentId, establishmentType) {
  if (establishmentType === 'restaurant') {
    const { data, error } = await db.from('restaurants').select('*').eq('id', establishmentId).maybeSingle();
    if (error) throw error;
    return data ? { kind: 'restaurant', row: data } : null;
  }
  if (establishmentType === 'boutique') {
    const { data, error } = await db.from('boutiques').select('*').eq('id', establishmentId).maybeSingle();
    if (error) throw error;
    return data ? { kind: 'boutique', row: data } : null;
  }
  return null;
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

async function createOrder(req, res, next) {
  try {
    const { adresseLivraison, adresseLivraisonId, adresse } = req.body || {};
    const hasText = typeof adresseLivraison === 'string' && adresseLivraison.trim().length >= 8;
    const hasStruct =
      adresse &&
      typeof adresse === 'object' &&
      String(adresse.quartier || '').trim() &&
      String(adresse.ligne1 || '').trim().length >= 4;
    const hasId = typeof adresseLivraisonId === 'string' && adresseLivraisonId.trim();
    if (!hasText && !hasStruct && !hasId) {
      const { createHttpError } = require('../utils/http');
      throw createHttpError(400, 'Indiquez une adresse de livraison (quartier + description).');
    }
    const { methodePaiement } = req.body || {};
    const payOk = methodePaiement === 'airtel_money' || methodePaiement === 'mtn_money';
    if (!payOk) {
      const { createHttpError } = require('../utils/http');
      throw createHttpError(400, 'Choisissez Airtel Money ou MTN Mobile Money.');
    }
    const db = getDb();
    const { commande, sousCommandes, dejaExistante } = await createOrderFromPayload(db, req.auth.userId, req.body);
    if (!dejaExistante) {
      const { notifyOrderCreated } = require('../services/order-notify.service');
      await notifyOrderCreated(db, commande.id, req.auth.userId);
    }
    const first = sousCommandes[0];
    const eid = first ? first.restaurant_id || first.boutique_id : null;
    return res.status(201).json({
      ...mapCommandeListRow(commande, eid),
      sous_commandes: sousCommandes,
    });
  } catch (error) {
    return next(error);
  }
}

function formatDateLabel(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay =
      d.getDate() === now.getDate() &&
      d.getMonth() === now.getMonth() &&
      d.getFullYear() === now.getFullYear();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday =
      d.getDate() === yesterday.getDate() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getFullYear() === yesterday.getFullYear();
    const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return `Aujourd'hui ${time}`;
    if (isYesterday) return `Hier ${time}`;
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

async function getOwnedEstablishmentIds(db, userId) {
  const [rRes, bRes] = await Promise.all([
    db.from('restaurants').select('id').eq('proprietaire_id', userId),
    db.from('boutiques').select('id').eq('proprietaire_id', userId),
  ]);
  if (rRes.error) throw rRes.error;
  if (bRes.error) throw bRes.error;
  return {
    restaurantIds: (rRes.data || []).map((r) => r.id),
    boutiqueIds: (bRes.data || []).map((b) => b.id),
  };
}

async function mapVendorOrderRow(db, sc, commande, client) {
  // Les 3 lectures indépendantes partent EN PARALLÈLE (items, paiement,
  // livraison) au lieu de 3 allers-retours séquentiels — gain de latence
  // direct sur la liste des commandes vendeur (surtout multi-commandes).
  const [itemsRes, paiementRes, livraisonRes] = await Promise.all([
    db.from('sous_commande_items').select('*').eq('sous_commande_id', sc.id),
    db
      .from('paiements')
      .select('statut')
      .eq('commande_id', commande.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db
      .from('livraisons')
      .select('livreur_id, statut')
      .eq('sous_commande_id', sc.id)
      .maybeSingle(),
  ]);
  const items = itemsRes.data || [];
  const paiement = paiementRes.data;
  const livraison = livraisonRes.data;
  if (itemsRes.error) throw itemsRes.error;
  if (paiementRes.error) throw paiementRes.error;
  if (livraisonRes.error) throw livraisonRes.error;

  const snap = commande.adresse_livraison_snapshot;
  let addr = '';
  if (snap && typeof snap === 'object' && snap.texte) addr = snap.texte;
  else if (typeof snap === 'string') addr = snap;

  let livreur = null;
  let paiementStatut = null;
  if (paiement?.statut) paiementStatut = paiement.statut;
  if (livraison?.livreur_id) {
    const { data: liv } = await db.from('livreurs').select('utilisateur_id').eq('id', livraison.livreur_id).maybeSingle();
    if (liv?.utilisateur_id) {
      const { data: u } = await db.from('utilisateurs').select('nom, telephone').eq('id', liv.utilisateur_id).maybeSingle();
      if (u) livreur = { nom: u.nom || 'Livreur', tel: u.telephone || '' };
    }
  }

  const establishmentType = sc.restaurant_id ? 'restaurant' : 'boutique';
  const establishmentId = sc.restaurant_id || sc.boutique_id || null;

  return {
    id: commande.id,
    sous_commande_id: sc.id,
    ref: commande.numero || sc.numero,
    statut: mapSousStatutToVendor(sc.statut),
    statut_brut: sc.statut,
    mode_livraison: sc.mode_livraison || 'golivra',
    acceptation_limite_at: commande.acceptation_limite_at ?? null,
    establishmentType,
    establishmentId,
    clientNom: client?.nom || 'Client',
    clientTel: client?.telephone || '',
    adresse: addr,
    creeLeLabel: formatDateLabel(commande.created_at),
    // Part du vendeur = SOUS-TOTAL PRODUITS uniquement (jamais les frais de
    // livraison : cet argent revient au livreur / à GoLivra logistique, pas au
    // commerce). sc.total inclut la livraison → on utilise sc.sous_total.
    prixTotal: Number(sc.sous_total ?? sc.total ?? commande.total ?? 0),
    sousTotal: Number(sc.sous_total ?? 0),
    fraisLivraison: Number(sc.frais_livraison ?? 0),
    noteClient: commande.note_client || undefined,
    lignes: (items || []).map((it) => ({
      id: it.id,
      nom: it.nom_produit,
      detail: it.description_produit || undefined,
      quantite: it.quantite,
      prixUnitaire: Number(it.prix_unitaire),
    })),
    livreur: livreur || undefined,
    livraison_statut: livraison?.statut ?? null,
    paiement_statut: paiementStatut,
    paiement_limite_at: commande.paiement_limite_at ?? null,
    created_at: commande.created_at,
  };
}

async function getVendorOrders(req, res, next) {
  try {
    const db = getDb();
    const { restaurantIds, boutiqueIds } = await getOwnedEstablishmentIds(db, req.auth.userId);
    if (restaurantIds.length === 0 && boutiqueIds.length === 0) {
      return res.json([]);
    }

    let scQuery = db.from('sous_commandes').select('*').order('created_at', { ascending: false });
    if (restaurantIds.length > 0 && boutiqueIds.length > 0) {
      scQuery = scQuery.or(
        `restaurant_id.in.(${restaurantIds.join(',')}),boutique_id.in.(${boutiqueIds.join(',')})`,
      );
    } else if (restaurantIds.length > 0) {
      scQuery = scQuery.in('restaurant_id', restaurantIds);
    } else {
      scQuery = scQuery.in('boutique_id', boutiqueIds);
    }

    const { data: scs, error } = await scQuery;
    if (error) throw error;

    const commandeIds = [...new Set((scs || []).map((sc) => sc.commande_id))];
    if (commandeIds.length === 0) return res.json([]);

    const { data: commandes, error: cErr } = await db.from('commandes').select('*').in('id', commandeIds);
    if (cErr) throw cErr;
    const commandeMap = new Map((commandes || []).map((c) => [c.id, c]));

    const clientIds = [...new Set((commandes || []).map((c) => c.client_id))];
    const { data: clients } = clientIds.length
      ? await db.from('utilisateurs').select('id, nom, telephone').in('id', clientIds)
      : { data: [] };
    const clientMap = new Map((clients || []).map((u) => [u.id, u]));

    // Chaque sous-commande est mappée en parallèle (les lectures items /
    // paiement / livraison de mapVendorOrderRow sont déjà parallèles).
    const out = await Promise.all(
      (scs || []).map(async (sc) => {
        const commande = commandeMap.get(sc.commande_id);
        if (!commande) return null;
        const client = clientMap.get(commande.client_id);
        return mapVendorOrderRow(db, sc, commande, client);
      }),
    );

    return res.json(out.filter(Boolean));
  } catch (error) {
    return next(error);
  }
}

async function getVendorOrderDetails(req, res, next) {
  try {
    const { orderId } = req.params;
    const db = getDb();

    const ownedIds = await findVendorSousCommandeIdsForOrder(db, req.auth.userId, orderId);
    if (ownedIds.length === 0) throw createHttpError(403, 'Commande introuvable');

    const { data: order, error } = await db.from('commandes').select('*').eq('id', orderId).maybeSingle();
    if (error) throw error;
    if (!order) throw createHttpError(404, 'Commande introuvable');

    const { data: scs } = await db
      .from('sous_commandes')
      .select('*')
      .eq('commande_id', orderId)
      .in('id', ownedIds);
    const sc = scs && scs[0];
    if (!sc) throw createHttpError(404, 'Commande introuvable');

    const { data: client } = await db
      .from('utilisateurs')
      .select('id, nom, telephone')
      .eq('id', order.client_id)
      .maybeSingle();

    return res.json(await mapVendorOrderRow(db, sc, order, client));
  } catch (error) {
    return next(error);
  }
}

async function getOrders(req, res, next) {
  try {
    const db = getDb();
    const clientId = req.auth.userId;
    const { data: commandes, error } = await db
      .from('commandes')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });
    if (error) throw error;

    const list = commandes || [];
    if (list.length === 0) return res.json([]);

    const commandeIds = list.map((c) => c.id);
    const { data: allScs, error: scErr } = await db
      .from('sous_commandes')
      .select('id, commande_id, restaurant_id, boutique_id, statut, raison_refus')
      .in('commande_id', commandeIds);
    if (scErr) throw scErr;

    const scByCommande = new Map();
    for (const sc of allScs || []) {
      if (!scByCommande.has(sc.commande_id)) scByCommande.set(sc.commande_id, []);
      scByCommande.get(sc.commande_id).push(sc);
    }

    const livreeIds = (allScs || []).filter((s) => s.statut === 'livree').map((s) => s.id);
    const ratedSet = new Set();
    if (livreeIds.length > 0) {
      const [{ data: avisR }, { data: avisB }] = await Promise.all([
        db.from('avis_restaurants').select('sous_commande_id').eq('client_id', clientId).in('sous_commande_id', livreeIds),
        db.from('avis_boutiques').select('sous_commande_id').eq('client_id', clientId).in('sous_commande_id', livreeIds),
      ]);
      for (const a of [...(avisR || []), ...(avisB || [])]) {
        if (a.sous_commande_id) ratedSet.add(a.sous_commande_id);
      }
    }

    const out = [];
    for (const c of list) {
      const scs = scByCommande.get(c.id) || [];
      const first = scs[0];
      const eid = first ? first.restaurant_id || first.boutique_id : null;

      const toRate = scs.find((s) => s.statut === 'livree' && !ratedSet.has(s.id));
      // Raison d'annulation + détails pour un affichage client humain :
      // « Pas de réponse de la boutique », « Commande refusée », « Paiement
      // non effectué », « Vous avez annulé votre commande »…
      const extra = {
        peut_noter: false,
        annulation_motif: c.annulation_motif ?? null,
        sous_statuts: scs.map((s) => s.statut),
        commerce_type: first ? (first.restaurant_id ? 'restaurant' : 'boutique') : null,
      };
      if (toRate) {
        extra.peut_noter = true;
        extra.sous_commande_id = toRate.id;
        extra.entreprise_type = toRate.restaurant_id ? 'restaurant' : 'boutique';
        extra.entreprise_id = toRate.restaurant_id || toRate.boutique_id || eid;
      }

      out.push(mapCommandeListRow(c, eid, extra));
    }

    return res.json(out);
  } catch (error) {
    return next(error);
  }
}

/**
 * Estimation d'arrivée pour le client, cohérente avec l'affichage du panier :
 *   préparation (commerce) + livraison (zone GoLivra, 25/35/45 min selon le quartier).
 * La préparation multi-commerce se fait en parallèle → on prend le MAX des prépas.
 * `arriveeEstimeeAt` = created_at + (préparation + livraison).
 */
async function computeOrderEta(db, order, sousCommandes) {
  const { establishmentPrepMinutes, resolveEstablishmentRow } = require('../services/order.service');
  const snap = order?.adresse_livraison_snapshot;
  let quartier = null;
  if (snap && typeof snap === 'object') {
    if (typeof snap.quartier === 'string' && snap.quartier.trim()) {
      quartier = snap.quartier.trim();
    } else if (
      snap.zone_pricing &&
      typeof snap.zone_pricing === 'object' &&
      typeof snap.zone_pricing.quartier === 'string' &&
      snap.zone_pricing.quartier.trim()
    ) {
      quartier = snap.zone_pricing.quartier.trim();
    }
  } else if (typeof snap === 'string') {
    // Snapshot legacy (texte brut) : on extrait le quartier du début du texte.
    const first = String(snap).split(',')[0].replace(/^quartier\s+/i, '').trim();
    quartier = first || null;
  }

  let prepMinutes = 0;
  for (const sc of sousCommandes || []) {
    const kind = sc.restaurant_id ? 'restaurant' : sc.boutique_id ? 'boutique' : null;
    if (!kind) continue;
    const resolved = await resolveEstablishmentRow(
      db,
      sc.restaurant_id || sc.boutique_id,
      kind,
    );
    if (resolved) prepMinutes = Math.max(prepMinutes, establishmentPrepMinutes(resolved.row, resolved.kind));
  }
  prepMinutes = Math.min(Math.max(Math.floor(prepMinutes), 5), 180);

  let delivery = null;
  if (quartier) {
    try {
      const { estimateDeliveryMinutesForQuartier } = require('./zones.service');
      delivery = await estimateDeliveryMinutesForQuartier(db, quartier);
    } catch {
      delivery = null;
    }
  }

  const totalMinutes = delivery?.minutes != null ? prepMinutes + delivery.minutes : null;
  let arriveeEstimeeAt = null;
  if (totalMinutes != null && order?.created_at) {
    arriveeEstimeeAt = new Date(
      new Date(order.created_at).getTime() + totalMinutes * 60_000,
    ).toISOString();
  }

  return {
    prepMinutes,
    deliveryMinutes: delivery?.minutes ?? null,
    tier: delivery?.tier ?? null,
    tierLabel: delivery?.tierLabel ?? null,
    quartierLivraison: quartier,
    totalMinutes,
    arriveeEstimeeAt,
  };
}

async function getOrderDetails(req, res, next) {
  try {
    const db = getDb();
    const { orderId } = req.params;

    const { data: order, error } = await db
      .from('commandes')
      .select('*')
      .eq('id', orderId)
      .eq('client_id', req.auth.userId)
      .maybeSingle();
    if (error) throw error;
    if (!order) throw createHttpError(404, 'Commande introuvable');

    const { data: sousCommandes, error: scErr } = await db
      .from('sous_commandes')
      .select('*')
      .eq('commande_id', orderId);
    if (scErr) throw scErr;

    const scIds = (sousCommandes || []).map((s) => s.id);
    const { data: livraisons } = scIds.length
      ? await db.from('livraisons').select('id, statut, type_livraison').in('sous_commande_id', scIds)
      : { data: [] };

    const livraisonBySc = new Map();
    for (const liv of livraisons || []) {
      if (!livraisonBySc.has(liv.sous_commande_id)) livraisonBySc.set(liv.sous_commande_id, []);
      livraisonBySc.get(liv.sous_commande_id).push(liv);
    }

    // Lecture des items + nom du commerce pour TOUTES les sous-commandes en
    // parallèle (au lieu d'une boucle séquentielle) — gain notable sur les
    // commandes multi-commerce.
    const enriched = await Promise.all(
      (sousCommandes || []).map(async (sc) => {
        const { data: items } = await db
          .from('sous_commande_items')
          .select('*')
          .eq('sous_commande_id', sc.id);
        const livs = livraisonBySc.get(sc.id) || [];
        // Nom du commerce pour l'affichage client (répartition acceptée/refusée).
        let commerceNom = null;
        if (sc.restaurant_id) {
          const { data: r } = await db.from('restaurants').select('nom').eq('id', sc.restaurant_id).maybeSingle();
          commerceNom = r?.nom ?? null;
        } else if (sc.boutique_id) {
          const { data: b } = await db.from('boutiques').select('nom').eq('id', sc.boutique_id).maybeSingle();
          commerceNom = b?.nom ?? null;
        }
        return {
          ...sc,
          commerce_nom: commerceNom,
          articles: items || [],
          livraisons: livs.map((l) => ({ id: l.id, statut: l.statut, type_livraison: l.type_livraison })),
          livraison_id: livs[0]?.id || null,
        };
      }),
    );

    // Statut du paiement + montant réellement dû (segments acceptés uniquement).
    const { data: paiementRow } = await db
      .from('paiements')
      .select('statut')
      .eq('commande_id', orderId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const paiementStatut = paiementRow?.statut ?? null;
    let totalAPayer = 0;
    for (const sc of enriched) {
      if (PAYABLE_SC_STATUTS.has(sc.statut)) totalAPayer += Number(sc.total ?? 0);
    }
    totalAPayer = Math.min(Math.round(totalAPayer), Number(order.total ?? 0));

    const first = sousCommandes && sousCommandes[0];
    const eid = first ? first.restaurant_id || first.boutique_id : null;

    const eta = await computeOrderEta(db, order, enriched);

    return res.json({
      ...mapCommandeListRow(order, eid),
      sousCommandes: enriched,
      eta,
      paiement_statut: paiementStatut,
      paiement_limite_at: order.paiement_limite_at ?? null,
      acceptation_limite_at: order.acceptation_limite_at ?? null,
      annulation_motif: order.annulation_motif ?? null,
      total_a_payer: totalAPayer,
      livraisons: (livraisons || []).map((l) => ({ id: l.id, statut: l.statut, type_livraison: l.type_livraison })),
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * Annulation par le CLIENT (uniquement tant que la commande n'est pas payée) :
 * utile dans le nouveau parcours quand il choisit « Annuler toute la commande »
 * après des refus / expirations, ou s'il ne souhaite plus payer.
 */
async function cancelOrder(req, res, next) {
  try {
    const db = getDb();
    const { orderId } = req.params;

    const { data: order } = await db
      .from('commandes')
      .select('*')
      .eq('id', orderId)
      .eq('client_id', req.auth.userId)
      .maybeSingle();
    if (!order) throw createHttpError(404, 'Commande introuvable');

    const { data: paiement } = await db
      .from('paiements')
      .select('statut')
      .eq('commande_id', orderId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (paiement?.statut === 'valide') {
      throw createHttpError(400, 'La commande est déjà payée : annulation impossible.');
    }

    const now = new Date().toISOString();
    const { data: scs } = await db.from('sous_commandes').select('id, statut').eq('commande_id', orderId);
    for (const sc of scs || []) {
      if (sc.statut === 'en_attente' || sc.statut === 'acceptee') {
        await db
          .from('sous_commandes')
          .update({ statut: 'annulee', raison_refus: 'Annulé par le client', updated_at: now })
          .eq('id', sc.id);
      }
    }

    const { syncCommandeStatutFromSousCommandes } = require('../services/order.service');
    await syncCommandeStatutFromSousCommandes(db, orderId);
    await db
      .from('commandes')
      .update({
        annulation_motif: 'Annulé par le client',
        paiement_limite_at: null,
        updated_at: now,
      })
      .eq('id', orderId);

    const { notifyOrderExpired } = require('../services/order-notify.service');
    await notifyOrderExpired(db, orderId, {
      remboursementEnCours: false,
      raisonClient: 'Votre commande a été annulée.',
    });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
}

async function updateOrderStatus(req, res, next) {
  try {
    const { orderId } = req.params;
    const { statut, sousCommandeId, raisonRefus } = req.body;
    requireFields(req.body, ['statut']);

    const db = getDb();

    if (req.auth.role === 'admin') {
      if (!ALLOWED_COMMANDE_STATUT.has(statut)) {
        throw createHttpError(400, 'Ce changement de statut n’est pas possible.');
      }
      const { data, error } = await db
        .from('commandes')
        .update({ statut })
        .eq('id', orderId)
        .select('*')
        .single();
      if (error || !data) throw createHttpError(404, 'Commande introuvable');
      return res.json(data);
    }

    if (!ALLOWED_SOUS_STATUT.has(statut)) {
      throw createHttpError(400, 'Ce changement de statut n’est pas possible.');
    }

    const ownedIds = await findVendorSousCommandeIdsForOrder(db, req.auth.userId, orderId);
    if (ownedIds.length === 0) {
      throw createHttpError(403, 'Aucune commande pour votre commerce.');
    }

    const targetId = sousCommandeId || (ownedIds.length === 1 ? ownedIds[0] : null);
    if (!targetId || !ownedIds.includes(targetId)) {
      throw createHttpError(
        400,
        'Indiquez sousCommandeId lorsque la commande contient plusieurs établissements.',
      );
    }

    const { data: current } = await db.from('sous_commandes').select('statut, mode_livraison').eq('id', targetId).maybeSingle();
    if (!current) throw createHttpError(404, 'Commande introuvable');

    // Délai d'acceptation : le commerce a 15 minutes après la création. Passé ce
    // délai, la commande est automatiquement expirée et le client remboursé.
    if (statut === 'acceptee') {
      const { data: cmd } = await db.from('commandes').select('acceptation_limite_at').eq('id', orderId).maybeSingle();
      const limite = cmd?.acceptation_limite_at ? new Date(cmd.acceptation_limite_at).getTime() : null;
      if (limite != null && Date.now() > limite) {
        throw createHttpError(
          400,
          'Le délai d\'acceptation (5 minutes) est dépassé : la commande a été annulée.',
        );
      }
    }

    if (statut === 'acceptee' && current.statut !== 'en_attente') {
      throw createHttpError(400, 'Cette commande ne peut plus être acceptée.');
    }
    if (statut === 'refusee' && current.statut !== 'en_attente') {
      throw createHttpError(400, 'Cette commande ne peut plus être refusée.');
    }
    if (statut === 'prete' && current.statut !== 'en_preparation') {
      throw createHttpError(400, 'La commande doit être en préparation avant d\'être marquée prête.');
    }
    if (
      statut === 'en_preparation' &&
      current.statut !== 'acceptee' &&
      current.statut !== 'en_attente'
    ) {
      throw createHttpError(400, 'Acceptez la commande avant de démarrer la préparation.');
    }
    if (statut === 'collectee' || statut === 'livree') {
      throw createHttpError(
        400,
        'La livraison est assurée par les livreurs GoLivra. Le commerce ne peut pas marquer « en route » ou « livrée ».',
      );
    }

    const extra = {};
    if (statut === 'refusee' && raisonRefus) extra.raison_refus = String(raisonRefus).trim();

    const updated = await updateSousCommandeStatut(db, targetId, statut, extra);
    return res.json(updated);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  createOrder,
  getOrders,
  getVendorOrders,
  getVendorOrderDetails,
  getOrderDetails,
  cancelOrder,
  updateOrderStatus,
};
