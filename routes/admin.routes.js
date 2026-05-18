const express = require('express');
const {
  createCourier,
  getAdminStats,
  listAllEnterprises,
  listEnterprisesPending,
  getEnterpriseAdmin,
  activateEnterprise,
  rejectEnterprise,
  suspendEnterprise,
  listPendingUsers,
  approveUser,
  rejectUser,
  listAdminOrders,
  getAdminOrderDetail,
  listLogisticsCompanies,
  getLogisticsCompanyAdmin,
  createLogisticsCompany,
  createLogisticsCourier,
  suspendLogisticsCourier,
  activateLogisticsCourier,
  updateLogisticsStatus,
  listAdminDeliveries,
  listAdminCouriers,
  assignDeliveryCourier,
  getAdminCommissions,
} = require('../controllers/admin.controller');
const { authMiddleware } = require('../middlewares/auth.middleware');
const { requireRoles } = require('../middlewares/role.middleware');

const router = express.Router();
const adminOnly = [authMiddleware, requireRoles(['admin'])];

router.get('/stats', ...adminOnly, getAdminStats);

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
router.post('/logistics/:companyId/livreurs', ...adminOnly, createLogisticsCourier);
router.patch('/logistics/:companyId/livreurs/:livreurId/suspend', ...adminOnly, suspendLogisticsCourier);
router.patch('/logistics/:companyId/livreurs/:livreurId/activate', ...adminOnly, activateLogisticsCourier);

router.get('/deliveries', ...adminOnly, listAdminDeliveries);
router.patch('/deliveries/:deliveryId/assign', ...adminOnly, assignDeliveryCourier);

router.get('/commissions', ...adminOnly, getAdminCommissions);

module.exports = router;
