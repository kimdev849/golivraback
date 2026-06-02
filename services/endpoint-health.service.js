const { getDb } = require('../config/db');
const { warn: logWarn, info: logInfo } = require('../utils/logger');

const SLOW_REQUEST_MS = Number(process.env.OBSERVABILITY_SLOW_MS) || 2000;
const ERROR_RATE_DEFAULT_WINDOW = 60; // minutes
const TOP_ENDPOINTS_LIMIT = 20;

function safeDivide(a, b) {
  if (!b || b <= 0) return 0;
  return a / b;
}

/**
 * Récupère l'overview : volume, taux d'erreur, slow, par source, top endpoints,
 * incidents ouverts groupés par error_type.
 */
async function getDashboardOverview({ windowMin = 60 } = {}) {
  const db = getDb();
  const since = new Date(Date.now() - windowMin * 60 * 1000).toISOString();

  const [
    metricsRes,
    bySourceRes,
    byErrorTypeRes,
    openBySeverityRes,
    topEndpointsRes,
    spikeRes,
  ] = await Promise.all([
    db
      .from('request_metrics')
      .select('status, latency_ms')
      .gte('created_at', since),
    db
      .from('request_metrics')
      .select('source, status')
      .gte('created_at', since),
    db
      .from('request_metrics')
      .select('error_type, status')
      .gte('created_at', since)
      .not('error_type', 'is', null),
    db
      .from('app_incidents')
      .select('severity, state, error_type')
      .neq('state', 'resolu'),
    db
      .from('request_metrics')
      .select('method, path, status, latency_ms')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(2000),
    db
      .from('app_incidents')
      .select('fingerprint, occurrence_count, error_type, last_seen_at')
      .neq('state', 'resolu')
      .not('fingerprint', 'is', null)
      .order('occurrence_count', { ascending: false })
      .limit(10),
  ]);

  const metrics = metricsRes.data || [];
  const requestCount = metrics.length;
  const errorCount = metrics.filter((m) => m.status >= 500).length;
  const slowCount = metrics.filter((m) => (m.latency_ms || 0) >= SLOW_REQUEST_MS).length;
  const latencies = metrics.map((m) => m.latency_ms || 0).sort((a, b) => a - b);
  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);
  const p99 = percentile(latencies, 0.99);

  const bySource = {};
  (bySourceRes.data || []).forEach((row) => {
    const k = row.source || 'unknown';
    if (!bySource[k]) bySource[k] = { source: k, request_count: 0, error_count: 0 };
    bySource[k].request_count += 1;
    if (row.status >= 500) bySource[k].error_count += 1;
  });
  Object.values(bySource).forEach((s) => {
    s.error_rate = safeDivide(s.error_count, s.request_count);
  });

  const byErrorType = {};
  (byErrorTypeRes.data || []).forEach((row) => {
    const k = row.error_type || 'UnknownError';
    if (!byErrorType[k]) byErrorType[k] = { error_type: k, count: 0 };
    byErrorType[k].count += 1;
  });

  const openBySeverity = {};
  (openBySeverityRes.data || []).forEach((row) => {
    const k = row.severity || 'info';
    if (!openBySeverity[k]) openBySeverity[k] = { severity: k, count: 0 };
    openBySeverity[k].count += 1;
  });

  // Top endpoints
  const endpointAgg = {};
  (topEndpointsRes.data || []).forEach((row) => {
    const key = `${row.method} ${row.path}`;
    if (!endpointAgg[key]) {
      endpointAgg[key] = {
        method: row.method,
        path: row.path,
        request_count: 0,
        error_count: 0,
        slow_count: 0,
        latencies: [],
      };
    }
    const e = endpointAgg[key];
    e.request_count += 1;
    if (row.status >= 500) e.error_count += 1;
    if ((row.latency_ms || 0) >= SLOW_REQUEST_MS) e.slow_count += 1;
    e.latencies.push(row.latency_ms || 0);
  });
  const topEndpoints = Object.values(endpointAgg)
    .map((e) => ({
      method: e.method,
      path: e.path,
      request_count: e.request_count,
      error_count: e.error_count,
      slow_count: e.slow_count,
      error_rate: safeDivide(e.error_count, e.request_count),
      slow_rate: safeDivide(e.slow_count, e.request_count),
      latency_p50_ms: percentile(e.latencies.sort((a, b) => a - b), 0.5),
      latency_p95_ms: percentile(e.latencies.sort((a, b) => a - b), 0.95),
      latency_p99_ms: percentile(e.latencies.sort((a, b) => a - b), 0.99),
    }))
    .sort((a, b) => b.request_count - a.request_count)
    .slice(0, TOP_ENDPOINTS_LIMIT);

  return {
    window_min: windowMin,
    request_count: requestCount,
    error_count: errorCount,
    slow_count: slowCount,
    error_rate: safeDivide(errorCount, requestCount),
    slow_rate: safeDivide(slowCount, requestCount),
    latency_p50_ms: p50,
    latency_p95_ms: p95,
    latency_p99_ms: p99,
    by_source: Object.values(bySource),
    by_error_type: Object.values(byErrorType).sort((a, b) => b.count - a.count),
    open_by_severity: Object.values(openBySeverity),
    top_endpoints: topEndpoints,
    spikes: (spikeRes.data || []).map((s) => ({
      fingerprint: s.fingerprint,
      error_type: s.error_type,
      occurrence_count: s.occurrence_count,
      last_seen_at: s.last_seen_at,
    })),
  };
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.floor(p * sortedArr.length)));
  return sortedArr[idx];
}

