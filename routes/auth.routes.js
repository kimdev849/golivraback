const express = require('express');
const {
  register,
  registerVendor,
  login,
  staffLogin,
  me,
  logout,
  updateProfile,
  changePassword,
  resetPassword,
  deleteAccount,
  getMyPreferences,
  patchMyPreferences,
} = require('../controllers/auth.controller');
const { authMiddleware } = require('../middlewares/auth.middleware');
const { requireBetaAccess } = require('../middlewares/beta-gate.middleware');

const router = express.Router();

router.post('/register', requireBetaAccess, register);
router.post('/register-vendor', requireBetaAccess, registerVendor);
router.post('/login', requireBetaAccess, login);
router.post('/staff/login', staffLogin);
router.post('/reset-password', resetPassword);
router.get('/me', authMiddleware, me);
router.patch('/me', authMiddleware, updateProfile);
router.get('/preferences', authMiddleware, getMyPreferences);
router.patch('/preferences', authMiddleware, patchMyPreferences);
router.post('/change-password', authMiddleware, changePassword);
router.post('/logout', authMiddleware, logout);
router.delete('/account', authMiddleware, deleteAccount);
router.post('/delete-account', authMiddleware, deleteAccount);

module.exports = router;
