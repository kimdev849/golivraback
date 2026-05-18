const bcrypt = require('bcryptjs');
const { createHttpError } = require('../utils/http');
const { normalizeCgE164 } = require('../utils/phone');
const { revokeUserSessions } = require('./session.service');

const VEHICLE_TYPES = new Set(['moto', 'voiture', 'velo', 'pied']);

function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!email || !email.includes('@') || email.length > 255) return null;
  return email;
}

async function getRoleId(db, roleName) {
  const { data, error } = await db.from('roles').select('id').eq('nom', roleName).maybeSingle();
  if (error) throw error;
  if (!data) {
    throw createHttpError(
      503,
      `Rôle « ${roleName} » absent en base. Dans Supabase → SQL Editor : exécutez d'abord sql/amendments-v4-logistics-tenant.sql (étape 1), puis sql/amendments-v4-logistics-tenant-step2.sql (étape 2).`,
    );
  }
  return data.id;
}

async function createUserWithRole(db, { nom, roleName, email, telephone, motDePasse, estApprouve = true }) {
  if (typeof motDePasse !== 'string' || motDePasse.length < 6) {
    throw createHttpError(400, 'Mot de passe requis (6 caractères minimum).');
  }

  const roleId = await getRoleId(db, roleName);
  const hashedPassword = await bcrypt.hash(motDePasse, 10);
  const insert = {
    nom: nom.trim(),
    mot_de_passe_hash: hashedPassword,
    role_id: roleId,
    est_verifie: true,
    est_approuve: estApprouve,
    est_actif: true,
  };

  if (email) {
    const normalized = normalizeEmail(email);
    if (!normalized) throw createHttpError(400, 'Adresse e-mail invalide.');
    insert.email = normalized;
  }

  if (telephone) {
    const normalizedTel = normalizeCgE164(telephone);
    if (!normalizedTel) {
      throw createHttpError(400, 'Numéro de téléphone invalide. Indiquez +242 suivi de 9 chiffres (Congo).');
    }
    insert.telephone = normalizedTel;
  }

  const { data, error } = await db
    .from('utilisateurs')
    .insert(insert)
    .select('id, nom, telephone, email, role_id, est_approuve, est_actif, created_at')
    .single();

  if (error) {
    if (error.code === '23505') throw createHttpError(409, 'E-mail ou téléphone déjà enregistré.');
    throw error;
  }

  return data;
}

