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
  listMyIncidents,
  getMyIncidentStats,
  getMyIncidentDetail,
  resolveMyIncident,
  cancelMyDelivery,
  addMyIncidentNote,
  escalateMyIncident,
  listMyActiveDeliveries,
} = require('../controllers/logistics.controller');
const { getCompanyActiveTracking } = require('../controllers/tracking.controller');
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
router.get('/tracking/active', ...gestionnaireBase, getCompanyActiveTracking);
router.get('/livreurs/:livreurId', ...gestionnaireBase, getMyCourier);
router.get('/livraisons', ...gestionnaireBase, listMyDeliveries);
router.post('/livreurs', ...gestionnaireActive, createMyCourier);
router.patch('/livreurs/:livreurId/disponibilite', ...gestionnaireActive, updateMyCourierAvailability);
router.patch('/livreurs/:livreurId/suspend', ...gestionnaireActive, suspendMyCourier);
router.patch('/livreurs/:livreurId/activate', ...gestionnaireActive, activateMyCourier);
router.post('/livraisons/:deliveryId/retry-dispatch', ...gestionnaireActive, retryMyDeliveryDispatch);

// ── Centre d'incidents ────────────────────────────────────────────────────
router.get('/incidents', ...gestionnaireBase, listMyIncidents);
router.get('/incidents/stats', ...gestionnaireBase, getMyIncidentStats);
router.get('/incidents/:deliveryId', ...gestionnaireBase, getMyIncidentDetail);
router.patch('/incidents/:deliveryId/resolve', ...gestionnaireActive, resolveMyIncident);
router.patch('/incidents/:deliveryId/cancel', ...gestionnaireActive, cancelMyDelivery);
router.post('/incidents/:deliveryId/note', ...gestionnaireActive, addMyIncidentNote);
router.patch('/incidents/:deliveryId/escalate', ...gestionnaireActive, escalateMyIncident);
router.get('/active-deliveries', ...gestionnaireBase, listMyActiveDeliveries);

// ── Workflow d'incident (nouveau) ──────────────────────────────────────────
const { getDb } = require('../config/db');
const incidentWorkflow = require('../services/incident-workflow.service');

router.patch('/incidents/:deliveryId/reassign', ...gestionnaireActive, async (req, res, next) => {
  try {
    const { deliveryId } = req.params;
    const { newCourierId } = req.body || {};
    if (!newCourierId) return res.status(400).json({ message: 'newCourierId requis.' });
    const db = getDb();
    const result = await incidentWorkflow.reassignDelivery(db, deliveryId, newCourierId, req.auth.userId);
    return res.json(result);
  } catch (error) { return next(error); }
});

router.patch('/incidents/:deliveryId/reassign-cross-company', ...gestionnaireActive, async (req, res, next) => {
  try {
    const { deliveryId } = req.params;
    const { newCompanyId, newCourierId } = req.body || {};
    if (!newCompanyId || !newCourierId) return res.status(400).json({ message: 'newCompanyId et newCourierId requis.' });
    const db = getDb();
    const result = await incidentWorkflow.reassignCrossCompany(db, deliveryId, newCompanyId, newCourierId, req.auth.userId);
    return res.json(result);
  } catch (error) { return next(error); }
});

router.patch('/incidents/:deliveryId/confirm-transfer', ...gestionnaireActive, async (req, res, next) => {
  try {
    const { deliveryId } = req.params;
    const db = getDb();
    // Récupérer le livreur actuellement assigné
    const { data: liv } = await db.from('livraisons').select('livreur_id').eq('id', deliveryId).maybeSingle();
    const courierId = liv?.livreur_id;
    if (!courierId) return res.status(400).json({ message: 'Aucun livreur assigné à cette livraison.' });
    const result = await incidentWorkflow.confirmTransfer(db, deliveryId, courierId, req.auth.userId);
    return res.json(result);
  } catch (error) { return next(error); }
});

router.patch('/incidents/:deliveryId/cancel-definitive', ...gestionnaireActive, async (req, res, next) => {
  try {
    const { deliveryId } = req.params;
    const { raison } = req.body || {};
    const db = getDb();
    const result = await incidentWorkflow.cancelDeliveryDefinitive(db, deliveryId, raison, req.auth.userId);
    return res.json(result);
  } catch (error) { return next(error); }
});

router.patch('/incidents/:deliveryId/resolve-simple', ...gestionnaireActive, async (req, res, next) => {
  try {
    const { deliveryId } = req.params;
    const { resolution } = req.body || {};
    const db = getDb();
    const result = await incidentWorkflow.resolveIncidentSimple(db, deliveryId, resolution, req.auth.userId);
    return res.json(result);
  } catch (error) { return next(error); }
});

module.exports = router;
