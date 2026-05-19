const express = require('express');
const {
  listEnterprises,
  listCategories,
  getEnterpriseById,
  createEnterprise,
  getMyEnterprises,
  patchEnterprise,
  patchEnterpriseSettings,
} = require('../controllers/enterprise.controller');
const { authMiddleware, optionalAuthMiddleware } = require('../middlewares/auth.middleware');
const { requireRoles } = require('../middlewares/role.middleware');

const router = express.Router();

router.get('/', listEnterprises);
router.get('/categories/:type', listCategories);
router.get('/mine', authMiddleware, requireRoles(['restaurateur', 'commercant', 'admin']), getMyEnterprises);
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
router.get('/:enterpriseId', optionalAuthMiddleware, getEnterpriseById);
router.post('/', authMiddleware, requireRoles(['restaurateur', 'commercant', 'admin']), createEnterprise);

module.exports = router;
