const { optionalAuthMiddleware } = require('../middlewares/auth.middleware');
const { createHttpError, requireFields } = require('../utils/http');
const {
  recordIncident,
  listIncidentsForAdmin,
  getIncidentById,
  getRelatedIncidents,
  countOpenIncidents,
  resolveIncident,
} = require('../services/observability.service');

async function reportIncident(req, res, next) {
  try {
    requireFields(req.body, ['title', 'message']);
    const requestId = req.requestId || req.body.request_id || req.body.requestId;
    if (!requestId) throw createHttpError(400, 'requestId manquant');

    const payload = {
      ...req.body,
      request_id: requestId,
      user_id: req.auth?.userId || req.body.user_id || null,
      user_role: req.auth?.role || req.body.user_role || null,
    };

    const source = String(payload.source || '');
    if (!['mobile', 'admin', 'api'].includes(source)) {
      payload.source = req.headers['x-client-source'] === 'admin' ? 'admin' : 'mobile';
    }

    const result = await recordIncident(payload);
    return res.status(result.ok ? 201 : 503).json({
      ok: result.ok,
      id: result.id,
      requestId,
    });
  } catch (err) {
    return next(err);
  }
}

async function listAdminIncidents(req, res, next) {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const resolved =
      req.query.resolved === 'true' ? true : req.query.resolved === 'false' ? false : undefined;

    const data = await listIncidentsForAdmin({
      limit,
      offset,
      resolved,
      source: req.query.source || undefined,
      severity: req.query.severity || undefined,
      requestId: req.query.requestId || undefined,
      q: req.query.q || undefined,
    });

    return res.json(data);
  } catch (err) {
    return next(err);
  }
}

async function getAdminIncidentDetail(req, res, next) {
  try {
    const incident = await getIncidentById(req.params.incidentId);
    if (!incident) throw createHttpError(404, 'Incident introuvable.');

    const related = await getRelatedIncidents(incident.request_id, incident.id);
    return res.json({ incident, related });
  } catch (err) {
    return next(err);
  }
}

async function getAdminIncidentsSummary(req, res, next) {
  try {
    const open_count = await countOpenIncidents();
    return res.json({ open_count });
  } catch (err) {
    return next(err);
  }
}

async function patchResolveIncident(req, res, next) {
  try {
    const { admin_note: adminNote } = req.body || {};
    const incident = await resolveIncident(req.params.incidentId, req.auth.userId, adminNote);
    return res.json(incident);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  reportIncident,
  listAdminIncidents,
  getAdminIncidentDetail,
  getAdminIncidentsSummary,
  patchResolveIncident,
  optionalAuthMiddleware,
};
