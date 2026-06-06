const express = require('express');
const {
  listProducts,
  listProductFeed,
  searchCatalog,
  createProduct,
  updateProduct,
  deleteProduct,
  trackProductView,
  trackProductClick,
} = require('../controllers/product.controller');
const {
  listProductCategories,
  createProductCategory,
} = require('../controllers/product-category.controller');
const { authMiddleware, optionalAuthMiddleware } = require('../middlewares/auth.middleware');
const { requireRoles } = require('../middlewares/role.middleware');

const router = express.Router();

const MERCHANT_ROLES = ['restaurateur', 'commercant', 'admin'];

// Feed public de produits/dishes agreges depuis tous les commerces actifs.
// Doit etre declare AVANT /enterprise/:enterpriseId sinon le wildcard capture.
router.get('/feed', optionalAuthMiddleware, listProductFeed);
router.get('/search', optionalAuthMiddleware, searchCatalog);

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

// Tracking engagement (public, auth optionnelle)
router.post('/enterprise/:enterpriseId/views', optionalAuthMiddleware, trackProductView);
router.post('/enterprise/:enterpriseId/:productId/view', optionalAuthMiddleware, trackProductView);
router.post('/enterprise/:enterpriseId/:productId/click', optionalAuthMiddleware, trackProductClick);

module.exports = router;
