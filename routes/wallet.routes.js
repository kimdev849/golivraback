const express = require('express');
const {
  getMyWallet,
  requestWithdrawal,
  getWithdrawalInfo,
  getPlatformWallet,
  listAdminWithdrawals,
  processAdminWithdrawal,
} = require('../controllers/wallet.controller');
const { authMiddleware } = require('../middlewares/auth.middleware');
const { requireRoles } = require('../middlewares/role.middleware');

const router = express.Router();

const walletRoles = [
  'client',
  'restaurateur',
  'commercant',
  'livreur',
  'gestionnaire_logistique',
  'admin',
];

router.get('/info-retrait', authMiddleware, getWithdrawalInfo);
router.get('/me', authMiddleware, requireRoles(walletRoles), getMyWallet);
router.post('/retraits', authMiddleware, requireRoles(walletRoles), requestWithdrawal);

router.get('/admin/plateforme', authMiddleware, requireRoles(['admin']), getPlatformWallet);
router.get('/admin/retraits', authMiddleware, requireRoles(['admin']), listAdminWithdrawals);
router.patch('/admin/retraits/:retraitId', authMiddleware, requireRoles(['admin']), processAdminWithdrawal);

module.exports = router;
