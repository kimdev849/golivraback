const express = require('express');
const { authMiddleware } = require('../middlewares/auth.middleware');
const { requireRoles } = require('../middlewares/role.middleware');
const ctrl = require('../controllers/observability.controller');

const router = express.Router();
const adminOnly = [authMiddleware, requireRoles(['admin'])];

// Dashboard & endpoint health
router.get('/dashboard', ...adminOnly, ctrl.getObservabilityDashboard);
router.get('/endpoints', ...adminOnly, ctrl.getEndpointHealth);
router.post('/endpoints/snapshot', ...adminOnly, ctrl.postPersistHourlySnapshot);

// Incidents : groupes (fingerprint), liste, détail, transitions
router.get('/incidents/groups', ...adminOnly, ctrl.getAdminIncidentGroups);
router.get('/incidents/summary', ...adminOnly, ctrl.getAdminIncidentsSummary);
router.get('/incidents', ...adminOnly, ctrl.listAdminIncidents);
router.get('/incidents/:incidentId', ...adminOnly, ctrl.getAdminIncidentDetail);
router.patch('/incidents/:incidentId/state', ...adminOnly, ctrl.patchTransitionIncident);
router.patch('/incidents/:incidentId/acknowledge', ...adminOnly, ctrl.patchAcknowledgeIncident);
router.patch('/incidents/:incidentId/investigating', ...adminOnly, ctrl.patchInvestigatingIncident);
router.patch('/incidents/:incidentId/resolve', ...adminOnly, ctrl.patchResolveIncident);
router.patch('/incidents/:incidentId/reopen', ...adminOnly, ctrl.patchReopenIncident);
router.post('/incidents/:incidentId/notes', ...adminOnly, ctrl.postIncidentNote);
router.post('/incidents/:incidentId/reanalyze-stack', ...adminOnly, ctrl.postReanalyzeStack);

// Alerting : channels + rules + history
router.get('/alert-channels', ...adminOnly, ctrl.listAlertChannels);
router.post('/alert-channels', ...adminOnly, ctrl.createAlertChannel);
router.patch('/alert-channels/:channelId', ...adminOnly, ctrl.updateAlertChannel);
router.delete('/alert-channels/:channelId', ...adminOnly, ctrl.deleteAlertChannel);

router.get('/alert-rules', ...adminOnly, ctrl.listAlertRules);
router.post('/alert-rules', ...adminOnly, ctrl.createAlertRule);
router.patch('/alert-rules/:ruleId', ...adminOnly, ctrl.updateAlertRule);
router.delete('/alert-rules/:ruleId', ...adminOnly, ctrl.deleteAlertRule);
router.post('/alert-rules/:ruleId/test', ...adminOnly, ctrl.testAlertRule);
router.post('/alert-rules/evaluate', ...adminOnly, ctrl.evaluateAlertRulesNow);

router.get('/alert-history', ...adminOnly, ctrl.listAlertHistory);

module.exports = router;
