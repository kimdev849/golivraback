const { newRequestId, info, warn, error: logError } = require('../utils/logger');
const observability = require('../services/observability.service');

function requestContextMiddleware(req, res, next) {
  const requestId = newRequestId(req.headers['x-request-id']);
  req.requestId = requestId;
  req.requestStartedAt = Date.now();

  res.setHeader('X-Request-Id', requestId);

  const clientSource = String(req.headers['x-client-source'] || 'unknown').slice(0, 32);
  req.clientSource = clientSource;

  res.on('finish', () => {
    const ms = Date.now() - req.requestStartedAt;
    const status = res.statusCode;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';

    // Log console (existant)
    info({
      requestId,
      method: req.method,
      path: req.originalUrl || req.url,
      status,
      ms,
      userId: req.auth?.userId || null,
      clientSource,
    });

    // Persistance métrique + détection slow.
    // Les 503 « règle métier » (feature flags coupés par l'admin) sont marqués
    // feature_disabled : exclus du taux de 5xx du dashboard.
    observability.recordRequestMetricAsync({
      requestId,
      method: req.method,
      path: req.originalUrl || req.url,
      status,
      latencyMs: ms,
      source: clientSource,
      userId: req.auth?.userId || null,
      userRole: req.auth?.role || null,
      errorType: req._businessError ? 'feature_disabled' : null,
    });

    // Auto-capture des erreurs 5xx (en plus des erreurs catchées par le handler global)
    // — sauf les 503 métier volontaires (feature flags coupés par l'admin).
    if (status >= 500 && !req._observabilityCaptured && !req._businessError) {
      const incident = observability.incidentFromHttpError(
        { status, message: `${req.method} ${req.originalUrl} → ${status}`, stack: null },
        req,
        {
          category: observability.inferCategory({ http_path: req.originalUrl }),
          source: 'backend',
        },
      );
      observability.recordIncidentAsync(incident);
    }

    if (observability.isSlowRequest(ms)) {
      warn({ msg: 'slow_request', requestId, ms, path: req.originalUrl, method: req.method });
    }
  });

  next();
}

module.exports = { requestContextMiddleware };
