const { getDb } = require('../config/db');
const { createHttpError, requireFields } = require('../utils/http');
const {
  getWalletDashboard,
  createWithdrawalRequest,
  getPlatformWalletAdmin,
  listWithdrawalsAdmin,
  processWithdrawalAdmin,
  MIN_RETRAIT_FCFA,
} = require('../services/wallet.service');

async function getMyWallet(req, res, next) {
  try {
    const db = getDb();
    const data = await getWalletDashboard(db, req.auth.userId);
    return res.json(data);
  } catch (error) {
    return next(error);
  }
}

async function requestWithdrawal(req, res, next) {
  try {
    requireFields(req.body, ['montant', 'numero_compte']);
    const db = getDb();
    const row = await createWithdrawalRequest(db, req.auth.userId, req.body, { role: req.auth.role });
    return res.status(201).json(row);
  } catch (error) {
    return next(error);
  }
}

async function getWithdrawalInfo(req, res) {
  return res.json({
    montant_minimum_fcfa: MIN_RETRAIT_FCFA,
    methodes: ['airtel_money', 'mtn_money'],
    delai_traitement: 'Immédiat pour commerces et entreprises logistiques',
    validation_admin_requise: false,
    note: 'GoLivra (admin) : retrait sans plafond minimum.',
  });
}

async function getPlatformWallet(req, res, next) {
  try {
    const db = getDb();
    const data = await getPlatformWalletAdmin(db);
    return res.json(data);
  } catch (error) {
    return next(error);
  }
}

async function listAdminWithdrawals(req, res, next) {
  try {
    const db = getDb();
    const statut = typeof req.query.statut === 'string' ? req.query.statut.trim() : '';
    const rows = await listWithdrawalsAdmin(db, { statut: statut || undefined });
    return res.json(rows);
  } catch (error) {
    return next(error);
  }
}

async function processAdminWithdrawal(req, res, next) {
  try {
    const { retraitId } = req.params;
    const { action, note_admin } = req.body || {};
    if (!action) throw createHttpError(400, 'Indiquez action : approuver ou rejeter.');
    const db = getDb();
    const row = await processWithdrawalAdmin(db, retraitId, req.auth.userId, {
      action,
      note_admin,
    });
    return res.json(row);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getMyWallet,
  requestWithdrawal,
  getWithdrawalInfo,
  getPlatformWallet,
  listAdminWithdrawals,
  processAdminWithdrawal,
};
