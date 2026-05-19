const express = require('express');
const {
  register,
  login,
  staffLogin,
  me,
  logout,
  updateProfile,
  changePassword,
  resetPassword,
  getMyPreferences,
  patchMyPreferences,
} = require('../controllers/auth.controller');
const { authMiddleware } = require('../middlewares/auth.middleware');

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.post('/staff/login', staffLogin);
router.post('/reset-password', resetPassword);
router.get('/me', authMiddleware, me);
router.patch('/me', authMiddleware, updateProfile);
router.get('/preferences', authMiddleware, getMyPreferences);
router.patch('/preferences', authMiddleware, patchMyPreferences);
router.post('/change-password', authMiddleware, changePassword);
router.post('/logout', authMiddleware, logout);

module.exports = router;
