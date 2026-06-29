const express = require('express');
const locationAdmin = require('../controllers/admin-location.controller');

const {
  getAdminStats,
  getAdminCharts,
  listAllEnterprises,
  listEnterprisesPending,
  getEnterpriseAdmin,
  activateEnterprise,
  rejectEnterprise,
  suspendEnterprise,
  listPendingUsers,
  approveUser,
  rejectUser,
  createCourier,
  listAdminCouriers,
  listAdminOrders,
  getAdminOrderDetail,
  listLogisticsCompanies,
  getLogisticsCompanyAdmin,
  createLogisticsCompany,
  updateLogisticsStatus,
  updateLogisticsCommission,
  listAdminDeliveries,
  getAdminDeliveryDetail,
  getAdminCommissions,
  getAdminPlatformWallet,
  listAdminWithdrawals,
  processAdminWithdrawal,
} = require('../controllers/admin.controller');
const { authMiddleware } = require('../middlewares/auth.middleware');
const { requireRoles } = require('../middlewares/role.middleware');
const {
  listAdminIncidents,
  getAdminIncidentDetail,
  getAdminIncidentsSummary,
  patchResolveIncident,
} = require('../controllers/observability.controller');

const router = express.Router();
const adminOnly = [authMiddleware, requireRoles(['admin'])];

router.get('/stats', ...adminOnly, getAdminStats);
router.get('/stats/charts', ...adminOnly, getAdminCharts);

router.get('/enterprises', ...adminOnly, listAllEnterprises);
router.get('/enterprises/pending', ...adminOnly, listEnterprisesPending);
router.get('/enterprises/:enterpriseId', ...adminOnly, getEnterpriseAdmin);
router.patch('/enterprises/:enterpriseId/activate', ...adminOnly, activateEnterprise);
router.patch('/enterprises/:enterpriseId/reject', ...adminOnly, rejectEnterprise);
router.patch('/enterprises/:enterpriseId/suspend', ...adminOnly, suspendEnterprise);

router.get('/users/pending', ...adminOnly, listPendingUsers);
router.patch('/users/:userId/approve', ...adminOnly, approveUser);
router.patch('/users/:userId/reject', ...adminOnly, rejectUser);

router.post('/couriers', ...adminOnly, createCourier);
router.get('/couriers', ...adminOnly, listAdminCouriers);

router.get('/orders', ...adminOnly, listAdminOrders);
router.get('/orders/:orderId', ...adminOnly, getAdminOrderDetail);

router.get('/logistics', ...adminOnly, listLogisticsCompanies);
router.post('/logistics', ...adminOnly, createLogisticsCompany);
router.get('/logistics/:companyId', ...adminOnly, getLogisticsCompanyAdmin);
router.patch('/logistics/:companyId/status', ...adminOnly, updateLogisticsStatus);
router.patch('/logistics/:companyId/commission', ...adminOnly, updateLogisticsCommission);

router.get('/deliveries', ...adminOnly, listAdminDeliveries);
router.get('/deliveries/:deliveryId', ...adminOnly, getAdminDeliveryDetail);

router.get('/commissions', ...adminOnly, getAdminCommissions);
router.get('/portefeuille', ...adminOnly, getAdminPlatformWallet);
router.get('/retraits', ...adminOnly, listAdminWithdrawals);
router.patch('/retraits/:retraitId', ...adminOnly, processAdminWithdrawal);

router.get('/incidents/summary', ...adminOnly, getAdminIncidentsSummary);
router.get('/incidents', ...adminOnly, listAdminIncidents);
router.get('/incidents/:incidentId', ...adminOnly, getAdminIncidentDetail);
router.patch('/incidents/:incidentId/resolve', ...adminOnly, patchResolveIncident);

// ── Gestion des pays / villes / arrondissements ────────────────────────────
router.get('/locations/pays', ...adminOnly, locationAdmin.getPaysList);
router.post('/locations/pays', ...adminOnly, locationAdmin.postPays);
router.patch('/locations/pays/:paysId', ...adminOnly, locationAdmin.patchPays);
router.delete('/locations/pays/:paysId', ...adminOnly, locationAdmin.removePays);

router.get('/locations/villes', ...adminOnly, locationAdmin.getVillesList);
router.post('/locations/villes', ...adminOnly, locationAdmin.postVille);
router.patch('/locations/villes/:villeId', ...adminOnly, locationAdmin.patchVille);
router.delete('/locations/villes/:villeId', ...adminOnly, locationAdmin.removeVille);

router.get('/locations/arrondissements', ...adminOnly, locationAdmin.getArrondissementsList);
router.post('/locations/arrondissements', ...adminOnly, locationAdmin.postArrondissement);
router.patch('/locations/arrondissements/:arrId', ...adminOnly, locationAdmin.patchArrondissement);
router.delete('/locations/arrondissements/:arrId', ...adminOnly, locationAdmin.removeArrondissement);

module.exports = router;
