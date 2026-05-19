const express = require('express');
const {
  getMyCompany,
  getMyWallet,
  getMyStats,
  getMyOperations,
  getMyDelays,
  listMyCouriers,
  getMyCourier,
  updateMyCourierAvailability,
  createMyCourier,
  suspendMyCourier,
  activateMyCourier,
  listMyDeliveries,
  retryMyDeliveryDispatch,
} = require('../controllers/logistics.controller');
const { authMiddleware } = require('../middlewares/auth.middleware');
const { requireRoles } = require('../middlewares/role.middleware');
const {
  loadGestionnaireCompany,
  requireActiveLogisticsCompany,
} = require('../middlewares/logistics.middleware');

const router = express.Router();

const gestionnaireBase = [
  authMiddleware,
  requireRoles(['gestionnaire_logistique']),
  loadGestionnaireCompany,
];

const gestionnaireActive = [...gestionnaireBase, requireActiveLogisticsCompany];

router.get('/company', authMiddleware, requireRoles(['gestionnaire_logistique', 'admin']), getMyCompany);

router.get('/wallet', ...gestionnaireBase, getMyWallet);
router.get('/stats', ...gestionnaireBase, getMyStats);
router.get('/operations', ...gestionnaireBase, getMyOperations);
router.get('/retards', ...gestionnaireBase, getMyDelays);

router.get('/livreurs', ...gestionnaireBase, listMyCouriers);
router.get('/livreurs/:livreurId', ...gestionnaireBase, getMyCourier);
router.get('/livraisons', ...gestionnaireBase, listMyDeliveries);
router.post('/livreurs', ...gestionnaireActive, createMyCourier);
router.patch('/livreurs/:livreurId/disponibilite', ...gestionnaireActive, updateMyCourierAvailability);
router.patch('/livreurs/:livreurId/suspend', ...gestionnaireActive, suspendMyCourier);
router.patch('/livreurs/:livreurId/activate', ...gestionnaireActive, activateMyCourier);
router.post('/livraisons/:deliveryId/retry-dispatch', ...gestionnaireActive, retryMyDeliveryDispatch);

module.exports = router;
