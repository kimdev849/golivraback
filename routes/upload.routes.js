const express = require('express');
const rateLimit = require('express-rate-limit');
const { uploadBase64Image } = require('../controllers/upload.controller');
const { authMiddleware } = require('../middlewares/auth.middleware');
const { requireRoles } = require('../middlewares/role.middleware');

const router = express.Router();

const UPLOAD_ROLES = ['client', 'restaurateur', 'commercant', 'livreur', 'gestionnaire_logistique', 'admin'];

// ── Anti-abus upload PUBLIC (inscription : pas encore de token) ─────────────
// Endpoint non authentifié → risque de spam / coûts storage. Limite dédiée :
// 20 uploads / 15 min / IP (configurable via RATE_LIMIT_UPLOAD_PUBLIC_MAX).
// Désactivé en développement pour ne pas gêner.
const isDev = process.env.NODE_ENV !== 'production';
const uploadPublicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 0 : (Number(process.env.RATE_LIMIT_UPLOAD_PUBLIC_MAX) || 20),
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isDev,
  message: { message: 'Trop de demandes d’envoi d’image, réessayez plus tard.', code: 'RATE_LIMIT_UPLOAD_PUBLIC' },
});

router.post('/image', authMiddleware, requireRoles(UPLOAD_ROLES), uploadBase64Image);
router.post('/public-image', uploadPublicLimiter, uploadBase64Image);

module.exports = router;
