const express = require('express');
const { authMiddleware } = require('../middlewares/auth.middleware');
const { requireRoles } = require('../middlewares/role.middleware');
const {
  getDeliveryStatus,
  getCourierProfile,
  listCourierMissions,
  updateCourierAvailability,
  updateCourierPosition,
  acceptDelivery,
  completeDelivery,
} = require('../controllers/delivery.controller');
const {
  createVendorExternalDelivery,
  listVendorExternalDeliveriesHandler,
} = require('../controllers/vendor-delivery.controller');

const router = express.Router();

router.get('/status/:orderId', authMiddleware, getDeliveryStatus);
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
router.get('/courier/me', authMiddleware, requireRoles(['livreur', 'admin']), getCourierProfile);
router.get('/courier/missions', authMiddleware, requireRoles(['livreur', 'admin']), listCourierMissions);
router.patch('/courier/availability', authMiddleware, requireRoles(['livreur', 'admin']), updateCourierAvailability);
router.post('/courier/position', authMiddleware, requireRoles(['livreur', 'admin']), updateCourierPosition);
router.post('/courier/accept/:deliveryId', authMiddleware, requireRoles(['livreur', 'admin']), acceptDelivery);
router.post('/courier/complete/:deliveryId', authMiddleware, requireRoles(['livreur', 'admin']), completeDelivery);

module.exports = router;
