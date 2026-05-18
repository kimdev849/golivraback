const { getDb } = require('../config/db');
const { requireFields, createHttpError } = require('../utils/http');
const {
  getCompanyById,
  getCompanyByGestionnaire,
  listCouriersForCompany,
  createCourierForCompany,
  suspendCourier,
  activateCourier,
  mapCourierPublic,
} = require('../services/logistics.service');

async function getMyCompany(req, res, next) {
  try {
    const db = getDb();
    let company;
    if (req.auth.role === 'admin' && req.query.companyId) {
      company = await getCompanyById(db, req.query.companyId);
    } else if (req.auth.role === 'gestionnaire_logistique') {
      company = await getCompanyByGestionnaire(db, req.auth.userId);
    } else {
      throw createHttpError(403, 'Accès réservé aux gestionnaires logistique.');
    }

    if (!company) throw createHttpError(404, 'Entreprise logistique introuvable.');

    const { data: gestionnaire } = await db
      .from('utilisateurs')
      .select('id, nom, telephone, email')
      .eq('id', company.gestionnaire_id)
      .maybeSingle();

    const livreurs = await listCouriersForCompany(db, company.id);

    return res.json({
      ...company,
      statut_moderation: company.statut,
      gestionnaire: gestionnaire || null,
      nb_livreurs: livreurs.length,
      livreurs,
    });
  } catch (error) {
    return next(error);
  }
}

async function listMyCouriers(req, res, next) {
  try {
    const company = req.logisticsCompany;
    const db = getDb();
    const livreurs = await listCouriersForCompany(db, company.id);
    return res.json(livreurs);
  } catch (error) {
    return next(error);
  }
}

async function createMyCourier(req, res, next) {
  try {
    const company = req.logisticsCompany;
    const { nom, telephone, motDePasse, typeVehicule, plaqueImmatriculation } = req.body;
    requireFields(req.body, ['nom', 'telephone', 'motDePasse', 'typeVehicule']);

    const db = getDb();
    const livreur = await createCourierForCompany(db, company.id, {
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

async function suspendMyCourier(req, res, next) {
  try {
    const { livreurId } = req.params;
    const company = req.logisticsCompany;
    const db = getDb();
    const row = await suspendCourier(db, livreurId, company.id);
    return res.json(mapCourierPublic(row));
  } catch (error) {
    return next(error);
  }
}

async function activateMyCourier(req, res, next) {
  try {
    const { livreurId } = req.params;
    const company = req.logisticsCompany;
    const db = getDb();
    const row = await activateCourier(db, livreurId, company.id);
    return res.json(mapCourierPublic(row));
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getMyCompany,
  listMyCouriers,
  createMyCourier,
  suspendMyCourier,
  activateMyCourier,
};
