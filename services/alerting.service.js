const { getDb } = require('../config/db');
const { warn: logWarn, error: logError, info: logInfo } = require('../utils/logger');

/**
 * Évalue les règles d'alerte et envoie des notifications.
 * - kind=error_rate        : { path, threshold, window_min }
 * - kind=slow_endpoint     : { threshold_ms, window_min }
 * - kind=incident_severity : { severity, count, window_min }
 * - kind=spike             : { baseline_min, factor }
 */
async function evaluateRules() {
  const db = getDb();
  const { data: rules, error } = await db
    .from('alert_rules')
    .select('*')
    .eq('est_actif', true);
  if (error) {
    logWarn({ msg: 'evaluateRules: load failed', error: error.message });
    return { evaluated: 0, fired: 0 };
  }
  let fired = 0;
  for (const rule of rules || []) {
    try {
      const triggered = await isRuleTriggered(rule);
      if (!triggered) continue;
      if (isInCooldown(rule)) continue;
      await dispatchAlert(rule, triggered);
      fired += 1;
    } catch (err) {
      logError({ msg: 'evaluateRules: rule failed', ruleId: rule.id, error: err.message });
    }
  }
  return { evaluated: (rules || []).length, fired };
}

function isInCooldown(rule) {
  if (!rule.last_fired_at) return false;
  const cooldownMs = (rule.cooldown_min || 15) * 60 * 1000;
  return Date.now() - new Date(rule.last_fired_at).getTime() < cooldownMs;
}

async function isRuleTriggered(rule) {
  const cond = rule.condition || {};
  const db = getDb();
  const windowMin = cond.window_min || 15;
  const since = new Date(Date.now() - windowMin * 60 * 1000).toISOString();

  if (cond.kind === 'error_rate') {
    let q = db.from('request_metrics').select('status').gte('created_at', since);
    if (cond.path) q = q.eq('path', cond.path);
    if (cond.method) q = q.eq('method', cond.method);
    const { data } = await q;
    const total = (data || []).length;
    if (total === 0) return null;
    const errors = (data || []).filter((r) => r.status >= 500).length;
    const rate = errors / total;
    if (rate >= (cond.threshold || 0.1)) {
      return {
        title: `Taux d'erreur élevé sur ${cond.method || ''} ${cond.path || ''}`.trim(),
        message: `${(rate * 100).toFixed(1)}% d'erreurs sur ${total} requêtes (seuil ${(cond.threshold * 100).toFixed(0)}%)`,
        severity: 'error',
        metadata: { kind: 'error_rate', rate, total, errors, window_min: windowMin, path: cond.path, method: cond.method },
      };
    }
  }

  if (cond.kind === 'slow_endpoint') {
    let q = db.from('request_metrics').select('latency_ms').gte('created_at', since);
    if (cond.path) q = q.eq('path', cond.path);
    const { data } = await q;
    const total = (data || []).length;
    if (total === 0) return null;
    const slow = (data || []).filter((r) => (r.latency_ms || 0) >= (cond.threshold_ms || 2000)).length;
    const rate = slow / total;
    if (rate >= (cond.threshold || 0.1)) {
      return {
        title: `Endpoint lent détecté`,
        message: `${(rate * 100).toFixed(1)}% des requêtes > ${cond.threshold_ms}ms sur ${cond.path || 'tous'}`,
        severity: 'warn',
        metadata: { kind: 'slow_endpoint', rate, total, slow, window_min: windowMin, path: cond.path, threshold_ms: cond.threshold_ms },
      };
    }
  }

  if (cond.kind === 'incident_severity') {
    let q = db
      .from('app_incidents')
      .select('id, severity')
      .gte('created_at', since)
      .neq('state', 'resolu');
    if (cond.severity) q = q.eq('severity', cond.severity);
    const { data } = await q;
    const count = (data || []).length;
    if (count >= (cond.count || 10)) {
      return {
        title: `${count} incidents ${cond.severity || ''} non résolus`,
        message: `Pic d'incidents ${cond.severity || ''} sur les ${windowMin} dernières minutes`,
        severity: cond.severity === 'error' ? 'error' : 'warn',
        metadata: { kind: 'incident_severity', count, severity: cond.severity, window_min: windowMin },
      };
    }
  }

  if (cond.kind === 'spike') {
    const baselineMin = cond.baseline_min || 60;
    const baselineSince = new Date(Date.now() - (windowMin + baselineMin) * 60 * 1000).toISOString();
    const { data: recent } = await db
      .from('app_incidents')
      .select('id')
      .gte('created_at', since);
    const { data: baseline } = await db
      .from('app_incidents')
      .select('id')
      .gte('created_at', baselineSince)
      .lt('created_at', since);
    const recentCount = (recent || []).length;
    const baselineCount = ((baseline || []).length * windowMin) / baselineMin;
    if (baselineCount > 0 && recentCount >= baselineCount * (cond.factor || 3)) {
      return {
        title: `Spike d'incidents détecté`,
        message: `${recentCount} incidents sur ${windowMin}min vs baseline ${baselineCount.toFixed(1)} (x${(recentCount / baselineCount).toFixed(1)})`,
        severity: 'error',
        metadata: { kind: 'spike', recent: recentCount, baseline: baselineCount, factor: recentCount / baselineCount, window_min: windowMin, baseline_min: baselineMin },
      };
    }
  }

  return null;
}

