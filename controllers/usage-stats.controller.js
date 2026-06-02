const { getUsageDashboard } = require('../services/usage-stats.service');

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 365);
}

async function getUsageDashboardHandler(req, res, next) {
  try {
    const windowDays = parsePositiveInt(req.query.window_days, 30);
    const topZonesLimit = parsePositiveInt(req.query.top_zones_limit, 8);
    const data = await getUsageDashboard({ windowDays, topZonesLimit });
    return res.json(data);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getUsageDashboardHandler,
};
