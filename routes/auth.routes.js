const express = require('express');
const { register, login, me, logout, updateProfile, changePassword } = require('../controllers/auth.controller');
const { authMiddleware } = require('../middlewares/auth.middleware');

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.get('/me', authMiddleware, me);
router.patch('/me', authMiddleware, updateProfile);
router.post('/change-password', authMiddleware, changePassword);
router.post('/logout', authMiddleware, logout);

module.exports = router;
