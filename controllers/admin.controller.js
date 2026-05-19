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
} = require('../services/logistics.service');

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
    ]);

    if (pendingRestaurants.error) throw pendingRestaurants.error;
    if (pendingBoutiques.error) throw pendingBoutiques.error;
    if (activeRestaurants.error) throw activeRestaurants.error;
    if (activeBoutiques.error) throw activeBoutiques.error;
    if (pendingUsers.error) throw pendingUsers.error;
    if (ordersRes.error) throw ordersRes.error;

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

    return res.json({ ...mapped, products });
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
    adresse_livraison: addr,
    created_at: c.created_at,
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

    return res.json({
      ...mapCommandeAdmin(order, client),
      sous_commandes: enriched,
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
      .select('id, type_vehicule, est_disponible, est_approuve, nb_livraisons_total, nb_livraisons_reussies')
      .eq('entreprise_logistique_id', companyId);

    return res.json({
      ...mapLogisticsAdmin(row, gestionnaire, (livreurs || []).length),
      livreurs: livreurs || [],
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

async function listAdminDeliveries(req, res, next) {
  try {
    const { status } = req.query;
    const db = getDb();
    let query = db.from('livraisons').select('*').order('created_at', { ascending: false });
    if (status) query = query.eq('statut', status);
    const { data: livraisons, error } = await query;
    if (error) throw error;

    const out = [];
    for (const liv of livraisons || []) {
      const { data: sc } = await db.from('sous_commandes').select('*').eq('id', liv.sous_commande_id).maybeSingle();
      let commande = null;
      if (sc?.commande_id) {
        const { data: c } = await db.from('commandes').select('id, numero, statut, created_at').eq('id', sc.commande_id).maybeSingle();
        commande = c;
      }
      let livreur = null;
      if (liv.livreur_id) {
        const { data: l } = await db.from('livreurs').select('id, utilisateur_id, type_vehicule').eq('id', liv.livreur_id).maybeSingle();
        if (l?.utilisateur_id) {
          const { data: u } = await db.from('utilisateurs').select('nom, telephone').eq('id', l.utilisateur_id).maybeSingle();
          livreur = { id: l.id, nom: u?.nom, telephone: u?.telephone, type_vehicule: l.type_vehicule };
        }
      }
      const snap = liv.adresse_livraison_snapshot;
      let adresse = '';
      if (snap && typeof snap === 'object' && snap.texte) adresse = snap.texte;
      else if (typeof snap === 'string') adresse = snap;

      out.push({
        id: liv.id,
        statut: liv.statut,
        created_at: liv.created_at,
        attribuee_at: liv.attribuee_at,
        livree_at: liv.livree_at,
        adresse,
        commande,
        sous_commande_id: liv.sous_commande_id,
        livreur,
      });
    }

    return res.json(out);
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
    const { data: scs, error } = await db
      .from('sous_commandes')
      .select('id, total, commission_ttc, commission_pct, created_at, restaurant_id, boutique_id, statut')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const totalCommission = (scs || []).reduce((acc, sc) => acc + Number(sc.commission_ttc ?? 0), 0);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const monthScs = (scs || []).filter((sc) => sc.created_at >= monthStart);
    const monthCommission = monthScs.reduce((acc, sc) => acc + Number(sc.commission_ttc ?? 0), 0);

    const rows = [];
    for (const sc of scs || []) {
      let etablissement = '—';
      if (sc.restaurant_id) {
        const { data: r } = await db.from('restaurants').select('nom').eq('id', sc.restaurant_id).maybeSingle();
        etablissement = r?.nom || 'Restaurant';
      } else if (sc.boutique_id) {
        const { data: b } = await db.from('boutiques').select('nom').eq('id', sc.boutique_id).maybeSingle();
        etablissement = b?.nom || 'Boutique';
      }
      rows.push({
        id: sc.id,
        periode: sc.created_at,
        etablissement,
        livraisons: 1,
        montant: Number(sc.total ?? 0),
        commission: Number(sc.commission_ttc ?? 0),
        statut: sc.statut,
      });
    }

    return res.json({
      total_commission: totalCommission,
      commission_mois: monthCommission,
      reversements_en_attente: monthCommission,
      factures_emises: (scs || []).length,
      lignes: rows,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getAdminStats,
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
  getAdminCommissions,
};
