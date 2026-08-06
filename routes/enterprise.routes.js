const express = require('express');
const {
  listEnterprises,
  listCategories,
  getEnterpriseById,
  createEnterprise,
  getMyEnterprises,
  patchEnterprise,
  patchEnterpriseSettings,
  getEnterpriseHoraires,
  putEnterpriseHoraires,
  getMyEnterpriseStats,
} = require('../controllers/enterprise.controller');
const { authMiddleware, optionalAuthMiddleware } = require('../middlewares/auth.middleware');
const { requireRoles } = require('../middlewares/role.middleware');

const router = express.Router();

router.get('/', listEnterprises);
router.get('/categories/:type', listCategories);
router.get('/mine', authMiddleware, requireRoles(['restaurateur', 'commercant', 'admin']), getMyEnterprises);
router.get(
  '/:enterpriseId/stats',
  authMiddleware,
  requireRoles(['restaurateur', 'commercant', 'admin']),
  getMyEnterpriseStats,
);
router.patch(
  '/:enterpriseId',
  authMiddleware,
  requireRoles(['restaurateur', 'commercant', 'admin']),
  patchEnterprise,
);
router.patch(
  '/:enterpriseId/settings',
  authMiddleware,
  requireRoles(['restaurateur', 'commercant', 'admin']),
  patchEnterpriseSettings,
);
router.get(
  '/:enterpriseId/horaires',
  authMiddleware,
  requireRoles(['restaurateur', 'commercant', 'admin']),
  getEnterpriseHoraires,
);
router.put(
  '/:enterpriseId/horaires',
  authMiddleware,
  requireRoles(['restaurateur', 'commercant', 'admin']),
  putEnterpriseHoraires,
);
router.get('/:enterpriseId', optionalAuthMiddleware, getEnterpriseById);
router.post('/', authMiddleware, requireRoles(['restaurateur', 'commercant', 'admin']), createEnterprise);

module.exports = router;
