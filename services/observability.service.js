const { createHash } = require('crypto');
const { getDb } = require('../config/db');
const { error: logError, warn: logWarn, info: logInfo } = require('../utils/logger');
const sourceMapper = require('../utils/source-mapper');

const SEVERITIES = new Set(['error', 'warn', 'info']);
const SOURCES = new Set(['mobile', 'admin', 'backend', 'api']);
const STATES = new Set(['ouvert', 'acquitte', 'en_cours', 'resolu']);
const ERROR_TYPES = new Set([
  'DatabaseError',
  'AuthError',
  'ValidationError',
  'ExternalServiceError',
  'NetworkError',
  'PaymentError',
  'RuntimeError',
  'UnknownError',
]);

const SLOW_REQUEST_MS = Number(process.env.OBSERVABILITY_SLOW_MS) || 2000;

// -----------------------------------------------------------------------------
// Fingerprinting : hash(endpoint + method + errorType + rootCause)
// Permet de regrouper N occurrences d'un même incident en 1 seule entrée.
// -----------------------------------------------------------------------------
function fingerprintPayload(input = {}) {
  const parts = [
    input.http_method || '',
    normalizePath(input.http_path || input.httpPath || ''),
    input.error_type || 'UnknownError',
    rootCauseKey(input),
  ];
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

function normalizePath(path) {
  if (!path) return '';
  return String(path)
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:uuid')
    .replace(/\/\d+/g, '/:id')
    .replace(/\?.*$/, '');
}

function rootCauseKey(input) {
  const code = input.code || input.metadata?.code;
  if (code) return `code:${code}`;
  const msg = String(input.message || input.title || '').slice(0, 200);
  return `msg:${normalizeForKey(msg)}`;
}

function normalizeForKey(s) {
  return String(s)
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/gi, '<hex>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/[^a-z0-9_\s<>:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// -----------------------------------------------------------------------------
// Classification enrichie : DatabaseError, AuthError, ValidationError,
// ExternalServiceError, NetworkError, PaymentError, RuntimeError.
// -----------------------------------------------------------------------------
function classifyError(input = {}) {
  const code = input.code || input.metadata?.code;
  const msg = String(input.message || '').toLowerCase();
  const stack = String(input.stack || '').toLowerCase();
  const category = String(input.category || '').toLowerCase();
  const path = String(input.http_path || input.httpPath || '').toLowerCase();
  const source = String(input.source || '').toLowerCase();
  const hay = `${msg} ${stack}`;

  if (
    /relation .* does not exist|column .* does not exist|null value in column|duplicate key|foreign key|pg_|postgres|supabase/i.test(
      hay,
    ) ||
    code === 'PGRST' ||
    code === '23505' ||
    code === '23503' ||
    code === '23502'
  ) {
    return 'DatabaseError';
  }

  if (code === 'NON_AUTORISE' || code === 'INTERDIT' || /unauthor|forbidden|jwt|session|token/i.test(hay)) {
    return 'AuthError';
  }

  if (code === 'REQUETE_INVALIDE' || /invalid|required|missing|validation|expected/i.test(hay)) {
    return 'ValidationError';
  }

  if (category === 'payment' || /paiement|wallet|escrow|stripe|mtn|airtel|orangemoney|moov/i.test(hay)) {
    return 'PaymentError';
  }

  if (category === 'network' || /network|fetch|timeout|econnrefused|enotfound|api injoignable|backend down/i.test(hay)) {
    return 'NetworkError';
  }

  if (source === 'mobile' && category === 'crash') {
    return 'RuntimeError';
  }

  if (/twilio|sms|sendgrid|mailgun|cloudinary|supabase storage/i.test(hay)) {
    return 'ExternalServiceError';
  }

  if (path.includes('/wallet') || path.includes('/payment')) return 'PaymentError';
  if (path.includes('/auth') || path.includes('/otp')) return 'AuthError';
  if (/typeerror|referenceerror|cannot read|undefined is not|is not a function|is not iterable/i.test(hay)) {
    return 'RuntimeError';
  }

  return 'UnknownError';
}

// -----------------------------------------------------------------------------
// Cause probable : explication humaine de l'incident
// -----------------------------------------------------------------------------
function deriveCause(input = {}) {
  const { code, message, httpStatus, category, source, errorType } = input;
  const msg = String(message || '').toLowerCase();

  if (code === 'NON_AUTORISE' || httpStatus === 401) {
    return 'Session expirée ou jeton invalide — l’utilisateur doit se reconnecter.';
  }
  if (code === 'INTERDIT' || httpStatus === 403) {
    return 'Droits insuffisants pour cette action.';
  }
  if (code === 'INTROUVABLE' || httpStatus === 404) {
    return 'Ressource introuvable (ID incorrect ou données supprimées).';
  }
  if (code === 'RATE_LIMIT' || httpStatus === 429) {
    return 'Trop de requêtes — limiter les tentatives ou attendre.';
  }
  if (code === 'ERREUR_SERVEUR' || (httpStatus && httpStatus >= 500)) {
    return 'Erreur interne serveur — vérifier les logs backend avec le requestId.';
  }
  if (errorType === 'DatabaseError') {
    if (/does not exist/i.test(msg)) return 'Table ou colonne PostgreSQL manquante — migration SQL non appliquée.';
    if (/duplicate key|unique constraint/i.test(msg)) return 'Conflit d’unicité : une ligne identique existe déjà.';
    if (/foreign key/i.test(msg)) return 'Violation de clé étrangère : référence manquante ou invalide.';
    if (/null value/i.test(msg)) return 'Champ obligatoire NULL en base — validation côté applicatif à renforcer.';
    return 'Erreur PostgreSQL/Supabase — voir le message détaillé.';
  }
  if (errorType === 'ExternalServiceError') {
    return 'Échec d’un service externe (Twilio, provider SMS, etc.) — vérifier les credentials et la disponibilité.';
  }
  if (errorType === 'NetworkError') {
    return 'Problème réseau ou API injoignable (connexion, timeout, backend down).';
  }
  if (errorType === 'PaymentError') {
    return 'Échec du flux paiement / portefeuille (escrow, solde, provider).';
  }
  if (errorType === 'ValidationError' || httpStatus === 400) {
    return 'Données invalides envoyées par le client ou règle métier non respectée.';
  }
  if (source === 'mobile' && category === 'crash') {
    return 'Crash JavaScript non géré dans l’application mobile.';
  }
  if (message) return `Cause probable : ${String(message).slice(0, 500)}`;
  return 'Cause non classifiée — analyser le message, la stack et le requestId.';
}

function inferCategory(payload = {}) {
  const path = String(payload.http_path || payload.httpPath || '').toLowerCase();
  const cat = String(payload.category || '').toLowerCase();
  if (cat && cat !== 'unknown') return cat.slice(0, 64);
  if (path.includes('/auth') || path.includes('/otp')) return 'auth';
  if (path.includes('/wallet') || path.includes('/paiement') || path.includes('/payment')) return 'payment';
  if (path.includes('/orders') || path.includes('/commandes')) return 'order';
  if (path.includes('/delivery') || path.includes('/livraison')) return 'delivery';
  if (payload.severity === 'info') return 'info';
  return 'api';
}

function normalizeIncidentInput(input = {}) {
  const severity = SEVERITIES.has(input.severity) ? input.severity : 'error';
  const source = SOURCES.has(input.source) ? input.source : 'api';
  const category = inferCategory(input);
  const errorType = ERROR_TYPES.has(input.error_type) ? input.error_type : classifyError({ ...input, category, source });
  const message = String(input.message || input.title || 'Erreur sans message').slice(0, 4000);
  const title = String(input.title || message).slice(0, 500);
  const fingerprint = input.fingerprint || fingerprintPayload({
    http_method: input.http_method || input.httpMethod,
    http_path: input.http_path || input.httpPath,
    error_type: errorType,
    code: input.code,
    message,
  });
  const cause =
    input.cause ||
    deriveCause({
      code: input.code || input.metadata?.code,
      message,
      httpStatus: input.http_status ?? input.httpStatus,
      category,
      source,
      errorType,
    });

  // Analyse de la stack : frames, top_frame, github_url, code_context.
  // On privilégie une analyse déjà fournie par le client (admin web / mobile)
  // sinon on parse la stack Node côté serveur.
  let frames = null;
  let topFrame = null;
  let githubUrl = null;
  let codeContext = null;
  if (Array.isArray(input.frames) && input.frames.length > 0) {
    frames = sourceMapper.normalizeClientFrames(input.frames);
    topFrame = frames.find((f) => f.in_app) || frames[0] || null;
    githubUrl = topFrame?.github_url || null;
  } else if (input.stack) {
    const analysis = sourceMapper.analyzeStack(String(input.stack));
    frames = analysis.frames;
    topFrame = analysis.top_frame;
    githubUrl = analysis.github_url;
    codeContext = analysis.code_context;
  }

  return {
    request_id: String(input.request_id || input.requestId || 'unknown').slice(0, 128),
    source,
    severity,
    category,
    error_type: errorType,
    fingerprint,
    title,
    message,
    cause: String(cause).slice(0, 2000),
    stack: input.stack ? String(input.stack).slice(0, 12000) : null,
    frames,
    source_location: topFrame,
    code_context: codeContext,
    github_url: githubUrl,
    http_method: input.http_method || input.httpMethod || null,
    http_path: input.http_path || input.httpPath || null,
    http_status: input.http_status ?? input.httpStatus ?? null,
    latency_ms: input.latency_ms ?? input.latencyMs ?? null,
    user_id: input.user_id || input.userId || null,
    user_role: input.user_role || input.userRole || null,
    platform: input.platform ? String(input.platform).slice(0, 32) : null,
    app_version: input.app_version || input.appVersion || null,
    device_info:
      input.device_info && typeof input.device_info === 'object'
        ? input.device_info
        : input.deviceInfo && typeof input.deviceInfo === 'object'
          ? input.deviceInfo
          : {},
    metadata:
      input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    request_payload:
      input.request_payload && typeof input.request_payload === 'object' ? input.request_payload : null,
    environment: input.environment ? String(input.environment).slice(0, 32) : null,
    release: input.release ? String(input.release).slice(0, 32) : null,
  };
}

async function recordIncident(input) {
  const row = normalizeIncidentInput(input);

  if (row.severity === 'info' && process.env.OBSERVABILITY_LOG_INFO !== '1') {
    return { ok: true, skipped: true };
  }

  try {
    const db = getDb();
    // Tenter d'abord d'incrémenter un incident existant (state <> 'resolu') sur le même fingerprint.
    if (row.fingerprint) {
      const { data: existing } = await db
        .from('app_incidents')
        .select('id, occurrence_count')
        .eq('fingerprint', row.fingerprint)
        .neq('state', 'resolu')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (existing) {
        const { data: updated, error: updErr } = await db
          .from('app_incidents')
          .update({
            occurrence_count: (existing.occurrence_count || 1) + 1,
            last_seen_at: new Date().toISOString(),
          })
          .eq('id', existing.id)
          .select('id, occurrence_count')
          .single();
        if (!updErr) {
          return { ok: true, id: updated?.id, deduped: true };
        }
      }
    }
    const { data, error } = await db.from('app_incidents').insert(row).select('id').single();
    if (error) {
      logWarn({
        msg: 'app_incidents insert failed',
        requestId: row.request_id,
        dbError: error.message,
      });
      return { ok: false, error: error.message };
    }
    return { ok: true, id: data?.id, fingerprint: row.fingerprint };
  } catch (err) {
    logError({
      msg: 'recordIncident exception',
      requestId: row.request_id,
      error: err?.message || String(err),
    });
    return { ok: false, error: err?.message };
  }
}

function recordIncidentAsync(input) {
  void recordIncident(input);
}

// -----------------------------------------------------------------------------
// Métriques brutes (alimenté par le middleware)
// -----------------------------------------------------------------------------
async function recordRequestMetric(metric) {
  try {
    const db = getDb();
    await db.from('request_metrics').insert({
      request_id: String(metric.requestId || 'unknown').slice(0, 128),
      method: String(metric.method || 'GET').slice(0, 8),
      path: String(metric.path || '').slice(0, 256),
      status: Number(metric.status) || 0,
      latency_ms: Math.max(0, Math.min(Number(metric.latencyMs) || 0, 600000)),
      source: metric.source ? String(metric.source).slice(0, 32) : null,
      user_id: metric.userId || null,
      user_role: metric.userRole ? String(metric.userRole).slice(0, 32) : null,
      error_type: metric.errorType ? String(metric.errorType).slice(0, 64) : null,
      fingerprint: metric.fingerprint ? String(metric.fingerprint).slice(0, 32) : null,
      environment: metric.environment ? String(metric.environment).slice(0, 32) : null,
    });
  } catch (err) {
    logWarn({ msg: 'recordRequestMetric failed', error: err?.message || String(err) });
  }
}

function recordRequestMetricAsync(metric) {
  void recordRequestMetric(metric);
}

function isSlowRequest(latencyMs) {
  return Number(latencyMs) >= SLOW_REQUEST_MS;
}

// -----------------------------------------------------------------------------
// Lecture : list / detail / groups
// -----------------------------------------------------------------------------
async function listIncidentsForAdmin({
  limit = 50,
  offset = 0,
  resolved,
  source,
  severity,
  state,
  errorType,
  requestId,
  q,
  fingerprint,
} = {}) {
  const db = getDb();
  let query = db
    .from('app_incidents')
    .select('*', { count: 'exact' })
    .order('last_seen_at', { ascending: false })
    .range(offset, offset + Math.min(limit, 100) - 1);

  if (resolved === true) query = query.eq('resolved', true);
  if (resolved === false) query = query.eq('resolved', false);
  if (resolved === undefined && state) {
    if (state === 'ouvert') query = query.neq('state', 'resolu');
    else query = query.eq('state', state);
  }
  if (source) query = query.eq('source', source);
  if (severity) query = query.eq('severity', severity);
  if (errorType) query = query.eq('error_type', errorType);
  if (requestId) query = query.eq('request_id', requestId);
  if (fingerprint) query = query.eq('fingerprint', fingerprint);

  const { data, error, count } = await query;
  if (error) throw error;

  let rows = data || [];
  if (q && String(q).trim()) {
    const needle = String(q).trim().toLowerCase();
    rows = rows.filter((r) => {
      const hay = [r.title, r.message, r.cause, r.request_id, r.http_path, r.category, r.error_type, r.fingerprint]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(needle);
    });
  }
  return { items: rows, total: count ?? rows.length };
}

async function listIncidentGroups({ windowMin = 60, source, severity, state } = {}) {
  const db = getDb();
  const since = new Date(Date.now() - windowMin * 60 * 1000).toISOString();
  let query = db
    .from('app_incidents')
    .select('id, fingerprint, error_type, title, severity, source, state, http_method, http_path, occurrence_count, first_seen_at, last_seen_at, resolved')
    .not('fingerprint', 'is', null)
    .gte('last_seen_at', since)
    .order('occurrence_count', { ascending: false })
    .limit(50);
  if (source) query = query.eq('source', source);
  if (severity) query = query.eq('severity', severity);
  if (state) {
    if (state === 'ouvert') query = query.neq('state', 'resolu');
    else query = query.eq('state', state);
  }
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function getIncidentById(id) {
  const db = getDb();
  const { data, error } = await db.from('app_incidents').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function getIncidentEvents(incidentId) {
  const db = getDb();
  const { data, error } = await db
    .from('incident_events')
    .select('*')
    .eq('incident_id', incidentId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return data || [];
}

async function getRelatedIncidents(requestId, excludeId) {
  const db = getDb();
  let query = db
    .from('app_incidents')
    .select('id, title, severity, source, state, error_type, occurrence_count, last_seen_at, resolved')
    .eq('request_id', requestId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (excludeId) query = query.neq('id', excludeId);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function countOpenIncidents() {
  const db = getDb();
  const { count, error } = await db
    .from('app_incidents')
    .select('id', { count: 'exact', head: true })
    .neq('state', 'resolu')
    .in('severity', ['error', 'warn']);
  if (error) throw error;
  return count ?? 0;
}

async function transitionIncidentState(id, newState, adminUserId, adminNote) {
  if (!STATES.has(newState)) {
    const err = new Error('state invalide');
    err.status = 400;
    err.code = 'REQUETE_INVALIDE';
    throw err;
  }
  const db = getDb();
  const patch = { state: newState };
  if (newState === 'acquitte') {
    patch.acknowledged_at = new Date().toISOString();
    patch.acknowledged_by = adminUserId;
  }
  if (newState === 'resolu') {
    patch.resolved = true;
    patch.resolved_at = new Date().toISOString();
    patch.resolved_by = adminUserId;
    if (adminNote) patch.admin_note = String(adminNote).slice(0, 2000);
  }
  if (newState === 'ouvert') {
    patch.resolved = false;
    patch.resolved_at = null;
    patch.resolved_by = null;
  }
  const { data, error } = await db
    .from('app_incidents')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function resolveIncident(id, adminUserId, adminNote) {
  return transitionIncidentState(id, 'resolu', adminUserId, adminNote);
}

async function acknowledgeIncident(id, adminUserId) {
  return transitionIncidentState(id, 'acquitte', adminUserId, null);
}

async function investigatingIncident(id, adminUserId) {
  return transitionIncidentState(id, 'en_cours', adminUserId, null);
}

async function reopenIncident(id) {
  const db = getDb();
  const { data, error } = await db
    .from('app_incidents')
    .update({
      state: 'ouvert',
      resolved: false,
      resolved_at: null,
      resolved_by: null,
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function addIncidentNote(incidentId, adminUserId, message) {
  const db = getDb();
  const { data, error } = await db
    .from('incident_events')
    .insert({
      incident_id: incidentId,
      event_type: 'note',
      actor_kind: 'admin',
      actor_id: adminUserId,
      message: String(message).slice(0, 4000),
      metadata: {},
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

function incidentFromHttpError(err, req, overrides = {}) {
  const status = err.status || overrides.http_status || 500;
  const severity = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
  const code = err.code || overrides.code;
  const category = overrides.category || inferCategory({ http_path: req.originalUrl, ...overrides });
  const errorType = classifyError({ code, message: err.message, category, source: 'backend' });

  // Analyse de la stack pour le debug Sentry-like.
  let frames = null;
  let topFrame = null;
  let githubUrl = null;
  let codeContext = null;
  if (err.stack) {
    const analysis = sourceMapper.analyzeStack(String(err.stack));
    frames = analysis.frames;
    topFrame = analysis.top_frame;
    githubUrl = analysis.github_url;
    codeContext = analysis.code_context;
  }

  return {
    request_id: req.requestId,
    source: overrides.source || 'backend',
    severity: overrides.severity || severity,
    category,
    error_type: errorType,
    title: overrides.title || `[API ${status}] ${req.method} ${req.originalUrl}`,
    message: err.message || 'Erreur',
    code,
    http_method: req.method,
    http_path: req.originalUrl,
    http_status: status,
    latency_ms: req.requestStartedAt ? Date.now() - req.requestStartedAt : null,
    user_id: req.auth?.userId || null,
    user_role: req.auth?.role || null,
    stack: err.stack || null,
    frames,
    source_location: topFrame,
    code_context: codeContext,
    github_url: githubUrl,
    metadata: {
      code,
      ...(overrides.metadata || {}),
    },
  };
}

module.exports = {
  // helpers
  classifyError,
  fingerprintPayload,
  deriveCause,
  inferCategory,
  normalizeIncidentInput,
  // ingestion
  recordIncident,
  recordIncidentAsync,
  recordRequestMetric,
  recordRequestMetricAsync,
  isSlowRequest,
  SLOW_REQUEST_MS,
  // lecture
  listIncidentsForAdmin,
  listIncidentGroups,
  getIncidentById,
  getIncidentEvents,
  getRelatedIncidents,
  countOpenIncidents,
  // actions admin
  resolveIncident,
  acknowledgeIncident,
  investigatingIncident,
  reopenIncident,
  addIncidentNote,
  transitionIncidentState,
  // conversion
  incidentFromHttpError,
};
