const express = require('express');
const { authMiddleware } = require('../middlewares/auth.middleware');
const { requireRoles } = require('../middlewares/role.middleware');
const {
  getDeliveryStatus,
  getDeliveryDetails,
  getCourierProfile,
  listCourierMissions,
  updateCourierAvailability,
  updateCourierPosition,
  acceptDelivery,
  advanceDelivery,
  completeDelivery,
} = require('../controllers/delivery.controller');
const {
  createVendorExternalDelivery,
  listVendorExternalDeliveriesHandler,
  getExternalDeliveryPaymentStatusHandler,
} = require('../controllers/vendor-delivery.controller');

const router = express.Router();

router.get('/status/:orderId', authMiddleware, getDeliveryStatus);
router.get('/:deliveryId/details', authMiddleware, getDeliveryDetails);
router.get(
  '/vendor/externe',
  authMiddleware,
  requireRoles(['restaurateur', 'commercant', 'admin']),
  listVendorExternalDeliveriesHandler,
);
router.post(
  '/vendor/externe',
  authMiddleware,
  requireRoles(['restaurateur', 'commercant', 'admin']),
  createVendorExternalDelivery,
);
router.get(
  '/vendor/externe/:deliveryId/payment-status',
  authMiddleware,
  requireRoles(['restaurateur', 'commercant', 'admin']),
  getExternalDeliveryPaymentStatusHandler,
);
router.get('/courier/me', authMiddleware, requireRoles(['livreur', 'admin']), getCourierProfile);
router.get('/courier/missions', authMiddleware, requireRoles(['livreur', 'admin']), listCourierMissions);
router.patch('/courier/availability', authMiddleware, requireRoles(['livreur', 'admin']), updateCourierAvailability);
router.post('/courier/position', authMiddleware, requireRoles(['livreur', 'admin']), updateCourierPosition);
router.post('/courier/accept/:deliveryId', authMiddleware, requireRoles(['livreur', 'admin']), acceptDelivery);
router.post('/courier/advance/:deliveryId', authMiddleware, requireRoles(['livreur', 'admin']), advanceDelivery);
router.post('/courier/complete/:deliveryId', authMiddleware, requireRoles(['livreur', 'admin']), completeDelivery);

module.exports = router;