/**
 * Agrège par endpoint sur une fenêtre donnée.
 */
async function getEndpointHealth({ windowMin = 60, minRequests = 1 } = {}) {
  const db = getDb();
  const since = new Date(Date.now() - windowMin * 60 * 1000).toISOString();
  const { data, error } = await db
    .from('request_metrics')
    .select('method, path, status, latency_ms')
    .gte('created_at', since);
  if (error) throw error;

  const agg = {};
  (data || []).forEach((row) => {
    const key = `${row.method} ${row.path}`;
    if (!agg[key]) {
      agg[key] = { method: row.method, path: row.path, latencies: [], request_count: 0, error_count: 0, slow_count: 0 };
    }
    const e = agg[key];
    e.request_count += 1;
    e.latencies.push(row.latency_ms || 0);
    if (row.status >= 500) e.error_count += 1;
    if ((row.latency_ms || 0) >= SLOW_REQUEST_MS) e.slow_count += 1;
  });

  return Object.values(agg)
    .filter((e) => e.request_count >= minRequests)
    .map((e) => {
      const sorted = e.latencies.slice().sort((a, b) => a - b);
      return {
        method: e.method,
        path: e.path,
        request_count: e.request_count,
        error_count: e.error_count,
        slow_count: e.slow_count,
        error_rate: safeDivide(e.error_count, e.request_count),
        slow_rate: safeDivide(e.slow_count, e.request_count),
        latency_p50_ms: percentile(sorted, 0.5),
        latency_p95_ms: percentile(sorted, 0.95),
        latency_p99_ms: percentile(sorted, 0.99),
        latency_max_ms: sorted[sorted.length - 1] || 0,
      };
    })
    .sort((a, b) => b.error_rate - a.error_rate || b.request_count - a.request_count);
}

/**
 * Calcule un snapshot horaire et le persiste (peut être appelé par un cron).
 */
async function persistHourlySnapshot(bucketHour) {
  const db = getDb();
  const hour = bucketHour ? new Date(bucketHour) : new Date();
  hour.setMinutes(0, 0, 0);
  const since = new Date(hour.getTime() - 60 * 60 * 1000).toISOString();
  const bucketIso = hour.toISOString();

  const { data, error } = await db
    .from('request_metrics')
    .select('method, path, status, latency_ms, fingerprint')
    .gte('created_at', since)
    .lt('created_at', bucketIso);
  if (error) {
    logWarn({ msg: 'persistHourlySnapshot fetch failed', error: error.message });
    return { ok: false, error: error.message };
  }

  const agg = {};
  (data || []).forEach((row) => {
    const key = `${row.method} ${row.path}`;
    if (!agg[key]) {
      agg[key] = {
        method: row.method,
        path: row.path,
        latencies: [],
        fingerprintCounts: {},
        request_count: 0,
        error_count: 0,
        slow_count: 0,
      };
    }
    const e = agg[key];
    e.request_count += 1;
    e.latencies.push(row.latency_ms || 0);
    if (row.status >= 500) e.error_count += 1;
    if ((row.latency_ms || 0) >= SLOW_REQUEST_MS) e.slow_count += 1;
    if (row.fingerprint) {
      e.fingerprintCounts[row.fingerprint] = (e.fingerprintCounts[row.fingerprint] || 0) + 1;
    }
  });

  for (const e of Object.values(agg)) {
    const sorted = e.latencies.slice().sort((a, b) => a - b);
    const topFp = Object.entries(e.fingerprintCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const row = {
      bucket_hour: bucketIso,
      method: e.method,
      path: e.path,
      request_count: e.request_count,
      error_count: e.error_count,
      slow_count: e.slow_count,
      latency_p50_ms: percentile(sorted, 0.5),
      latency_p95_ms: percentile(sorted, 0.95),
      latency_p99_ms: percentile(sorted, 0.99),
      latency_max_ms: sorted[sorted.length - 1] || 0,
      top_fingerprint: topFp,
    };
    const { error: upErr } = await db
      .from('endpoint_health_snapshots')
      .upsert(row, { onConflict: 'bucket_hour,method,path' });
    if (upErr) logWarn({ msg: 'endpoint snapshot upsert failed', error: upErr.message });
  }

  logInfo({ msg: 'endpoint health snapshot persisted', bucket: bucketIso, endpoints: Object.keys(agg).length });
  return { ok: true, endpoints: Object.keys(agg).length };
}

module.exports = {
  getDashboardOverview,
  getEndpointHealth,
  persistHourlySnapshot,
  SLOW_REQUEST_MS,
  ERROR_RATE_DEFAULT_WINDOW,
};
