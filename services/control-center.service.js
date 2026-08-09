/**
 * Centre de contrôle GoLivra — vue consolidée de la santé de la plateforme.
 *
 * Regroupe en un seul appel :
 *   - services  : statut des composants (API, base de données, paiements, mobile)
 *   - technical : volume, taux de succès, répartition par code HTTP, latences
 *   - business  : commandes + paiements du jour (par méthode)
 *   - actors    : boutiques, restaurants, livreurs, clients
 *   - mobile    : incidents 7 jours, versions, dernier crash
 *   - incidents : incidents ouverts + top groupes
 *
 * Chaque section est défensive : si une table/colonne manque (schéma partiel),
 * la section renvoie `null` au lieu de faire planter tout le dashboard.
 */

const { getDb } = require('../config/db');
const observability = require('./observability.service');

const DAY_MS = 24 * 60 * 60 * 1000;

function safeDivide(a, b) {
  if (!Number.isFinite(Number(a))) return 0;
  if (!Number.isFinite(Number(b)) || Number(b) <= 0) return 0;
  return Number(a) / Number(b);
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.floor(p * sortedArr.length)));
  return sortedArr[idx];
}

const STATUS_LABEL = { ok: 'Opérationnel', degraded: 'Dégradé', down: 'Hors ligne' };

