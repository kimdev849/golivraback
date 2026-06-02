const { optionalAuthMiddleware } = require('../middlewares/auth.middleware');
const { createHttpError, requireFields } = require('../utils/http');
const observability = require('../services/observability.service');
const endpointHealth = require('../services/endpoint-health.service');
const alerting = require('../services/alerting.service');
const { getDb } = require('../config/db');

// -----------------------------------------------------------------------------
// Ingestion (POST /api/observability/report) — inchangé
// -----------------------------------------------------------------------------
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

    const result = await observability.recordIncident(payload);
    return res.status(result.ok ? 201 : 503).json({
      ok: result.ok,
      id: result.id,
      fingerprint: result.fingerprint,
      requestId,
    });
  } catch (err) {
    return next(err);
  }
}

// -----------------------------------------------------------------------------
// Admin : liste / détail / groupes
// -----------------------------------------------------------------------------
async function listAdminIncidents(req, res, next) {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const resolved =
      req.query.resolved === 'true' ? true : req.query.resolved === 'false' ? false : undefined;

    const data = await observability.listIncidentsForAdmin({
      limit,
      offset,
      resolved,
      state: req.query.state || undefined,
      source: req.query.source || undefined,
      severity: req.query.severity || undefined,
      errorType: req.query.error_type || undefined,
      requestId: req.query.requestId || undefined,
      q: req.query.q || undefined,
      fingerprint: req.query.fingerprint || undefined,
    });

    return res.json(data);
  } catch (err) {
    return next(err);
  }
}

async function getAdminIncidentDetail(req, res, next) {
  try {
    const incident = await observability.getIncidentById(req.params.incidentId);
    if (!incident) throw createHttpError(404, 'Incident introuvable.');

    const [events, related] = await Promise.all([
      observability.getIncidentEvents(req.params.incidentId),
      observability.getRelatedIncidents(incident.request_id, incident.id),
    ]);

    return res.json({ incident, events, related });
  } catch (err) {
    return next(err);
  }
}

async function getAdminIncidentsSummary(req, res, next) {
  try {
    const open_count = await observability.countOpenIncidents();
    return res.json({ open_count });
  } catch (err) {
    return next(err);
  }
}

async function getAdminIncidentGroups(req, res, next) {
  try {
    const windowMin = Math.min(Math.max(Number(req.query.window_min) || 60, 5), 1440);
    const groups = await observability.listIncidentGroups({
      windowMin,
      source: req.query.source || undefined,
      severity: req.query.severity || undefined,
      state: req.query.state || undefined,
    });
    return res.json({ window_min: windowMin, groups });
  } catch (err) {
    return next(err);
  }
}

// -----------------------------------------------------------------------------
// Admin : transitions d'état + notes
// -----------------------------------------------------------------------------
async function patchTransitionIncident(req, res, next) {
  try {
    const { state, admin_note: adminNote } = req.body || {};
    if (!state) throw createHttpError(400, 'state requis');
    const updated = await observability.transitionIncidentState(
      req.params.incidentId,
      state,
      req.auth.userId,
      adminNote,
    );
    return res.json(updated);
  } catch (err) {
    return next(err);
  }
}

async function patchResolveIncident(req, res, next) {
  try {
    const { admin_note: adminNote } = req.body || {};
    const incident = await observability.resolveIncident(req.params.incidentId, req.auth.userId, adminNote);
    return res.json(incident);
  } catch (err) {
    return next(err);
  }
}

async function patchAcknowledgeIncident(req, res, next) {
  try {
    const incident = await observability.acknowledgeIncident(req.params.incidentId, req.auth.userId);
    return res.json(incident);
  } catch (err) {
    return next(err);
  }
}

async function patchInvestigatingIncident(req, res, next) {
  try {
    const incident = await observability.investigatingIncident(req.params.incidentId, req.auth.userId);
    return res.json(incident);
  } catch (err) {
    return next(err);
  }
}

async function patchReopenIncident(req, res, next) {
  try {
    const incident = await observability.reopenIncident(req.params.incidentId);
    return res.json(incident);
  } catch (err) {
    return next(err);
  }
}

