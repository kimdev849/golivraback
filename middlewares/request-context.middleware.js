const { newRequestId, info } = require('../utils/logger');

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
    info({
      requestId,
      method: req.method,
      path: req.originalUrl || req.url,
      status,
      ms,
      userId: req.auth?.userId || null,
      clientSource,
    });
  });

  next();
}

module.exports = { requestContextMiddleware };
