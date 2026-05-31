const express = require('express');
const rateLimit = require('express-rate-limit');
const { optionalAuthMiddleware } = require('../middlewares/auth.middleware');
const { reportIncident } = require('../controllers/observability.controller');

const router = express.Router();

const reportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.OBSERVABILITY_REPORT_MAX) || 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Trop de rapports envoyés.', code: 'RATE_LIMIT' },
});

router.post('/report', reportLimiter, optionalAuthMiddleware, reportIncident);

module.exports = router;