async function postIncidentNote(req, res, next) {
  try {
    const { message } = req.body || {};
    if (!message) throw createHttpError(400, 'message requis');
    const event = await observability.addIncidentNote(req.params.incidentId, req.auth.userId, message);
    return res.status(201).json(event);
  } catch (err) {
    return next(err);
  }
}

// -----------------------------------------------------------------------------
// Admin : ré-analyse d'une stack existante (utile pour rafraîchir frames /
// github_url après un changement de config BACKEND_GITHUB_REPO_URL ou après
// import historique d'incidents sans frames).
// -----------------------------------------------------------------------------
async function postReanalyzeStack(req, res, next) {
  try {
    const incident = await observability.getIncidentById(req.params.incidentId);
    if (!incident) throw createHttpError(404, 'Incident introuvable.');

    if (!incident.stack) {
      return res.json({ ok: true, message: 'Aucune stack à analyser.' });
    }
    const sourceMapper = require('../utils/source-mapper');
    const analysis = sourceMapper.analyzeStack(incident.stack);
    const db = getDb();
    const { data, error } = await db
      .from('app_incidents')
      .update({
        frames: analysis.frames,
        source_location: analysis.top_frame,
        code_context: analysis.code_context,
        github_url: analysis.github_url,
      })
      .eq('id', incident.id)
      .select('*')
      .single();
    if (error) throw error;
    return res.json(data);
  } catch (err) {
    return next(err);
  }
}

// -----------------------------------------------------------------------------
// Admin : dashboard, endpoint health
// -----------------------------------------------------------------------------
async function getObservabilityDashboard(req, res, next) {
  try {
    const windowMin = Math.min(Math.max(Number(req.query.window_min) || 60, 5), 1440);
    const overview = await endpointHealth.getDashboardOverview({ windowMin });
    return res.json(overview);
  } catch (err) {
    return next(err);
  }
}

async function getEndpointHealth(req, res, next) {
  try {
    const windowMin = Math.min(Math.max(Number(req.query.window_min) || 60, 5), 1440);
    const minRequests = Math.max(Number(req.query.min_requests) || 1, 1);
    const endpoints = await endpointHealth.getEndpointHealth({ windowMin, minRequests });
    return res.json({ window_min: windowMin, endpoints });
  } catch (err) {
    return next(err);
  }
}

