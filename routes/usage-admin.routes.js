const express = require('express');
const { authMiddleware } = require('../middlewares/auth.middleware');
const { requireRoles } = require('../middlewares/role.middleware');
const { getUsageDashboardHandler } = require('../controllers/usage-stats.controller');

const router = express.Router();
const adminOnly = [authMiddleware, requireRoles(['admin'])];

// Tableau de bord usage : utilisateurs mobile, activité, fréquence, top zones
// de livraison. Distinct de l'observabilité technique (qui reste sous
// /api/admin/observability).
router.get('/dashboard', ...adminOnly, getUsageDashboardHandler);

module.exports = router;
