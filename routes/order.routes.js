const express = require('express');
const {
  createOrder,
  getOrders,
  getVendorOrders,
  getVendorOrderDetails,
  getOrderDetails,
  updateOrderStatus,
} = require('../controllers/order.controller');
const { payOrder, getPaymentMode, getPricingConfigHandler } = require('../controllers/payment.controller');
const { authMiddleware } = require('../middlewares/auth.middleware');
const { requireRoles } = require('../middlewares/role.middleware');

const router = express.Router();

router.get('/pricing-config', getPricingConfigHandler);
router.get('/payment-mode', authMiddleware, getPaymentMode);
router.get('/', authMiddleware, getOrders);
router.get('/vendor/mine', authMiddleware, requireRoles(['restaurateur', 'commercant', 'admin']), getVendorOrders);
router.get('/vendor/:orderId', authMiddleware, requireRoles(['restaurateur', 'commercant', 'admin']), getVendorOrderDetails);
router.get('/:orderId', authMiddleware, getOrderDetails);
router.post('/', authMiddleware, requireRoles(['client', 'admin']), createOrder);
router.post('/:orderId/pay', authMiddleware, requireRoles(['client', 'admin']), payOrder);
router.patch('/:orderId/status', authMiddleware, requireRoles(['restaurateur', 'commercant', 'admin']), updateOrderStatus);

module.exports = router;