async function postPersistHourlySnapshot(req, res, next) {
  try {
    const result = await endpointHealth.persistHourlySnapshot();
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

// -----------------------------------------------------------------------------
// Admin : alertes
// -----------------------------------------------------------------------------
async function listAlertChannels(req, res, next) {
  try {
    const db = getDb();
    const { data, error } = await db.from('alert_channels').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return res.json({ items: data || [] });
  } catch (err) {
    return next(err);
  }
}

async function createAlertChannel(req, res, next) {
  try {
    requireFields(req.body, ['nom', 'type', 'config']);
    const db = getDb();
    const { data, error } = await db
      .from('alert_channels')
      .insert({
        nom: String(req.body.nom).slice(0, 200),
        type: String(req.body.type),
        config: req.body.config || {},
        est_actif: req.body.est_actif !== false,
        created_by: req.auth.userId,
      })
      .select('*')
      .single();
    if (error) throw error;
    return res.status(201).json(data);
  } catch (err) {
    return next(err);
  }
}

async function updateAlertChannel(req, res, next) {
  try {
    const patch = {};
    if (req.body.nom !== undefined) patch.nom = String(req.body.nom).slice(0, 200);
    if (req.body.config !== undefined) patch.config = req.body.config;
    if (req.body.est_actif !== undefined) patch.est_actif = !!req.body.est_actif;
    patch.updated_at = new Date().toISOString();
    const db = getDb();
    const { data, error } = await db
      .from('alert_channels')
      .update(patch)
      .eq('id', req.params.channelId)
      .select('*')
      .single();
    if (error) throw error;
    return res.json(data);
  } catch (err) {
    return next(err);
  }
}

async function deleteAlertChannel(req, res, next) {
  try {
    const db = getDb();
    const { error } = await db.from('alert_channels').delete().eq('id', req.params.channelId);
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}

async function listAlertRules(req, res, next) {
  try {
    const db = getDb();
    const { data, error } = await db.from('alert_rules').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return res.json({ items: data || [] });
  } catch (err) {
    return next(err);
  }
}

async function createAlertRule(req, res, next) {
  try {
    requireFields(req.body, ['nom', 'condition']);
    const db = getDb();
    const { data, error } = await db
      .from('alert_rules')
      .insert({
        nom: String(req.body.nom).slice(0, 200),
        description: req.body.description ? String(req.body.description).slice(0, 1000) : null,
        condition: req.body.condition,
        channel_ids: Array.isArray(req.body.channel_ids) ? req.body.channel_ids : [],
        cooldown_min: Math.max(Number(req.body.cooldown_min) || 15, 1),
        est_actif: req.body.est_actif !== false,
      })
      .select('*')
      .single();
    if (error) throw error;
    return res.status(201).json(data);
  } catch (err) {
    return next(err);
  }
}

async function updateAlertRule(req, res, next) {
  try {
    const patch = {};
    if (req.body.nom !== undefined) patch.nom = String(req.body.nom).slice(0, 200);
    if (req.body.description !== undefined) patch.description = String(req.body.description).slice(0, 1000);
    if (req.body.condition !== undefined) patch.condition = req.body.condition;
    if (req.body.channel_ids !== undefined) patch.channel_ids = req.body.channel_ids;
    if (req.body.cooldown_min !== undefined) patch.cooldown_min = Math.max(Number(req.body.cooldown_min) || 15, 1);
    if (req.body.est_actif !== undefined) patch.est_actif = !!req.body.est_actif;
    patch.updated_at = new Date().toISOString();
    const db = getDb();
    const { data, error } = await db
      .from('alert_rules')
      .update(patch)
      .eq('id', req.params.ruleId)
      .select('*')
      .single();
    if (error) throw error;
    return res.json(data);
  } catch (err) {
    return next(err);
  }
}

async function deleteAlertRule(req, res, next) {
  try {
    const db = getDb();
    const { error } = await db.from('alert_rules').delete().eq('id', req.params.ruleId);
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}

async function testAlertRule(req, res, next) {
  try {
    const db = getDb();
    const { data: rule, error } = await db
      .from('alert_rules')
      .select('*')
      .eq('id', req.params.ruleId)
      .maybeSingle();
    if (error) throw error;
    if (!rule) throw createHttpError(404, 'Règle introuvable.');

    const fakePayload = {
      title: `[TEST] ${rule.nom}`,
      message: 'Alerte de test déclenchée manuellement depuis l’admin.',
      severity: 'warn',
      metadata: { test: true, rule_id: rule.id },
    };
    await alerting.dispatchAlert(rule, fakePayload);
    return res.json({ ok: true, sent: true });
  } catch (err) {
    return next(err);
  }
}

async function evaluateAlertRulesNow(req, res, next) {
  try {
    const result = await alerting.evaluateRules();
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function listAlertHistory(req, res, next) {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const db = getDb();
    let q = db.from('alert_history').select('*').order('created_at', { ascending: false }).limit(limit);
    if (req.query.rule_id) q = q.eq('rule_id', req.query.rule_id);
    const { data, error } = await q;
    if (error) throw error;
    return res.json({ items: data || [] });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  reportIncident,
  listAdminIncidents,
  getAdminIncidentDetail,
  getAdminIncidentsSummary,
  getAdminIncidentGroups,
  patchTransitionIncident,
  patchResolveIncident,
  patchAcknowledgeIncident,
  patchInvestigatingIncident,
  patchReopenIncident,
  postIncidentNote,
  postReanalyzeStack,
  getObservabilityDashboard,
  getEndpointHealth,
  postPersistHourlySnapshot,
  listAlertChannels,
  createAlertChannel,
  updateAlertChannel,
  deleteAlertChannel,
  listAlertRules,
  createAlertRule,
  updateAlertRule,
  deleteAlertRule,
  testAlertRule,
  evaluateAlertRulesNow,
  listAlertHistory,
  optionalAuthMiddleware,
};
