const { randomUUID } = require('crypto');

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ message: String(value) });
  }
}

function log(level, payload) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    ...payload,
  };
  const line = safeJson(entry);
  if (level === 'error') {
    console.error(line);
    return;
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  console.log(line);
}

function newRequestId(headerValue) {
  const raw = typeof headerValue === 'string' ? headerValue.trim() : '';
  if (raw && raw.length >= 8 && raw.length <= 128) return raw;
  return randomUUID();
}

module.exports = {
  log,
  info: (payload) => log('info', payload),
  warn: (payload) => log('warn', payload),
  error: (payload) => log('error', payload),
  newRequestId,
};