// ─────────────────────────────────────────────────────────────────────────────
// Technique : volume + répartition par statut HTTP + latences
// ─────────────────────────────────────────────────────────────────────────────
async function computeTechnical(db, sinceWindow) {
  try {
    const { data, error } = await db
      .from('request_metrics')
      .select('status, latency_ms, error_type')
      .gte('created_at', sinceWindow);
    if (error) throw error;
    const metrics = data || [];
    const requestCount = metrics.length;
    const byStatus = { c2xx: 0, c3xx: 0, c400: 0, c401: 0, c404: 0, c4xx: 0, c5xx: 0 };
    for (const m of metrics) {
      const s = Number(m.status) || 0;
      // 503 « règle métier » (feature flags coupés par l'admin) : pas une panne.
      if (s >= 500 && m.error_type === 'feature_disabled') continue;
      if (s >= 500) byStatus.c5xx += 1;
      else if (s === 400) byStatus.c400 += 1;
      else if (s === 401) byStatus.c401 += 1;
      else if (s === 404) byStatus.c404 += 1;
      else if (s >= 400) byStatus.c4xx += 1;
      else if (s >= 300) byStatus.c3xx += 1;
      else byStatus.c2xx += 1;
    }
    const errorCount =
      byStatus.c5xx + byStatus.c4xx + byStatus.c400 + byStatus.c401 + byStatus.c404;
    const latencies = metrics.map((m) => Number(m.latency_ms) || 0).sort((a, b) => a - b);
    return {
      request_count: requestCount,
      error_count: errorCount,
      success_rate: safeDivide(byStatus.c2xx + byStatus.c3xx, requestCount),
      error_rate: safeDivide(errorCount, requestCount),
      by_status: byStatus,
      latency: {
        p50_ms: percentile(latencies, 0.5),
        p95_ms: percentile(latencies, 0.95),
        p99_ms: percentile(latencies, 0.99),
      },
    };
  } catch (err) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Services : statut par composant
// ─────────────────────────────────────────────────────────────────────────────
async function computeServices(db, { sinceWindow, sinceDay }) {
  const empty = { status: 'unknown', label: 'Inconnu' };
  try {
    const [trafficRes, dbErrRes, payIncidentRes, payRes, mobileErrRes] = await Promise.all([
      db.from('request_metrics').select('status, error_type').gte('created_at', sinceWindow),
      db
        .from('app_incidents')
        .select('id')
        .eq('source', 'backend')
        .eq('error_type', 'DatabaseError')
        .neq('state', 'resolu')
        .gte('created_at', sinceDay),
      db
        .from('app_incidents')
        .select('id')
        .or('error_type.eq.PaymentError,category.eq.payment')
        .neq('state', 'resolu')
        .gte('created_at', sinceDay),
      db.from('paiements').select('statut').gte('created_at', sinceDay),
      db
        .from('app_incidents')
        .select('id')
        .eq('source', 'mobile')
        .eq('severity', 'error')
        .neq('state', 'resolu')
        .gte('created_at', sinceDay),
    ]);

    // API : trafic dans la fenêtre + taux d'erreur 5xx
    const traffic = trafficRes.data || [];
    const trafficCount = traffic.length;
    const fiveXx = traffic.filter(
      (m) => Number(m.status) >= 500 && m.error_type !== 'feature_disabled'
    ).length;
    const apiRate = safeDivide(fiveXx, trafficCount);
    let api = { status: 'ok', label: STATUS_LABEL.ok };
    if (trafficCount === 0) {
      api = { status: 'ok', label: 'Aucun trafic mesuré' };
    } else if (apiRate > 0.5) {
      api = { status: 'down', label: `${Math.round(apiRate * 100)}% de 5xx` };
    } else if (apiRate > 0.15) {
      api = { status: 'degraded', label: `${Math.round(apiRate * 100)}% de 5xx` };
    }

    const database = {
      status: (dbErrRes.data || []).length > 0 ? 'degraded' : 'ok',
      label: (dbErrRes.data || []).length > 0 ? 'Erreurs base récentes' : STATUS_LABEL.ok,
    };

    const payments =
      (payIncidentRes.data || []).length > 0 ||
      (payRes.data || []).filter((p) => p.statut === 'echoue').length > 0
        ? { status: 'degraded', label: 'Échecs récents' }
        : { status: 'ok', label: STATUS_LABEL.ok };

    const mobile =
      (mobileErrRes.data || []).length > 0
        ? { status: 'degraded', label: 'Erreurs mobile récentes' }
        : { status: 'ok', label: STATUS_LABEL.ok };

    return { api, database, payments, mobile };
  } catch (err) {
    return { api: empty, database: empty, payments: empty, mobile: empty };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Business : commandes + paiements du jour
// ─────────────────────────────────────────────────────────────────────────────
async function computeBusiness(db, todayStart) {
  try {
    const [ordersRes, paymentsRes] = await Promise.all([
      db.from('commandes').select('statut').gte('created_at', todayStart),
      db.from('paiements').select('methode, statut').gte('created_at', todayStart),
    ]);
    if (ordersRes.error) throw ordersRes.error;
    if (paymentsRes.error) throw paymentsRes.error;

    const orders = (ordersRes.data || []).map((o) => o.statut);
    const ACCEPTEES = new Set(['acceptee', 'partiellement_acceptee', 'en_preparation', 'prete', 'en_livraison']);
    const LIVREES = new Set(['livree', 'partiellement_livree']);
    const ANNULEES = new Set(['annulee', 'remboursee']);
    const EN_COURS = new Set(['en_attente', 'partiellement_acceptee', 'acceptee', 'en_preparation', 'prete', 'en_livraison']);

    const byMethod = {};
    for (const p of paymentsRes.data || []) {
      const k = p.methode || 'autre';
      if (!byMethod[k]) byMethod[k] = { methode: k, total: 0, reussis: 0, echoues: 0 };
      byMethod[k].total += 1;
      if (p.statut === 'valide') byMethod[k].reussis += 1;
      if (p.statut === 'echoue') byMethod[k].echoues += 1;
    }

    return {
      orders: {
        total: orders.length,
        acceptees: orders.filter((s) => ACCEPTEES.has(s)).length,
        livrees: orders.filter((s) => LIVREES.has(s)).length,
        annulees: orders.filter((s) => ANNULEES.has(s)).length,
        en_cours: orders.filter((s) => EN_COURS.has(s)).length,
      },
      payments: Object.values(byMethod)
        .map((m) => ({ ...m, taux_reussite: safeDivide(m.reussis, m.total) }))
        .sort((a, b) => b.total - a.total),
    };
  } catch (err) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Acteurs : boutiques, restaurants, livreurs, clients
// ─────────────────────────────────────────────────────────────────────────────
async function computeActors(db, todayStart, sinceDay) {
  try {
    const { data: clientRole } = await db
      .from('roles')
      .select('id')
      .eq('nom', 'client')
      .maybeSingle();
    const [boutRes, restRes, livrRes, delivRes, clientCountRes, activeUsersRes] = await Promise.all([
      db.from('boutiques').select('statut'),
      db.from('restaurants').select('statut'),
      db.from('livreurs').select('est_disponible'),
      db.from('livraisons').select('livreur_id').in('statut', ['attribuee', 'en_collecte', 'collectee', 'en_route']),
      clientRole
        ? db.from('utilisateurs').select('id', { count: 'exact', head: true }).eq('role_id', clientRole.id)
        : Promise.resolve({ count: null, error: null }),
      db
        .from('request_metrics')
        .select('user_id')
        .gte('created_at', sinceDay)
        .not('user_id', 'is', null),
    ]);

    const countStatut = (rows, statut) =>
      (rows || []).filter((r) => r.statut === statut).length;

    const enLivraison = new Set((delivRes.data || []).map((d) => d.livreur_id).filter(Boolean));

    return {
      boutiques: { total: (boutRes.data || []).length, actives: countStatut(boutRes.data, 'active') },
      restaurants: { total: (restRes.data || []).length, actives: countStatut(restRes.data, 'active') },
      livreurs: {
        total: (livrRes.data || []).length,
        disponibles: (livrRes.data || []).filter((l) => l.est_disponible === true).length,
        en_livraison: enLivraison.size,
      },
      clients: {
        total: clientCountRes?.count ?? (clientRole ? null : 0),
        actifs_aujourdhui: new Set((activeUsersRes.data || []).map((u) => u.user_id)).size,
      },
    };
  } catch (err) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile : incidents 7 jours, versions, dernier crash
// ─────────────────────────────────────────────────────────────────────────────
async function computeMobile(db, since7d) {
  try {
    const [incidentsRes, requestsRes] = await Promise.all([
      db
        .from('app_incidents')
        .select('app_version, platform, severity, error_type, title, created_at')
        .eq('source', 'mobile')
        .gte('created_at', since7d)
        .order('created_at', { ascending: false }),
      db.from('request_metrics').select('id').eq('source', 'mobile').gte('created_at', since7d),
    ]);
    if (incidentsRes.error) throw incidentsRes.error;

    const incidents = incidentsRes.data || [];
    const versions = {};
    for (const inc of incidents) {
      const v = inc.app_version || 'inconnue';
      versions[v] = (versions[v] || 0) + 1;
    }
    const crashIncidents = incidents.filter((i) => i.severity === 'error');
    const dernierCrash = crashIncidents[0] || null;

    return {
      incidents_7j: incidents.length,
      crash_rate_7j: safeDivide(crashIncidents.length, requestsRes.data ? requestsRes.data.length : 0),
      versions: Object.entries(versions)
        .map(([app_version, count]) => ({ app_version, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
      dernier_crash: dernierCrash
        ? {
            title: dernierCrash.title || 'Crash non décrit',
            app_version: dernierCrash.app_version || null,
            platform: dernierCrash.platform || null,
            created_at: dernierCrash.created_at,
          }
        : null,
    };
  } catch (err) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Incidents : compteur ouvert + top groupes
// ─────────────────────────────────────────────────────────────────────────────
async function computeIncidents(windowMin) {
  try {
    const [openCount, groups] = await Promise.all([
      observability.countOpenIncidents(),
      observability.listIncidentGroups({ windowMin }),
    ]);
    return {
      open_count: openCount ?? 0,
      top: (groups || []).slice(0, 5),
    };
  } catch (err) {
    return { open_count: 0, top: [] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Vue consolidée
// ─────────────────────────────────────────────────────────────────────────────
async function getControlCenterOverview({ windowMin = 60 } = {}) {
  const db = getDb();
  const now = new Date();
  const sinceWindow = new Date(now.getTime() - windowMin * 60 * 1000).toISOString();
  const sinceDay = new Date(now.getTime() - DAY_MS).toISOString();
  const since7d = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

  const [services, technical, business, actors, mobile, incidents] = await Promise.all([
    computeServices(db, { sinceWindow, sinceDay }),
    computeTechnical(db, sinceWindow),
    computeBusiness(db, todayStart),
    computeActors(db, todayStart, sinceDay),
    computeMobile(db, since7d),
    computeIncidents(windowMin),
  ]);

  const list = Object.values(services || {});
  const anyDown = list.some((s) => s?.status === 'down');
  const anyDegraded = list.some((s) => s?.status === 'degraded');
  // Si aucun composant n'a pu être évalué (ex. base de données injoignable),
  // on affiche « inconnu » plutôt qu'un faux « opérationnel ».
  const allUnknown = list.length > 0 && list.every((s) => s?.status === 'unknown');
  const globalStatus =
    anyDown ? 'down' : anyDegraded ? 'degraded' : allUnknown || list.length === 0 ? 'unknown' : 'ok';

  return {
    generated_at: now.toISOString(),
    window_min: windowMin,
    global_status: globalStatus,
    services,
    technical,
    business,
    actors,
    mobile,
    incidents,
  };
}

module.exports = {
  getControlCenterOverview,
  computeTechnical,
  computeServices,
  computeBusiness,
  computeActors,
  computeMobile,
  computeIncidents,
  safeDivide,
};
