const { getDb } = require('../config/db');
const { requireFields, createHttpError } = require('../utils/http');
const {
  getCompanyById,
  getCompanyByGestionnaire,
  listCouriersForCompany,
  createCourierForCompany,
  suspendCourier,
  activateCourier,
  setCourierAvailability,
  getCourierDetailForCompany,
  mapCourierPublic,
  listDeliveriesForLogisticsCompany,
  retryAutoDispatchForCompany,
  getLogisticsStatsForCompany,
  getOperationsForCompany,
  getDelaysForCompany,
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

async function getMyWallet(req, res, next) {
  try {
    const { getWalletDashboard } = require('../services/wallet.service');
    const db = getDb();
    const data = await getWalletDashboard(db, req.auth.userId);
    return res.json(data);
  } catch (error) {
    return next(error);
  }
}

async function getMyStats(req, res, next) {
  try {
    const company = req.logisticsCompany;
    const db = getDb();
    const stats = await getLogisticsStatsForCompany(db, company.id);
    return res.json(stats);
  } catch (error) {
    return next(error);
  }
}

async function getMyOperations(req, res, next) {
  try {
    const company = req.logisticsCompany;
    const db = getDb();
    const ops = await getOperationsForCompany(db, company.id);
    return res.json(ops);
  } catch (error) {
    return next(error);
  }
}

async function getMyDelays(req, res, next) {
  try {
    const company = req.logisticsCompany;
    const db = getDb();
    const delays = await getDelaysForCompany(db, company.id);
    return res.json(delays);
  } catch (error) {
    return next(error);
  }
}

async function getMyCourier(req, res, next) {
  try {
    const { livreurId } = req.params;
    const company = req.logisticsCompany;
    const db = getDb();
    const detail = await getCourierDetailForCompany(db, company.id, livreurId);
    return res.json(detail);
  } catch (error) {
    return next(error);
  }
}

async function updateMyCourierAvailability(req, res, next) {
  try {
    const { livreurId } = req.params;
    const { disponible } = req.body || {};
    if (typeof disponible !== 'boolean') {
      throw createHttpError(400, 'Indiquez disponible: true ou false.');
    }
    const company = req.logisticsCompany;
    const db = getDb();
    const row = await setCourierAvailability(db, livreurId, company.id, disponible);
    return res.json(mapCourierPublic(row));
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

async function listMyDeliveries(req, res, next) {
  try {
    const company = req.logisticsCompany;
    const db = getDb();
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : undefined;
    const livraisons = await listDeliveriesForLogisticsCompany(db, company.id, { status });
    return res.json(livraisons);
  } catch (error) {
    return next(error);
  }
}

async function retryMyDeliveryDispatch(req, res, next) {
  try {
    const company = req.logisticsCompany;
    const { deliveryId } = req.params;
    const db = getDb();
    const row = await retryAutoDispatchForCompany(db, company.id, deliveryId);
    return res.json(row);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getMyCompany,
  getMyWallet,
  getMyStats,
  getMyOperations,
  getMyDelays,
  listMyCouriers,
  getMyCourier,
  updateMyCourierAvailability,
  createMyCourier,
  suspendMyCourier,
  activateMyCourier,
  listMyDeliveries,
  retryMyDeliveryDispatch,
};
