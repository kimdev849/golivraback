const { getDb } = require('../config/db');
const { createHttpError } = require('../utils/http');
const { getActiveCouriersTracking } = require('../services/tracking.service');

/** Vue temps réel de TOUS les livreurs (toutes entreprises) — admin. */
async function getAdminActiveTracking(req, res, next) {
  try {
    const db = getDb();
    const data = await getActiveCouriersTracking(db, {});
    return res.json(data);
  } catch (error) {
    return next(error);
  }
}

/** Vue temps réel des livreurs de SA propre entreprise — gestionnaire logistique. */
async function getCompanyActiveTracking(req, res, next) {
  try {
    const company = req.logisticsCompany;
    if (!company) throw createHttpError(404, 'Entreprise logistique introuvable.');
    const db = getDb();
    const data = await getActiveCouriersTracking(db, { companyId: company.id });
    return res.json(data);
  } catch (error) {
    return next(error);
  }
}

module.exports = { getAdminActiveTracking, getCompanyActiveTracking };
