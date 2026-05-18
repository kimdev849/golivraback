const { getDb } = require('../config/db');
const { createHttpError } = require('../utils/http');
const { getCompanyByGestionnaire, assertCompanyActive } = require('../services/logistics.service');

/** Charge l'entreprise du gestionnaire connecté dans req.logisticsCompany */
async function loadGestionnaireCompany(req, res, next) {
  try {
    if (req.auth.role !== 'gestionnaire_logistique') {
      return next();
    }
    const db = getDb();
    const company = await getCompanyByGestionnaire(db, req.auth.userId);
    if (!company) {
      return res.status(404).json({ message: 'Aucune entreprise logistique associée à ce compte.' });
    }
    req.logisticsCompany = company;
    return next();
  } catch (err) {
    return next(err);
  }
}

function requireActiveLogisticsCompany(req, res, next) {
  try {
    const company = req.logisticsCompany;
    if (!company) throw createHttpError(404, 'Entreprise logistique introuvable.');
    assertCompanyActive(company);
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  loadGestionnaireCompany,
  requireActiveLogisticsCompany,
};
