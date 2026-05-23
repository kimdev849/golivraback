const { getDb } = require('../config/db');
const { requireFields, createHttpError } = require('../utils/http');
const {
  createLogisticsCompanyWithManager,
  listCouriersForCompany,
  createCourierForCompany,
  suspendCourier,
  activateCourier,
  assertCompanyAccess,
  mapCourierPublic,
  classifyDeliveryDelay,
  notifyDeliveryDelaysForList,
} = require('../services/logistics.service');
const {
  formatDateTimeFr,
  mapCommandeTimeline,
  mapLivraisonTimeline,
  mapTimestampFields,
  COMMANDE_TIMESTAMP_FIELDS,
} = require('../utils/timeline');

async function createCourier(req, res, next) {
  try {
    const { utilisateurId, typeVehicule, entrepriseLogistiqueId } = req.body;
    requireFields(req.body, ['utilisateurId', 'typeVehicule']);

    const db = getDb();

    const { data: exists } = await db.from('livreurs').select('id').eq('utilisateur_id', utilisateurId).maybeSingle();
    if (exists) throw createHttpError(409, 'Ce compte a déjà un profil livreur.');

    const { data, error } = await db
      .from('livreurs')
      .insert({
        utilisateur_id: utilisateurId,
        type_vehicule: typeVehicule,
        entreprise_logistique_id: entrepriseLogistiqueId || null,
        est_disponible: false,
        est_approuve: true,
      })
      .select('*')
      .single();
    if (error) throw error;

    return res.status(201).json(data);
  } catch (error) {
    return next(error);
  }
}

function mapRestaurantAdmin(r, owner) {
  return {
    ...r,
    type: 'restaurant',
    statut_moderation: r.statut,
    ouvert: r.est_ouvert,
    adresse: r.adresse_ligne1,
    proprietaire: owner || null,
  };
}

function mapBoutiqueAdmin(b, owner) {
  return {
    ...b,
    type: 'boutique',
    statut_moderation: b.statut,
    ouvert: b.est_ouvert,
    adresse: b.adresse_ligne1,
    proprietaire: owner || null,
  };
}