async function dispatchAlert(rule, payload) {
  const db = getDb();
  const channelIds = Array.isArray(rule.channel_ids) ? rule.channel_ids : [];
  if (channelIds.length === 0) {
    logInfo({ msg: 'dispatchAlert: no channels for rule', ruleId: rule.id });
    return;
  }
  const { data: channels } = await db
    .from('alert_channels')
    .select('*')
    .in('id', channelIds)
    .eq('est_actif', true);

  for (const channel of channels || []) {
    try {
      const result = await sendToChannel(channel, payload, rule);
      await db.from('alert_history').insert({
        rule_id: rule.id,
        channel_id: channel.id,
        status: result.ok ? 'envoye' : 'echec',
        message: payload.title,
        metadata: { ...payload.metadata, reason: result.error || null },
      });
    } catch (err) {
      logError({ msg: 'sendToChannel failed', channelId: channel.id, error: err.message });
      await db.from('alert_history').insert({
        rule_id: rule.id,
        channel_id: channel.id,
        status: 'echec',
        message: payload.title,
        metadata: { error: err.message, ...payload.metadata },
      });
    }
  }
  await db
    .from('alert_rules')
    .update({ last_fired_at: new Date().toISOString() })
    .eq('id', rule.id);
}

async function sendToChannel(channel, payload, rule) {
  if (channel.type === 'telegram') return sendTelegram(channel, payload, rule);
  if (channel.type === 'webhook') return sendWebhook(channel, payload, rule);
  if (channel.type === 'email') return sendEmail(channel, payload, rule);
  return { ok: false, error: `Type de canal inconnu: ${channel.type}` };
}

async function sendTelegram(channel, payload) {
  const { bot_token: botToken, chat_id: chatId } = channel.config || {};
  if (!botToken || !chatId) return { ok: false, error: 'bot_token ou chat_id manquant' };
  const text =
    `🚨 *${payload.title}*\n\n` +
    `${payload.message}\n\n` +
    `_Sévérité: ${payload.severity}_`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `Telegram API ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function sendWebhook(channel, payload) {
  const { url, headers: customHeaders = {} } = channel.config || {};
  if (!url) return { ok: false, error: 'url manquante' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...customHeaders },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `Webhook ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function sendEmail(channel, payload) {
  // Hook générique : on enregistre l'événement dans alert_history, l'intégration
  // email réelle est attendue via SMTP/Resend/SES branché sur alert_history.
  return { ok: false, error: 'Canal email non implémenté — branchez votre provider SMTP/SES.' };
}

module.exports = {
  evaluateRules,
  isRuleTriggered,
  dispatchAlert,
  sendToChannel,
};
