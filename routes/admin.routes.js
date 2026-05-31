const express = require('express');
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

module.exports = router;