async function loadOwnerMap(db, ownerIds) {
  const unique = [...new Set(ownerIds.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const { data, error } = await db
    .from('utilisateurs')
    .select('id, nom, telephone, email, est_approuve, created_at, role_id')
    .in('id', unique);
  if (error) throw error;

  const roleIds = [...new Set((data || []).map((u) => u.role_id).filter(Boolean))];
  let roleMap = new Map();
  if (roleIds.length > 0) {
    const { data: roles } = await db.from('roles').select('id, nom').in('id', roleIds);
    roleMap = new Map((roles || []).map((r) => [r.id, r.nom]));
  }

  const map = new Map();
  for (const u of data || []) {
    map.set(u.id, {
      id: u.id,
      nom: u.nom,
      telephone: u.telephone,
      email: u.email,
      est_approuve: u.est_approuve,
      created_at: u.created_at,
      role: roleMap.get(u.role_id) || null,
    });
  }
  return map;
}

async function mergeEnterprises(db, restaurants, boutiques) {
  const ownerIds = [
    ...(restaurants || []).map((r) => r.proprietaire_id),
    ...(boutiques || []).map((b) => b.proprietaire_id),
  ];
  const owners = await loadOwnerMap(db, ownerIds);
  const merged = [
    ...(restaurants || []).map((r) => mapRestaurantAdmin(r, owners.get(r.proprietaire_id))),
    ...(boutiques || []).map((b) => mapBoutiqueAdmin(b, owners.get(b.proprietaire_id))),
  ];
  merged.sort((a, b) => String(a.nom || '').localeCompare(String(b.nom || '')));
  return merged;
}

async function approveOwnerUser(db, ownerId, adminId) {
  if (!ownerId) return;
  await db
    .from('utilisateurs')
    .update({ est_approuve: true, raison_rejet: null })
    .eq('id', ownerId);
  void adminId;
}

async function updateEnterpriseById(db, enterpriseId, patch) {
  const rTry = await db.from('restaurants').update(patch).eq('id', enterpriseId).select('*');
  if (rTry.error) throw rTry.error;
  if (rTry.data && rTry.data.length > 0) {
    return { kind: 'restaurant', row: rTry.data[0] };
  }

  const bTry = await db.from('boutiques').update(patch).eq('id', enterpriseId).select('*');
  if (bTry.error) throw bTry.error;
  if (bTry.data && bTry.data.length > 0) {
    return { kind: 'boutique', row: bTry.data[0] };
  }

  return null;
}

async function findEnterpriseById(db, enterpriseId) {
  const { data: resto, error: rErr } = await db.from('restaurants').select('*').eq('id', enterpriseId).maybeSingle();
  if (rErr) throw rErr;
  if (resto) return { kind: 'restaurant', row: resto };

  const { data: bout, error: bErr } = await db.from('boutiques').select('*').eq('id', enterpriseId).maybeSingle();
  if (bErr) throw bErr;
  if (bout) return { kind: 'boutique', row: bout };

  return null;
}

async function getAdminStats(req, res, next) {
  try {
    const db = getDb();
    const [
      pendingRestaurants,
      pendingBoutiques,
      activeRestaurants,
      activeBoutiques,
      pendingUsers,
      ordersRes,
      livraisonsRes,
    ] = await Promise.all([
      db.from('restaurants').select('id', { count: 'exact', head: true }).eq('statut', 'en_attente'),
      db.from('boutiques').select('id', { count: 'exact', head: true }).eq('statut', 'en_attente'),
      db.from('restaurants').select('id', { count: 'exact', head: true }).eq('statut', 'active'),
      db.from('boutiques').select('id', { count: 'exact', head: true }).eq('statut', 'active'),
      db
        .from('utilisateurs')
        .select('id, role_id, est_approuve')
        .eq('est_approuve', false),
      db.from('commandes').select('id', { count: 'exact', head: true }),
      db.from('livraisons').select('id, type_livraison, sous_commande_id, statut'),
    ]);

    if (pendingRestaurants.error) throw pendingRestaurants.error;
    if (pendingBoutiques.error) throw pendingBoutiques.error;
    if (activeRestaurants.error) throw activeRestaurants.error;
    if (activeBoutiques.error) throw activeBoutiques.error;
    if (pendingUsers.error) throw pendingUsers.error;
    if (ordersRes.error) throw ordersRes.error;
    if (livraisonsRes.error) throw livraisonsRes.error;

    const livraisons = livraisonsRes.data || [];
    const livraisonsTotal = livraisons.length;
    const livraisonsExternes = livraisons.filter(
      (l) => l.type_livraison === 'externe' || !l.sous_commande_id,
    ).length;
    const livraisonsEnCours = livraisons.filter(
      (l) => !['livree', 'annulee'].includes(l.statut),
    ).length;

    const roleIds = [...new Set((pendingUsers.data || []).map((u) => u.role_id))];
    let merchantPendingCount = pendingUsers.data?.length || 0;
    if (roleIds.length > 0) {
      const { data: roles } = await db.from('roles').select('id, nom').in('id', roleIds);
      const merchantRoleIds = new Set(
        (roles || []).filter((r) => r.nom === 'restaurateur' || r.nom === 'commercant').map((r) => r.id),
      );
      merchantPendingCount = (pendingUsers.data || []).filter((u) => merchantRoleIds.has(u.role_id)).length;
    }

    return res.json({
      commerces_en_attente: (pendingRestaurants.count || 0) + (pendingBoutiques.count || 0),
      commerces_actifs: (activeRestaurants.count || 0) + (activeBoutiques.count || 0),
      comptes_marchands_en_attente: merchantPendingCount,
      commandes_total: ordersRes.count || 0,
      livraisons_total: livraisonsTotal,
      livraisons_externes: livraisonsExternes,
      livraisons_en_cours: livraisonsEnCours,
    });
  } catch (error) {
    return next(error);
  }
}

async function listAllEnterprises(req, res, next) {
  try {
    const { status, type, q } = req.query;
    const db = getDb();
    const search = typeof q === 'string' ? q.trim().toLowerCase() : '';

    let restaurants = [];
    let boutiques = [];

    if (!type || type === 'restaurant') {
      let query = db.from('restaurants').select('*').order('created_at', { ascending: false });
      if (status) query = query.eq('statut', status);
      const { data, error } = await query;
      if (error) throw error;
      restaurants = data || [];
    }

    if (!type || type === 'boutique') {
      let query = db.from('boutiques').select('*').order('created_at', { ascending: false });
      if (status) query = query.eq('statut', status);
      const { data, error } = await query;
      if (error) throw error;
      boutiques = data || [];
    }

    let merged = await mergeEnterprises(db, restaurants, boutiques);

    if (search) {
      merged = merged.filter((e) => {
        const hay = [e.nom, e.telephone, e.adresse_ligne1, e.proprietaire?.nom, e.proprietaire?.telephone]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return hay.includes(search);
      });
    }

    return res.json(merged);
  } catch (error) {
    return next(error);
  }
}

async function listEnterprisesPending(req, res, next) {
  req.query = { ...req.query, status: 'en_attente' };
  return listAllEnterprises(req, res, next);
}

async function getEnterpriseAdmin(req, res, next) {
  try {
    const { enterpriseId } = req.params;
    const db = getDb();
    const found = await findEnterpriseById(db, enterpriseId);
    if (!found) throw createHttpError(404, 'Commerce introuvable.');

    const owners = await loadOwnerMap(db, [found.row.proprietaire_id]);
    const owner = owners.get(found.row.proprietaire_id) || null;

    let products = [];
    if (found.kind === 'restaurant') {
      const { data, error } = await db.from('plats').select('*').eq('restaurant_id', enterpriseId).order('nom');
      if (error) throw error;
      products = (data || []).map((p) => ({
        id: p.id,
        nom: p.nom,
        prix: p.prix,
        est_disponible: p.est_disponible,
        kind: 'plat',
      }));
    } else {
      const { data, error } = await db.from('articles').select('*').eq('boutique_id', enterpriseId).order('nom');
      if (error) throw error;
      products = (data || []).map((a) => ({
        id: a.id,
        nom: a.nom,
        prix: a.prix,
        stock: a.stock,
        est_disponible: a.est_disponible,
        kind: 'article',
      }));
    }

    const mapped =
      found.kind === 'restaurant'
        ? mapRestaurantAdmin(found.row, owner)
        : mapBoutiqueAdmin(found.row, owner);

    const { getCommerceStatsForEnterprise } = require('../services/admin-commerce-stats.service');
    const stats = await getCommerceStatsForEnterprise(db, enterpriseId, found.kind);

    return res.json({ ...mapped, products, stats });
  } catch (error) {
    return next(error);
  }
}

async function activateEnterprise(req, res, next) {
  try {
    const { enterpriseId } = req.params;
    const db = getDb();
    const now = new Date().toISOString();

    const found = await findEnterpriseById(db, enterpriseId);
    if (!found) throw createHttpError(404, 'Commerce introuvable.');

    const updated = await updateEnterpriseById(db, enterpriseId, {
      statut: 'active',
      est_ouvert: true,
      approuve_par: req.auth.userId,
      approuve_at: now,
      note_moderation: null,
    });
    if (!updated) throw createHttpError(404, 'Commerce introuvable.');

    await approveOwnerUser(db, updated.row.proprietaire_id, req.auth.userId);

    const owners = await loadOwnerMap(db, [updated.row.proprietaire_id]);
    const owner = owners.get(updated.row.proprietaire_id) || null;
    const mapped =
      updated.kind === 'restaurant'
        ? mapRestaurantAdmin(updated.row, owner)
        : mapBoutiqueAdmin(updated.row, owner);

    return res.json(mapped);
  } catch (error) {
    return next(error);
  }
}

async function rejectEnterprise(req, res, next) {
  try {
    const { enterpriseId } = req.params;
    const { raison } = req.body || {};
    const db = getDb();

    const found = await findEnterpriseById(db, enterpriseId);
    if (!found) throw createHttpError(404, 'Commerce introuvable.');

    const updated = await updateEnterpriseById(db, enterpriseId, {
      statut: 'rejetee',
      est_ouvert: false,
      note_moderation: typeof raison === 'string' && raison.trim() ? raison.trim() : null,
    });
    if (!updated) throw createHttpError(404, 'Commerce introuvable.');

    const owners = await loadOwnerMap(db, [updated.row.proprietaire_id]);
    const owner = owners.get(updated.row.proprietaire_id) || null;
    const mapped =
      updated.kind === 'restaurant'
        ? mapRestaurantAdmin(updated.row, owner)
        : mapBoutiqueAdmin(updated.row, owner);

    return res.json(mapped);
  } catch (error) {
    return next(error);
  }
}

async function suspendEnterprise(req, res, next) {
  try {
    const { enterpriseId } = req.params;
    const db = getDb();

    const updated = await updateEnterpriseById(db, enterpriseId, {
      statut: 'suspendue',
      est_ouvert: false,
    });
    if (!updated) throw createHttpError(404, 'Commerce introuvable.');

    const owners = await loadOwnerMap(db, [updated.row.proprietaire_id]);
    const owner = owners.get(updated.row.proprietaire_id) || null;
    const mapped =
      updated.kind === 'restaurant'
        ? mapRestaurantAdmin(updated.row, owner)
        : mapBoutiqueAdmin(updated.row, owner);

    return res.json(mapped);
  } catch (error) {
    return next(error);
  }
}

async function listPendingUsers(req, res, next) {
  try {
    const db = getDb();
    const { data: users, error } = await db
      .from('utilisateurs')
      .select('id, nom, telephone, email, est_approuve, created_at, role_id')
      .eq('est_approuve', false)
      .order('created_at', { ascending: false });
    if (error) throw error;

    const roleIds = [...new Set((users || []).map((u) => u.role_id))];
    const { data: roles } = roleIds.length
      ? await db.from('roles').select('id, nom').in('id', roleIds)
      : { data: [] };
    const roleMap = new Map((roles || []).map((r) => [r.id, r.nom]));

    const filtered = (users || [])
      .filter((u) => {
        const role = roleMap.get(u.role_id);
        return role === 'restaurateur' || role === 'commercant';
      })
      .map((u) => ({
        id: u.id,
        nom: u.nom,
        telephone: u.telephone,
        email: u.email,
        est_approuve: u.est_approuve,
        created_at: u.created_at,
        role: roleMap.get(u.role_id) || null,
      }));

    return res.json(filtered);
  } catch (error) {
    return next(error);
  }
}

async function approveUser(req, res, next) {
  try {
    const { userId } = req.params;
    const db = getDb();

    const { data: user, error } = await db
      .from('utilisateurs')
      .update({ est_approuve: true, raison_rejet: null })
      .eq('id', userId)
      .select('id, nom, telephone, email, est_approuve, created_at, role_id')
      .maybeSingle();
    if (error) throw error;
    if (!user) throw createHttpError(404, 'Utilisateur introuvable.');

    const { data: roleRow } = await db.from('roles').select('nom').eq('id', user.role_id).maybeSingle();

    return res.json({
      ...user,
      role: roleRow?.nom ?? null,
    });
  } catch (error) {
    return next(error);
  }
}

async function rejectUser(req, res, next) {
  try {
    const { userId } = req.params;
    const { raison } = req.body || {};
    const db = getDb();

    const { data: user, error } = await db
      .from('utilisateurs')
      .update({
        est_approuve: false,
        est_actif: false,
        raison_rejet: typeof raison === 'string' && raison.trim() ? raison.trim() : null,
      })
      .eq('id', userId)
      .select('id, nom, telephone, email, est_approuve, created_at, role_id')
      .maybeSingle();
    if (error) throw error;
    if (!user) throw createHttpError(404, 'Utilisateur introuvable.');

    const { data: roleRow } = await db.from('roles').select('nom').eq('id', user.role_id).maybeSingle();

    return res.json({
      ...user,
      role: roleRow?.nom ?? null,
    });
  } catch (error) {
    return next(error);
  }
}

function mapCommandeAdmin(c, client) {
  const snap = c.adresse_livraison_snapshot;
  let addr = null;
  if (snap && typeof snap === 'object' && snap.texte) addr = snap.texte;
  else if (typeof snap === 'string') addr = snap;
  return {
    id: c.id,
    numero: c.numero,
    statut: c.statut,
    total: Number(c.total ?? 0),
    sous_total: Number(c.sous_total ?? 0),
    frais_livraison_total: Number(c.frais_livraison_total ?? 0),
    remise_totale: Number(c.remise_totale ?? 0),
    adresse_livraison: addr,
    created_at: c.created_at,
    created_at_label: formatDateTimeFr(c.created_at),
    ...mapTimestampFields(c, COMMANDE_TIMESTAMP_FIELDS),
    client: client
      ? { id: client.id, nom: client.nom, telephone: client.telephone, email: client.email }
      : null,
  };
}

async function listAdminOrders(req, res, next) {
  try {
    const { status, q } = req.query;
    const db = getDb();
    let query = db.from('commandes').select('*').order('created_at', { ascending: false });
    if (status) query = query.eq('statut', status);
    const { data: commandes, error } = await query;
    if (error) throw error;

    const clientIds = [...new Set((commandes || []).map((c) => c.client_id))];
    const { data: clients } = clientIds.length
      ? await db.from('utilisateurs').select('id, nom, telephone, email').in('id', clientIds)
      : { data: [] };
    const clientMap = new Map((clients || []).map((u) => [u.id, u]));

    let out = (commandes || []).map((c) => mapCommandeAdmin(c, clientMap.get(c.client_id)));

    const search = typeof q === 'string' ? q.trim().toLowerCase() : '';
    if (search) {
      out = out.filter((o) => {
        const hay = [o.numero, o.client?.nom, o.client?.telephone, o.client?.email]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return hay.includes(search);
      });
    }

    return res.json(out);
  } catch (error) {
    return next(error);
  }
}

async function getAdminOrderDetail(req, res, next) {
  try {
    const { orderId } = req.params;
    const db = getDb();

    const { data: order, error } = await db.from('commandes').select('*').eq('id', orderId).maybeSingle();
    if (error) throw error;
    if (!order) throw createHttpError(404, 'Commande introuvable.');

    const { data: client } = await db
      .from('utilisateurs')
      .select('id, nom, telephone, email')
      .eq('id', order.client_id)
      .maybeSingle();

    const { data: scs, error: scErr } = await db.from('sous_commandes').select('*').eq('commande_id', orderId);
    if (scErr) throw scErr;

    const enriched = [];
    for (const sc of scs || []) {
      const { data: items } = await db.from('sous_commande_items').select('*').eq('sous_commande_id', sc.id);
      let etablissement = null;
      if (sc.restaurant_id) {
        const { data: r } = await db.from('restaurants').select('id, nom, type:statut').eq('id', sc.restaurant_id).maybeSingle();
        if (r) etablissement = { id: r.id, nom: r.nom, type: 'restaurant' };
      } else if (sc.boutique_id) {
        const { data: b } = await db.from('boutiques').select('id, nom').eq('id', sc.boutique_id).maybeSingle();
        if (b) etablissement = { id: b.id, nom: b.nom, type: 'boutique' };
      }
      enriched.push({
        ...sc,
        etablissement,
        articles: items || [],
        total: Number(sc.total ?? 0),
        sous_total: Number(sc.sous_total ?? 0),
        frais_livraison: Number(sc.frais_livraison ?? 0),
        commission_ttc: Number(sc.commission_ttc ?? 0),
      });
    }

    const scIds = (scs || []).map((s) => s.id);
    let livraisons = [];
    if (scIds.length > 0) {
      const { data: livs } = await db.from('livraisons').select('*').in('sous_commande_id', scIds);
      livraisons = livs || [];
    }

    return res.json({
      ...mapCommandeAdmin(order, client),
      sous_commandes: enriched.map((sc) => ({
        ...sc,
        timeline: mapCommandeTimeline(order, [sc], livraisons.filter((l) => l.sous_commande_id === sc.id))
          .sous_commandes[0]?.timeline ?? [],
      })),
      livraisons: livraisons.map((liv) => ({
        id: liv.id,
        statut: liv.statut,
        livreur_id: liv.livreur_id,
        timeline: mapLivraisonTimeline(liv),
        created_at: liv.created_at,
        created_at_label: formatDateTimeFr(liv.created_at),
        attribuee_at: liv.attribuee_at,
        attribuee_at_label: formatDateTimeFr(liv.attribuee_at),
        collectee_at: liv.collectee_at,
        collectee_at_label: formatDateTimeFr(liv.collectee_at),
        livree_at: liv.livree_at,
        livree_at_label: formatDateTimeFr(liv.livree_at),
      })),
      timeline: mapCommandeTimeline(order, scs || [], livraisons),
    });
  } catch (error) {
    return next(error);
  }
}

function mapLogisticsAdmin(row, gestionnaire, nbLivreurs) {
  return {
    ...row,
    statut_moderation: row.statut,
    gestionnaire: gestionnaire || null,
    nb_livreurs: nbLivreurs ?? 0,
  };
}

async function listLogisticsCompanies(req, res, next) {
  try {
    const { status, q } = req.query;
    const db = getDb();
    let query = db.from('entreprises_logistiques').select('*').order('created_at', { ascending: false });
    if (status) query = query.eq('statut', status);
    const { data: rows, error } = await query;
    if (error) throw error;

    const gestIds = [...new Set((rows || []).map((r) => r.gestionnaire_id))];
    const { data: gestionnaires } = gestIds.length
      ? await db.from('utilisateurs').select('id, nom, telephone, email').in('id', gestIds)
      : { data: [] };
    const gestMap = new Map((gestionnaires || []).map((g) => [g.id, g]));

    const out = [];
    for (const row of rows || []) {
      const { count } = await db
        .from('livreurs')
        .select('id', { count: 'exact', head: true })
        .eq('entreprise_logistique_id', row.id);
      out.push(mapLogisticsAdmin(row, gestMap.get(row.gestionnaire_id), count || 0));
    }

    const search = typeof q === 'string' ? q.trim().toLowerCase() : '';
    const filtered = search
      ? out.filter((e) => {
          const hay = [e.nom, e.telephone, e.email, e.gestionnaire?.nom].filter(Boolean).join(' ').toLowerCase();
          return hay.includes(search);
        })
      : out;

    return res.json(filtered);
  } catch (error) {
    return next(error);
  }
}

async function getLogisticsCompanyAdmin(req, res, next) {
  try {
    const { companyId } = req.params;
    const db = getDb();
    const { data: row, error } = await db
      .from('entreprises_logistiques')
      .select('*')
      .eq('id', companyId)
      .maybeSingle();
    if (error) throw error;
    if (!row) throw createHttpError(404, 'Entreprise logistique introuvable.');

    const { data: gestionnaire } = await db
      .from('utilisateurs')
      .select('id, nom, telephone, email')
      .eq('id', row.gestionnaire_id)
      .maybeSingle();

    const { data: livreurs } = await db
      .from('livreurs')
      .select(
        'id, type_vehicule, est_disponible, est_approuve, nb_livraisons_total, nb_livraisons_reussies, plaque_immatriculation, utilisateur_id, created_at',
      )
      .eq('entreprise_logistique_id', companyId);

    const enrichedCouriers = [];
    for (const l of livreurs || []) {
      const { data: u } = l.utilisateur_id
        ? await db.from('utilisateurs').select('id, nom, telephone, email, est_actif').eq('id', l.utilisateur_id).maybeSingle()
        : { data: null };
      enrichedCouriers.push({
        ...l,
        utilisateur: u,
      });
    }

    const { data: recentLivraisons } = await db
      .from('livraisons')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(40);

    const courierIds = new Set((livreurs || []).map((x) => x.id));
    const companyDeliveries = (recentLivraisons || []).filter((liv) => liv.livreur_id && courierIds.has(liv.livreur_id));
    const recentMapped = [];
    for (const liv of companyDeliveries.slice(0, 15)) {
      recentMapped.push(await mapAdminDeliveryRow(db, liv));
    }

    const activeStatuses = new Set(['en_attente', 'attribuee', 'en_collecte', 'collectee', 'en_route']);
    const enCours = companyDeliveries.filter((d) => activeStatuses.has(d.statut));
    const enRetard = [];
    for (const liv of enCours) {
      const delay = classifyDeliveryDelay(liv);
      if (delay.en_retard) enRetard.push({ id: liv.id, ...delay });
    }

    const { getLogisticsStatsForCompany } = require('../services/logistics.service');
    const stats = await getLogisticsStatsForCompany(db, companyId);

    return res.json({
      ...mapLogisticsAdmin(row, gestionnaire, (livreurs || []).length),
      livreurs: enrichedCouriers,
      livraisons_recentes: recentMapped,
      resume_livraisons: {
        en_cours: enCours.length,
        en_retard: enRetard.length,
        retards: enRetard,
      },
      stats,
    });
  } catch (error) {
    return next(error);
  }
}

async function createLogisticsCompany(req, res, next) {
  try {
    const { nomEntreprise, telephoneEntreprise, emailEntreprise, zoneActivite, gestionnaire } = req.body || {};
    requireFields(req.body, ['nomEntreprise', 'gestionnaire']);
    requireFields(gestionnaire, ['nom', 'email', 'motDePasse']);

    const db = getDb();
    const { company, gestionnaire: gest } = await createLogisticsCompanyWithManager(db, {
      nomEntreprise,
      telephoneEntreprise,
      emailEntreprise,
      zoneActivite,
      gestionnaire,
      statut: 'active',
    });

    return res.status(201).json(mapLogisticsAdmin(company, gest, 0));
  } catch (error) {
    return next(error);
  }
}

async function createLogisticsCourier(req, res, next) {
  try {
    const { companyId } = req.params;
    const { nom, telephone, motDePasse, typeVehicule, plaqueImmatriculation } = req.body || {};
    requireFields(req.body, ['nom', 'telephone', 'motDePasse', 'typeVehicule']);

    const db = getDb();
    await assertCompanyAccess(db, { userId: req.auth.userId, role: req.auth.role, companyId });
    const livreur = await createCourierForCompany(db, companyId, {
      nom,
      telephone,
      motDePasse,
      typeVehicule,
      plaqueImmatriculation,
    });
    return res.status(201).json(livreur);
  } catch (error) {
    return next(error);
  }
}

async function suspendLogisticsCourier(req, res, next) {
  try {
    const { companyId, livreurId } = req.params;
    const db = getDb();
    await assertCompanyAccess(db, { userId: req.auth.userId, role: req.auth.role, companyId });
    const row = await suspendCourier(db, livreurId, companyId);
    return res.json(mapCourierPublic(row));
  } catch (error) {
    return next(error);
  }
}

async function activateLogisticsCourier(req, res, next) {
  try {
    const { companyId, livreurId } = req.params;
    const db = getDb();
    await assertCompanyAccess(db, { userId: req.auth.userId, role: req.auth.role, companyId });
    const row = await activateCourier(db, livreurId, companyId);
    return res.json(mapCourierPublic(row));
  } catch (error) {
    return next(error);
  }
}

async function updateLogisticsStatus(req, res, next) {
  try {
    const { companyId } = req.params;
    const { action, raison } = req.body || {};
    const db = getDb();
    const now = new Date().toISOString();

    let patch = {};
    if (action === 'activate') {
      patch = { statut: 'active', approuve_par: req.auth.userId, approuve_at: now, note_moderation: null };
    } else if (action === 'reject') {
      patch = {
        statut: 'rejetee',
        note_moderation: typeof raison === 'string' && raison.trim() ? raison.trim() : null,
      };
    } else if (action === 'suspend') {
      patch = { statut: 'suspendue' };
    } else {
      throw createHttpError(400, 'Action invalide (activate, reject, suspend).');
    }

    const { data, error } = await db
      .from('entreprises_logistiques')
      .update(patch)
      .eq('id', companyId)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw createHttpError(404, 'Entreprise logistique introuvable.');

    const { data: gestionnaire } = await db
      .from('utilisateurs')
      .select('id, nom, telephone, email')
      .eq('id', data.gestionnaire_id)
      .maybeSingle();

    return res.json(mapLogisticsAdmin(data, gestionnaire, 0));
  } catch (error) {
    return next(error);
  }
}

function addressFromDeliverySnapshot(snap) {
  if (snap && typeof snap === 'object' && snap.texte) return String(snap.texte);
  if (typeof snap === 'string') return snap;
  return '';
}

async function loadCommerceForLivraison(db, liv) {
  if (liv.restaurant_id) {
    const { data } = await db.from('restaurants').select('id, nom, type:statut').eq('id', liv.restaurant_id).maybeSingle();
    if (data) return { id: data.id, nom: data.nom, type: 'restaurant' };
  }
  if (liv.boutique_id) {
    const { data } = await db.from('boutiques').select('id, nom').eq('id', liv.boutique_id).maybeSingle();
    if (data) return { id: data.id, nom: data.nom, type: 'boutique' };
  }
  return null;
}

async function mapAdminDeliveryRow(db, liv) {
  const isExterne = liv.type_livraison === 'externe' || !liv.sous_commande_id;
  let commande = null;
  let sousCommande = null;
  const commerce = await loadCommerceForLivraison(db, liv);

  if (!isExterne && liv.sous_commande_id) {
    const { data: sc } = await db.from('sous_commandes').select('*').eq('id', liv.sous_commande_id).maybeSingle();
    sousCommande = sc;
    if (sc?.commande_id) {
      const { data: c } = await db
        .from('commandes')
        .select('id, numero, statut, created_at, client_id')
        .eq('id', sc.commande_id)
        .maybeSingle();
      commande = c;
    }
  }

  let livreur = null;
  let entrepriseLogistique = null;
  if (liv.livreur_id) {
    const { data: l } = await db
      .from('livreurs')
      .select('id, utilisateur_id, type_vehicule, entreprise_logistique_id, plaque_immatriculation')
      .eq('id', liv.livreur_id)
      .maybeSingle();
    if (l?.utilisateur_id) {
      const { data: u } = await db.from('utilisateurs').select('nom, telephone').eq('id', l.utilisateur_id).maybeSingle();
      livreur = {
        id: l.id,
        nom: u?.nom,
        telephone: u?.telephone,
        type_vehicule: l.type_vehicule,
        plaque_immatriculation: l.plaque_immatriculation,
      };
    }
    if (l?.entreprise_logistique_id) {
      const { data: ent } = await db
        .from('entreprises_logistiques')
        .select('id, nom, telephone')
        .eq('id', l.entreprise_logistique_id)
        .maybeSingle();
      entrepriseLogistique = ent;
    }
  }

  const adresse = addressFromDeliverySnapshot(liv.adresse_livraison_snapshot);
  const adresseRetrait = addressFromDeliverySnapshot(liv.adresse_collecte_snapshot);
  const delay = classifyDeliveryDelay(liv);

  return {
    id: liv.id,
    type_livraison: isExterne ? 'externe' : 'commande',
    statut: liv.statut,
    created_at: liv.created_at,
    created_at_label: formatDateTimeFr(liv.created_at),
    attribuee_at: liv.attribuee_at,
    attribuee_at_label: formatDateTimeFr(liv.attribuee_at),
    collectee_at: liv.collectee_at,
    collectee_at_label: formatDateTimeFr(liv.collectee_at),
    livree_at: liv.livree_at,
    livree_at_label: formatDateTimeFr(livree_at),
    commande_created_at: commande?.created_at ?? null,
    commande_created_at_label: formatDateTimeFr(commande?.created_at),
    timeline: mapLivraisonTimeline(liv),
    adresse,
    adresse_retrait: adresseRetrait,
    commande,
    sous_commande: sousCommande,
    sous_commande_id: liv.sous_commande_id,
    commerce,
    commerce_nom: commerce?.nom ?? null,
    client_nom: liv.client_nom ?? null,
    client_telephone: liv.client_telephone ?? null,
    montant_total: liv.montant_total != null ? Number(liv.montant_total) : null,
    note: liv.note ?? null,
    livreur,
    entreprise_logistique: entrepriseLogistique,
    en_retard: delay.en_retard,
    type_retard: delay.type_retard,
    minutes_retard: delay.minutes_retard,
  };
}

async function listAdminDeliveries(req, res, next) {
  try {
    const { status, type: typeFilter } = req.query;
    const db = getDb();
    let query = db.from('livraisons').select('*').order('created_at', { ascending: false });
    if (status) query = query.eq('statut', status);
    const { data: livraisons, error } = await query;
    if (error) throw error;

    let rows = livraisons || [];
    if (typeFilter === 'externe') {
      rows = rows.filter((l) => l.type_livraison === 'externe' || !l.sous_commande_id);
    } else if (typeFilter === 'commande') {
      rows = rows.filter((l) => l.type_livraison !== 'externe' && l.sous_commande_id);
    }

    const out = [];
    for (const liv of rows) {
      out.push(await mapAdminDeliveryRow(db, liv));
    }

    void notifyDeliveryDelaysForList(db, livraisons || []).catch(() => undefined);

    return res.json(out);
  } catch (error) {
    return next(error);
  }
}

async function getAdminDeliveryDetail(req, res, next) {
  try {
    const { deliveryId } = req.params;
    const db = getDb();
    const { data: liv, error } = await db.from('livraisons').select('*').eq('id', deliveryId).maybeSingle();
    if (error) throw error;
    if (!liv) throw createHttpError(404, 'Livraison introuvable.');
    return res.json(await mapAdminDeliveryRow(db, liv));
  } catch (error) {
    return next(error);
  }
}

async function listAdminCouriers(req, res, next) {
  try {
    const db = getDb();
    const { data: livreurs, error } = await db.from('livreurs').select('*').order('created_at', { ascending: false });
    if (error) throw error;

    const userIds = [...new Set((livreurs || []).map((l) => l.utilisateur_id))];
    const { data: users } = userIds.length
      ? await db.from('utilisateurs').select('id, nom, telephone, email').in('id', userIds)
      : { data: [] };
    const userMap = new Map((users || []).map((u) => [u.id, u]));

    return res.json(
      (livreurs || []).map((l) => ({
        ...l,
        utilisateur: userMap.get(l.utilisateur_id) || null,
      })),
    );
  } catch (error) {
    return next(error);
  }
}

async function assignDeliveryCourier(req, res, next) {
  try {
    const { deliveryId } = req.params;
    const { livreurId } = req.body || {};
    requireFields(req.body, ['livreurId']);
    const db = getDb();
    const { assignLivreurManually } = require('../services/dispatch.service');
    const data = await assignLivreurManually(db, deliveryId, livreurId, 'admin');
    return res.json(data);
  } catch (error) {
    return next(error);
  }
}

async function getAdminCommissions(req, res, next) {
  try {
    const db = getDb();
    const { resolveGolivraPlatformUserId } = require('../services/wallet.service');
    const golivraUserId = await resolveGolivraPlatformUserId(db);
    const { data: pf } = await db.from('portefeuilles').select('id').eq('utilisateur_id', golivraUserId).maybeSingle();

    const { data: txs, error } = pf
      ? await db
          .from('transactions_portefeuille')
          .select('*')
          .eq('portefeuille_id', pf.id)
          .eq('type', 'commission_golivra')
          .order('created_at', { ascending: false })
          .limit(200)
      : { data: [], error: null };
    if (error) throw error;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    let totalCommission = 0;
    let monthCommission = 0;
    const rows = [];

    for (const t of txs || []) {
      const m = Number(t.montant);
      totalCommission += m;
      if (t.created_at >= monthStart) monthCommission += m;
      rows.push({
        id: t.id,
        periode: t.created_at,
        etablissement: 'GoLivra (livraison)',
        livraisons: 1,
        montant: m,
        commission: m,
        statut: 'livree',
        description: t.description,
      });
    }

    const { data: pending } = await db
      .from('demandes_retrait')
      .select('montant')
      .eq('statut', 'en_attente');
    const reversements = (pending || []).reduce((a, r) => a + Number(r.montant), 0);

    return res.json({
      total_commission: totalCommission,
      commission_mois: monthCommission,
      reversements_en_attente: reversements,
      factures_emises: rows.length,
      lignes: rows,
      note: 'Commissions uniquement sur frais de livraison — pas de commission sur ventes produits.',
    });
  } catch (error) {
    return next(error);
  }
}

async function getAdminPlatformWallet(req, res, next) {
  try {
    const { getPlatformWalletAdmin } = require('../services/wallet.service');
    const db = getDb();
    return res.json(await getPlatformWalletAdmin(db));
  } catch (error) {
    return next(error);
  }
}

async function listAdminWithdrawals(req, res, next) {
  try {
    const { listWithdrawalsAdmin } = require('../services/wallet.service');
    const db = getDb();
    const statut = typeof req.query.statut === 'string' ? req.query.statut.trim() : '';
    return res.json(await listWithdrawalsAdmin(db, { statut: statut || undefined }));
  } catch (error) {
    return next(error);
  }
}

async function processAdminWithdrawal(req, res, next) {
  try {
    const { processWithdrawalAdmin } = require('../services/wallet.service');
    const { retraitId } = req.params;
    const { action, note_admin } = req.body || {};
    const db = getDb();
    return res.json(
      await processWithdrawalAdmin(db, retraitId, req.auth.userId, { action, note_admin }),
    );
  } catch (error) {
    return next(error);
  }
}

async function getAdminCharts(req, res, next) {
  try {
    const db = getDb();
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceIso = since.toISOString();

    const { data: orders, error: ordErr } = await db
      .from('commandes')
      .select('id, created_at, statut, total')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: true });
    if (ordErr) throw ordErr;

    const ordersByDay = new Map();
    for (let i = 0; i < days; i += 1) {
      const d = new Date();
      d.setDate(d.getDate() - (days - 1 - i));
      const key = d.toISOString().slice(0, 10);
      ordersByDay.set(key, { date: key, count: 0, revenue_fcfa: 0 });
    }

    for (const o of orders || []) {
      const key = String(o.created_at || '').slice(0, 10);
      if (!ordersByDay.has(key)) continue;
      const row = ordersByDay.get(key);
      row.count += 1;
      if (o.statut !== 'annulee') {
        row.revenue_fcfa += Number(o.total || 0);
      }
    }

    const { resolveGolivraPlatformUserId } = require('../services/wallet.service');
    const golivraUserId = await resolveGolivraPlatformUserId(db);
    const { data: pf } = await db.from('portefeuilles').select('id').eq('utilisateur_id', golivraUserId).maybeSingle();

    const commissionsByDay = new Map();
    for (const key of ordersByDay.keys()) {
      commissionsByDay.set(key, { date: key, amount_fcfa: 0 });
    }

    if (pf?.id) {
      const { data: txs, error: txErr } = await db
        .from('transactions_portefeuille')
        .select('montant, created_at')
        .eq('portefeuille_id', pf.id)
        .eq('type', 'commission_golivra')
        .gte('created_at', sinceIso);
      if (txErr) throw txErr;
      for (const t of txs || []) {
        const key = String(t.created_at || '').slice(0, 10);
        if (!commissionsByDay.has(key)) continue;
        commissionsByDay.get(key).amount_fcfa += Number(t.montant || 0);
      }
    }

    return res.json({
      days,
      orders_by_day: [...ordersByDay.values()],
      commissions_by_day: [...commissionsByDay.values()],
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getAdminStats,
  getAdminCharts,
  listAllEnterprises,
  listEnterprisesPending,
  getEnterpriseAdmin,
  activateEnterprise,
  rejectEnterprise,
  suspendEnterprise,
  listPendingUsers,
  approveUser,
  rejectUser,
  createCourier,
  listAdminCouriers,
  listAdminOrders,
  getAdminOrderDetail,
  listLogisticsCompanies,
  getLogisticsCompanyAdmin,
  createLogisticsCompany,
  updateLogisticsStatus,
  listAdminDeliveries,
  getAdminDeliveryDetail,
  getAdminCommissions,
  getAdminPlatformWallet,
  listAdminWithdrawals,
  processAdminWithdrawal,
};
