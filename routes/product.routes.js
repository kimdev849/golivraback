const express = require('express');
const {
  listProducts,
  createProduct,
  updateProduct,
  deleteProduct,
} = require('../controllers/product.controller');
const {
  listProductCategories,
  createProductCategory,
} = require('../controllers/product-category.controller');
const { authMiddleware, optionalAuthMiddleware } = require('../middlewares/auth.middleware');
const { requireRoles } = require('../middlewares/role.middleware');

const router = express.Router();

const MERCHANT_ROLES = ['restaurateur', 'commercant', 'admin'];

router.get('/enterprise/:enterpriseId/categories', optionalAuthMiddleware, listProductCategories);
router.post(
  '/enterprise/:enterpriseId/categories',
  authMiddleware,
  requireRoles(MERCHANT_ROLES),
  createProductCategory,
);
router.get('/enterprise/:enterpriseId', optionalAuthMiddleware, listProducts);
router.post('/enterprise/:enterpriseId', authMiddleware, requireRoles(MERCHANT_ROLES), createProduct);
router.patch(
  '/enterprise/:enterpriseId/:productId',
  authMiddleware,
  requireRoles(MERCHANT_ROLES),
  updateProduct,
);
router.delete(
  '/enterprise/:enterpriseId/:productId',
  authMiddleware,
  requireRoles(MERCHANT_ROLES),
  deleteProduct,
);

module.exports = router;