async function getCompanyById(db, companyId) {
  const { data, error } = await db
    .from('entreprises_logistiques')
    .select('*')
    .eq('id', companyId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getCompanyByGestionnaire(db, gestionnaireId) {
  const { data, error } = await db
    .from('entreprises_logistiques')
    .select('*')
    .eq('gestionnaire_id', gestionnaireId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function assertCompanyActive(company) {
  if (!company) throw createHttpError(404, 'Entreprise logistique introuvable.');
  if (company.statut !== 'active') {
    throw createHttpError(403, 'Cette entreprise logistique n\'est pas active.');
  }
}

async function assertCompanyAccess(db, { userId, role, companyId }) {
  const company = await getCompanyById(db, companyId);
  if (!company) throw createHttpError(404, 'Entreprise logistique introuvable.');
  if (role === 'admin') return company;
  if (role === 'gestionnaire_logistique' && company.gestionnaire_id === userId) return company;
  throw createHttpError(403, 'Accès refusé à cette entreprise logistique.');
}

async function createLogisticsCompanyWithManager(db, payload) {
  const {
    nomEntreprise,
    telephoneEntreprise,
    emailEntreprise,
    description,
    zoneActivite,
    commissionPct,
    adresseLigne1,
    adresseVille,
    gestionnaire,
    statut = 'active',
  } = payload;

  const { nom, email, motDePasse, telephone: telGestionnaire } = gestionnaire;
  const manager = await createUserWithRole(db, {
    nom,
    email,
    telephone: telGestionnaire || null,
    motDePasse,
    roleName: 'gestionnaire_logistique',
    estApprouve: true,
  });

  const { data: company, error } = await db
    .from('entreprises_logistiques')
    .insert({
      gestionnaire_id: manager.id,
      nom: nomEntreprise.trim(),
      telephone: telephoneEntreprise || null,
      email: emailEntreprise ? normalizeEmail(emailEntreprise) : null,
      description: description || null,
      zone_activite: zoneActivite || null,
      commission_pct: commissionPct != null ? Number(commissionPct) : 15,
      adresse_ligne1: adresseLigne1 || null,
      adresse_ville: adresseVille || 'Brazzaville',
      statut,
    })
    .select('*')
    .single();

  if (error) {
    await db.from('utilisateurs').delete().eq('id', manager.id);
    throw error;
  }

  return { company, gestionnaire: manager };
}

async function getLivreurInCompany(db, livreurId, companyId) {
  const { data: livreur, error } = await db
    .from('livreurs')
    .select('*')
    .eq('id', livreurId)
    .eq('entreprise_logistique_id', companyId)
    .maybeSingle();
  if (error) throw error;
  if (!livreur) throw createHttpError(404, 'Livreur introuvable pour cette entreprise.');

  const { data: utilisateur } = await db
    .from('utilisateurs')
    .select('id, nom, telephone, email, est_actif, est_approuve')
    .eq('id', livreur.utilisateur_id)
    .maybeSingle();

  return { ...livreur, utilisateur: utilisateur || null };
}

function mapCourierPublic(row) {
  const u = row.utilisateur || row.utilisateur_id;
  const user = typeof u === 'object' && u !== null ? u : null;
  return {
    id: row.id,
    type_vehicule: row.type_vehicule,
    est_disponible: row.est_disponible,
    est_approuve: row.est_approuve,
    nb_livraisons_total: row.nb_livraisons_total,
    nb_livraisons_reussies: row.nb_livraisons_reussies,
    plaque_immatriculation: row.plaque_immatriculation,
    created_at: row.created_at,
    utilisateur: user
      ? {
          id: user.id,
          nom: user.nom,
          telephone: user.telephone,
          email: user.email,
          est_actif: user.est_actif,
        }
      : null,
  };
}

async function listCouriersForCompany(db, companyId) {
  const { data: livreurs, error } = await db
    .from('livreurs')
    .select('id, type_vehicule, est_disponible, est_approuve, nb_livraisons_total, nb_livraisons_reussies, plaque_immatriculation, created_at, utilisateur_id')
    .eq('entreprise_logistique_id', companyId)
    .order('created_at', { ascending: false });
  if (error) throw error;

  const userIds = [...new Set((livreurs || []).map((l) => l.utilisateur_id))];
  const { data: users } = userIds.length
    ? await db.from('utilisateurs').select('id, nom, telephone, email, est_actif').in('id', userIds)
    : { data: [] };
  const userMap = new Map((users || []).map((u) => [u.id, u]));

  return (livreurs || []).map((l) =>
    mapCourierPublic({
      ...l,
      utilisateur: userMap.get(l.utilisateur_id) || null,
    }),
  );
}

async function createCourierForCompany(db, companyId, payload) {
  const { nom, telephone, motDePasse, typeVehicule, plaqueImmatriculation } = payload;

  const type = typeof typeVehicule === 'string' ? typeVehicule.trim().toLowerCase() : '';
  if (!VEHICLE_TYPES.has(type)) {
    throw createHttpError(400, 'Type de véhicule invalide (moto, voiture, velo, pied).');
  }

  const company = await getCompanyById(db, companyId);
  assertCompanyActive(company);

  const user = await createUserWithRole(db, {
    nom,
    telephone,
    motDePasse,
    roleName: 'livreur',
    estApprouve: true,
  });

  const { data: livreur, error } = await db
    .from('livreurs')
    .insert({
      utilisateur_id: user.id,
      entreprise_logistique_id: companyId,
      type_vehicule: type,
      plaque_immatriculation: plaqueImmatriculation || null,
      est_disponible: false,
      est_approuve: true,
    })
    .select('*')
    .single();

  if (error) {
    await db.from('utilisateurs').delete().eq('id', user.id);
    if (error.code === '23505') throw createHttpError(409, 'Ce compte a déjà un profil livreur.');
    throw error;
  }

  return mapCourierPublic({ ...livreur, utilisateur: user });
}

async function suspendCourier(db, livreurId, companyId) {
  const livreur = await getLivreurInCompany(db, livreurId, companyId);

  await db
    .from('utilisateurs')
    .update({ est_actif: false })
    .eq('id', livreur.utilisateur_id);

  await db
    .from('livreurs')
    .update({ est_disponible: false, est_approuve: false })
    .eq('id', livreurId);

  await revokeUserSessions(db, livreur.utilisateur_id);

  return getLivreurInCompany(db, livreurId, companyId);
}

async function activateCourier(db, livreurId, companyId) {
  const livreur = await getLivreurInCompany(db, livreurId, companyId);

  await db
    .from('utilisateurs')
    .update({ est_actif: true, est_approuve: true })
    .eq('id', livreur.utilisateur_id);

  await db.from('livreurs').update({ est_approuve: true }).eq('id', livreurId);

  return getLivreurInCompany(db, livreurId, companyId);
}

module.exports = {
  VEHICLE_TYPES,
  normalizeEmail,
  getRoleId,
  getCompanyById,
  getCompanyByGestionnaire,
  assertCompanyActive,
  assertCompanyAccess,
  createLogisticsCompanyWithManager,
  listCouriersForCompany,
  createCourierForCompany,
  suspendCourier,
  activateCourier,
  mapCourierPublic,
};
