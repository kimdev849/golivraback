const { getDb } = require('../config/db');
const { createHttpError, requireFields } = require('../utils/http');
const {
  createOrderFromPayload,
  updateSousCommandeStatut,
  mapSousStatutToVendor,
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
    const { commande, sousCommandes } = await createOrderFromPayload(db, req.auth.userId, req.body);
    const { notifyUserSafe } = require('../services/notification.service');
    await notifyUserSafe(db, {
      utilisateurId: req.auth.userId,
      type: 'commande_statut',
      titre: 'Commande créée',
      corps: 'Finalisez le paiement Mobile Money pour confirmer votre commande.',
      data: { commande_id: commande.id, action: 'open_orders' },
    });
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
  const { data: items } = await db.from('sous_commande_items').select('*').eq('sous_commande_id', sc.id);
  const snap = commande.adresse_livraison_snapshot;
  let addr = '';
  if (snap && typeof snap === 'object' && snap.texte) addr = snap.texte;
  else if (typeof snap === 'string') addr = snap;

  let livreur = null;
  const { data: livraison } = await db
    .from('livraisons')
    .select('livreur_id, statut')
    .eq('sous_commande_id', sc.id)
    .maybeSingle();
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
    establishmentType,
    establishmentId,
    clientNom: client?.nom || 'Client',
    clientTel: client?.telephone || '',
    adresse: addr,
    creeLeLabel: formatDateLabel(commande.created_at),
    prixTotal: Number(sc.total ?? commande.total ?? 0),
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

    const out = [];
    for (const sc of scs || []) {
      const commande = commandeMap.get(sc.commande_id);
      if (!commande) continue;
      const client = clientMap.get(commande.client_id);
      out.push(await mapVendorOrderRow(db, sc, commande, client));
    }

    return res.json(out);
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
    if (!sc) throw createHttpError(404, 'Sous-commande introuvable');

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
      .select('id, commande_id, restaurant_id, boutique_id, statut')
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
      const extra = toRate
        ? {
            peut_noter: true,
            sous_commande_id: toRate.id,
            entreprise_type: toRate.restaurant_id ? 'restaurant' : 'boutique',
            entreprise_id: toRate.restaurant_id || toRate.boutique_id || eid,
          }
        : { peut_noter: false };

      out.push(mapCommandeListRow(c, eid, extra));
    }

    return res.json(out);
  } catch (error) {
    return next(error);
  }
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

    const enriched = [];
    for (const sc of sousCommandes || []) {
      const { data: items } = await db.from('sous_commande_items').select('*').eq('sous_commande_id', sc.id);
      enriched.push({ ...sc, articles: items || [] });
    }

    const first = sousCommandes && sousCommandes[0];
    const eid = first ? first.restaurant_id || first.boutique_id : null;

    return res.json({
      ...mapCommandeListRow(order, eid),
      sousCommandes: enriched,
    });
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
        throw createHttpError(400, 'Statut de commande principal non pris en charge');
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
      throw createHttpError(400, 'Statut de sous-commande non pris en charge');
    }

    const ownedIds = await findVendorSousCommandeIdsForOrder(db, req.auth.userId, orderId);
    if (ownedIds.length === 0) {
      throw createHttpError(403, 'Aucune sous-commande pour cet établissement');
    }

    const targetId = sousCommandeId || (ownedIds.length === 1 ? ownedIds[0] : null);
    if (!targetId || !ownedIds.includes(targetId)) {
      throw createHttpError(
        400,
        'Indiquez sousCommandeId lorsque la commande contient plusieurs établissements.',
      );
    }

    const { data: current } = await db.from('sous_commandes').select('statut, mode_livraison').eq('id', targetId).maybeSingle();
    if (!current) throw createHttpError(404, 'Sous-commande introuvable');

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
  updateOrderStatus,
};
