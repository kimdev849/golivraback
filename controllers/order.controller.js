const { getDb } = require('../config/db');
const { createHttpError, requireFields } = require('../utils/http');
const { onSousCommandeReady } = require('../services/dispatch.service');

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

function mapCommandeListRow(c, firstEstablishmentId) {
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
    const { entrepriseId, establishmentType, articles, adresseLivraison } = req.body;
    requireFields(req.body, ['entrepriseId', 'establishmentType', 'articles', 'adresseLivraison']);
    if (!Array.isArray(articles) || articles.length === 0) {
      throw createHttpError(400, 'Le champ articles doit être un tableau non vide');
    }

    if (establishmentType !== 'restaurant' && establishmentType !== 'boutique') {
      throw createHttpError(400, 'establishmentType doit être restaurant ou boutique');
    }

    const db = getDb();
    const resolved = await resolveEstablishmentRow(db, entrepriseId, establishmentType);
    if (!resolved) throw createHttpError(404, 'Commerce introuvable');
    const { kind, row: ent } = resolved;

    if (ent.statut !== 'active') {
      throw createHttpError(403, 'Ce commerce n’est pas encore visible : validation en cours.');
    }
    if (ent.est_ouvert !== true) {
      throw createHttpError(403, 'Ce commerce est temporairement fermé.');
    }

    const lines = [];
    let sousTotal = 0;

    for (const article of articles) {
      const { itemId, quantite } = article;
      const q = Math.max(1, Math.floor(Number(quantite)));
      if (!itemId) throw createHttpError(400, 'Chaque article doit avoir itemId');

      if (kind === 'restaurant') {
        const { data: plat, error: pErr } = await db.from('plats').select('*').eq('id', itemId).maybeSingle();
        if (pErr) throw pErr;
        if (!plat || plat.restaurant_id !== entrepriseId) {
          throw createHttpError(400, 'Plat invalide pour ce restaurant');
        }
        if (!plat.est_disponible) throw createHttpError(400, `Plat indisponible : ${plat.nom}`);
        const pu = Number(plat.prix);
        const lineTot = q * pu;
        sousTotal += lineTot;
        lines.push({
          plat_id: plat.id,
          article_id: null,
          nom_produit: plat.nom,
          description_produit: plat.description,
          options_choisies: null,
          quantite: q,
          prix_unitaire: pu,
          sous_total: lineTot,
        });
      } else {
        const { data: art, error: aErr } = await db.from('articles').select('*').eq('id', itemId).maybeSingle();
        if (aErr) throw aErr;
        if (!art || art.boutique_id !== entrepriseId) {
          throw createHttpError(400, 'Article invalide pour cette boutique');
        }
        if (!art.est_disponible) throw createHttpError(400, `Article indisponible : ${art.nom}`);
        if (art.stock !== null && art.stock !== undefined && q > Number(art.stock)) {
          throw createHttpError(400, 'Stock insuffisant');
        }
        const pu = Number(art.prix);
        const lineTot = q * pu;
        sousTotal += lineTot;
        lines.push({
          plat_id: null,
          article_id: art.id,
          nom_produit: art.nom,
          description_produit: art.description,
          options_choisies: null,
          quantite: q,
          prix_unitaire: pu,
          sous_total: lineTot,
        });
      }
    }

    const addrSnap = snapshotAddress(String(adresseLivraison).trim());

    const { data: commande, error: cErr } = await db
      .from('commandes')
      .insert({
        client_id: req.auth.userId,
        adresse_livraison_snapshot: addrSnap,
        statut: 'en_attente',
        sous_total: sousTotal,
        frais_livraison_total: 0,
        remise_totale: 0,
        total: sousTotal,
        methode_paiement: 'especes',
      })
      .select('*')
      .single();
    if (cErr) throw cErr;

    const scPayload = {
      commande_id: commande.id,
      statut: 'en_attente',
      mode_livraison: 'golivra',
      sous_total: sousTotal,
      frais_livraison: 0,
      remise: 0,
      total: sousTotal,
    };
    if (kind === 'restaurant') scPayload.restaurant_id = entrepriseId;
    else scPayload.boutique_id = entrepriseId;

    const { data: sous, error: sErr } = await db.from('sous_commandes').insert(scPayload).select('*').single();
    if (sErr) throw sErr;

    const itemRows = lines.map((l) => ({
      sous_commande_id: sous.id,
      plat_id: l.plat_id,
      article_id: l.article_id,
      nom_produit: l.nom_produit,
      description_produit: l.description_produit,
      options_choisies: l.options_choisies,
      quantite: l.quantite,
      prix_unitaire: l.prix_unitaire,
      sous_total: l.sous_total,
    }));

    const { error: iErr } = await db.from('sous_commande_items').insert(itemRows);
    if (iErr) throw iErr;

    return res.status(201).json(
      mapCommandeListRow(commande, entrepriseId)
    );
  } catch (error) {
    return next(error);
  }
}

function mapSousStatutToVendor(statut) {
  switch (statut) {
    case 'en_attente':
    case 'acceptee':
      return 'a_preparer';
    case 'en_preparation':
      return 'en_preparation';
    case 'prete':
      return 'prete';
    case 'collectee':
      return 'en_livraison';
    case 'livree':
      return 'livree';
    case 'annulee':
    case 'refusee':
    case 'remboursee':
      return 'annulee';
    default:
      return 'a_preparer';
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
    const { data: commandes, error } = await db
      .from('commandes')
      .select('*')
      .eq('client_id', req.auth.userId)
      .order('created_at', { ascending: false });
    if (error) throw error;

    const out = [];
    for (const c of commandes || []) {
      const { data: scs } = await db
        .from('sous_commandes')
        .select('restaurant_id, boutique_id')
        .eq('commande_id', c.id)
        .limit(1);
      const first = scs && scs[0];
      const eid = first ? first.restaurant_id || first.boutique_id : null;
      out.push(mapCommandeListRow(c, eid));
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
    const { statut, sousCommandeId } = req.body;
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

    const { data: updated, error } = await db
      .from('sous_commandes')
      .update({ statut })
      .eq('id', targetId)
      .select('*')
      .single();
    if (error || !updated) throw createHttpError(404, 'Sous-commande introuvable');

    if (statut === 'prete') {
      await onSousCommandeReady(db, targetId);
    }

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
