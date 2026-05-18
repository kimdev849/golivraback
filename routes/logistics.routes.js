const express = require('express');
const {
  getMyCompany,
  listMyCouriers,
  createMyCourier,
  suspendMyCourier,
  activateMyCourier,
} = require('../controllers/logistics.controller');
const { authMiddleware } = require('../middlewares/auth.middleware');
const { requireRoles } = require('../middlewares/role.middleware');
const {
  loadGestionnaireCompany,
  requireActiveLogisticsCompany,
} = require('../middlewares/logistics.middleware');

const router = express.Router();

const gestionnaireChain = [
  authMiddleware,
  requireRoles(['gestionnaire_logistique']),
  loadGestionnaireCompany,
  requireActiveLogisticsCompany,
];

router.get('/company', authMiddleware, requireRoles(['gestionnaire_logistique', 'admin']), getMyCompany);

router.get('/livreurs', ...gestionnaireChain, listMyCouriers);
router.post('/livreurs', ...gestionnaireChain, createMyCourier);
router.patch('/livreurs/:livreurId/suspend', ...gestionnaireChain, suspendMyCourier);
router.patch('/livreurs/:livreurId/activate', ...gestionnaireChain, activateMyCourier);

module.exports = router;
