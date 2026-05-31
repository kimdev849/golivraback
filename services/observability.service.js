const { getDb } = require('../config/db');
const { error: logError, warn: logWarn } = require('../utils/logger');

const SEVERITIES = new Set(['error', 'warn', 'info']);
const SOURCES = new Set(['mobile', 'admin', 'backend', 'api']);

function deriveCause(input = {}) {
  const { code, message, httpStatus, category, source } = input;
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
  if (category === 'network' || msg.includes('network') || msg.includes('fetch')) {
    return 'Problème réseau ou API injoignable (connexion, timeout, backend down).';
  }
  if (category === 'payment' || msg.includes('paiement') || msg.includes('wallet')) {
    return 'Échec du flux paiement / portefeuille (escrow, solde, provider).';
  }
  if (category === 'validation' || httpStatus === 400) {
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
  const message = String(input.message || input.title || 'Erreur sans message').slice(0, 4000);
  const title = String(input.title || message).slice(0, 500);
  const cause =
    input.cause ||
    deriveCause({
      code: input.code || input.metadata?.code,
      message,
      httpStatus: input.http_status ?? input.httpStatus,
      category,
      source,
    });

  return {
    request_id: String(input.request_id || input.requestId || 'unknown').slice(0, 128),
    source,
    severity,
    category,
    title,
    message,
    cause: String(cause).slice(0, 2000),
    stack: input.stack ? String(input.stack).slice(0, 12000) : null,
    http_method: input.http_method || input.httpMethod || null,
    http_path: input.http_path || input.httpPath || null,
    http_status: input.http_status ?? input.httpStatus ?? null,
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
  };
}

async function recordIncident(input) {
  const row = normalizeIncidentInput(input);

  if (row.severity === 'info' && process.env.OBSERVABILITY_LOG_INFO !== '1') {
    return { ok: true, skipped: true };
  }

  try {
    const db = getDb();
    const { data, error } = await db.from('app_incidents').insert(row).select('id').single();
    if (error) {
      logWarn({
        msg: 'app_incidents insert failed',
        requestId: row.request_id,
        dbError: error.message,
      });
      return { ok: false, error: error.message };
    }
    return { ok: true, id: data?.id };
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

async function listIncidentsForAdmin({
  limit = 50,
  offset = 0,
  resolved,
  source,
  severity,
  requestId,
  q,
} = {}) {
  const db = getDb();
  let query = db
    .from('app_incidents')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + Math.min(limit, 100) - 1);

  if (resolved === true) query = query.eq('resolved', true);
  if (resolved === false) query = query.eq('resolved', false);
  if (source) query = query.eq('source', source);
  if (severity) query = query.eq('severity', severity);
  if (requestId) query = query.eq('request_id', requestId);

  const { data, error, count } = await query;
  if (error) throw error;

  let rows = data || [];
  if (q && String(q).trim()) {
    const needle = String(q).trim().toLowerCase();
    rows = rows.filter((r) => {
      const hay = [r.title, r.message, r.cause, r.request_id, r.http_path, r.category]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(needle);
    });
  }

  return { items: rows, total: count ?? rows.length };
}

async function getIncidentById(id) {
  const db = getDb();
  const { data, error } = await db.from('app_incidents').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function getRelatedIncidents(requestId, excludeId) {
  const db = getDb();
  let query = db
    .from('app_incidents')
    .select('id, title, severity, source, created_at, resolved')
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
    .eq('resolved', false)
    .in('severity', ['error', 'warn']);
  if (error) throw error;
  return count ?? 0;
}

async function resolveIncident(id, adminUserId, adminNote) {
  const db = getDb();
  const { data, error } = await db
    .from('app_incidents')
    .update({
      resolved: true,
      resolved_at: new Date().toISOString(),
      resolved_by: adminUserId,
      admin_note: adminNote ? String(adminNote).slice(0, 2000) : null,
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

function incidentFromHttpError(err, req, overrides = {}) {
  const status = err.status || overrides.http_status || 500;
  const severity = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
  const code = err.code || overrides.code;

  return {
    request_id: req.requestId,
    source: overrides.source || 'backend',
    severity: overrides.severity || severity,
    category: overrides.category || inferCategory({ http_path: req.originalUrl, ...overrides }),
    title: overrides.title || `[API ${status}] ${req.method} ${req.originalUrl}`,
    message: err.message || 'Erreur',
    code,
    http_method: req.method,
    http_path: req.originalUrl,
    http_status: status,
    user_id: req.auth?.userId || null,
    user_role: req.auth?.role || null,
    stack: err.stack || null,
    metadata: {
      code,
      ...(overrides.metadata || {}),
    },
  };
}

module.exports = {
  deriveCause,
  recordIncident,
  recordIncidentAsync,
  listIncidentsForAdmin,
  getIncidentById,
  getRelatedIncidents,
  countOpenIncidents,
  resolveIncident,
  incidentFromHttpError,
};
