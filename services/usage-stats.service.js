const { getDb } = require('../config/db');

/**
 * Statistiques d'usage de la plateforme — données "produit" (utilisateurs,
 * activité, fréquence, zones) distinctes de l'observabilité technique.
 *
 * Source principale : `utilisateurs` (rôles), `request_metrics` (activité API
 * = proxy fiable pour l'usage mobile), `commandes` (zones de livraison).
 */

const MOBILE_USER_ROLES = new Set(['client', 'livreur']);
const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDayIso(daysAgo = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (daysAgo > 0) d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function normalizeQuartier(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  // Regroupe les variantes de casse / accents grossiers ("makelekele" / "Makélékélé").
  return trimmed
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function prettyQuartier(value) {
  if (!value) return '—';
  const trimmed = String(value).trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

async function getRoleIdMap(db, names) {
  const { data, error } = await db.from('roles').select('id, nom').in('nom', names);
  if (error) throw error;
  return new Map((data || []).map((r) => [r.nom, r.id]));
}

/**
 * Retourne un résumé d'usage :
 *   - utilisateurs mobile (clients, livreurs) inscrits et approuvés
 *   - nouveaux sur 30 jours
 *   - actifs 7j / 30j (d'après request_metrics.distinct user_id)
 *   - fréquence d'usage (commandes / livreur-actif, requêtes / utilisateur-actif)
 *   - top zones de livraison (par quartier, d'après commandes.adresse_livraison_snapshot)
 *
 *   @param {Object} opts
 *   @param {number} [opts.windowDays=30] taille de la fenêtre d'analyse (zones, fréquence)
 *   @param {number} [opts.topZonesLimit=8] nombre max de zones retournées
 */
async function getUsageDashboard({ windowDays = 30, topZonesLimit = 8 } = {}) {
  const db = getDb();
  const windowMs = windowDays * DAY_MS;
  const since = daysAgoIso(windowDays);
  const since7d = daysAgoIso(7);
  const since30d = daysAgoIso(30);
  const newSince = since30d;

  const [roleMap, reqRes7d, reqRes30d] = await Promise.all([
    getRoleIdMap(db, ['client', 'livreur', 'restaurateur', 'commercant']),
    db.from('request_metrics').select('user_id').gte('created_at', since7d).not('user_id', 'is', null),
    db.from('request_metrics').select('user_id, status').gte('created_at', since30d).not('user_id', 'is', null),
  ]);

  const clientRoleId = roleMap.get('client');
  const livreurRoleId = roleMap.get('livreur');
  const restaurateurRoleId = roleMap.get('restaurateur');
  const commercantRoleId = roleMap.get('commercant');

  const roleIdToName = new Map();
  if (clientRoleId) roleIdToName.set(clientRoleId, 'client');
  if (livreurRoleId) roleIdToName.set(livreurRoleId, 'livreur');
  if (restaurateurRoleId) roleIdToName.set(restaurateurRoleId, 'restaurateur');
  if (commercantRoleId) roleIdToName.set(commercantRoleId, 'commercant');

  // Refait les requêtes utilisateurs avec les bons role_id.
  const roleIdsForMobile = [clientRoleId, livreurRoleId].filter(Boolean);
  const [
    mobileUsersRes,
    totalCommercantsRes,
    newMobileRes,
    commandesRes,
  ] = await Promise.all([
    roleIdsForMobile.length > 0
      ? db
          .from('utilisateurs')
          .select('id, role_id, est_actif, est_approuve, created_at')
          .in('role_id', roleIdsForMobile)
      : { data: [], error: null },
    commercantRoleId
      ? db
          .from('utilisateurs')
          .select('id, est_actif, est_approuve', { count: 'exact' })
          .eq('role_id', commercantRoleId)
      : { data: [], error: null, count: 0 },
    roleIdsForMobile.length > 0
      ? db
          .from('utilisateurs')
          .select('id, role_id, created_at')
          .in('role_id', roleIdsForMobile)
          .gte('created_at', newSince)
      : { data: [], error: null },
    db
      .from('commandes')
      .select('id, client_id, statut, adresse_livraison_snapshot, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(5000),
  ]);

  const mobileUsers = mobileUsersRes.data || [];
  const totalMobile = mobileUsers.length;
  const totalClients = mobileUsers.filter((u) => u.role_id === clientRoleId).length;
  const totalLivreurs = mobileUsers.filter((u) => u.role_id === livreurRoleId).length;
  const mobileActifs = mobileUsers.filter((u) => u.est_actif !== false).length;
  const mobileApprouves = mobileUsers.filter((u) => u.est_approuve !== false).length;

  const newMobileUsers = newMobileRes.data || [];
  const newMobileCount = newMobileUsers.length;
  const newClientsCount = newMobileUsers.filter((u) => u.role_id === clientRoleId).length;
  const newLivreursCount = newMobileUsers.filter((u) => u.role_id === livreurRoleId).length;

  // Activité API (proxy fiable pour l'usage mobile, dédupliqué par user_id).
  const reqRows7d = (reqRes7d.data || []).filter((r) => r.user_id);
  const reqRows30d = (reqRes30d.data || []).filter((r) => r.user_id);
  const distinctUsers7d = new Set(reqRows7d.map((r) => r.user_id));
  const distinctUsers30d = new Set(reqRows30d.map((r) => r.user_id));

  // Activité côté clients uniquement (commandes).
  const commandesRows = (commandesRes.data || []);
  const distinctClientsCommande = new Set(
    commandesRows.filter((c) => c.client_id).map((c) => c.client_id),
  );
  const commandesTotal = commandesRows.length;
  const commandesTerminees = commandesRows.filter((c) =>
    ['livree', 'partiellement_livree'].includes(c.statut),
  ).length;

  // Fréquence d'usage.
  const avgRequestsPerActiveUser30d = distinctUsers30d.size
    ? Math.round((reqRows30d.length / distinctUsers30d.size) * 10) / 10
    : 0;
  const avgOrdersPerActiveClient30d = distinctClientsCommande.size
    ? Math.round((commandesTotal / distinctClientsCommande.size) * 10) / 10
    : 0;

  // Livreurs actifs : on regarde s'ils ont fait au moins une action en 7j.
  const livreursActifsIds = new Set();
  for (const r of reqRows7d) {
    if (livreursActifsIds.has(r.user_id)) continue;
    // On ne peut pas savoir le rôle d'un user_id sans jointure, on les collecte
    // tous puis on filtre côté DB.
    livreursActifsIds.add(r.user_id);
  }
  // Filtre : on ne garde que les user_id qui sont des livreurs (rôle).
  let livreursActifs7d = 0;
  if (livreurRoleId && livreursActifsIds.size > 0) {
    const ids = [...livreursActifsIds];
    const { data: livreursRows } = await db
      .from('utilisateurs')
      .select('id')
      .eq('role_id', livreurRoleId)
      .in('id', ids);
    livreursActifs7d = (livreursRows || []).length;
  }

  // Top zones de livraison (par quartier du snapshot).
  const zoneCounts = new Map();
  for (const c of commandesRows) {
    const snap = c.adresse_livraison_snapshot;
    if (!snap) continue;
    let quartier = null;
    if (typeof snap === 'object' && snap !== null) {
      if (snap.quartier) {
        quartier = snap.quartier;
      } else if (snap.texte) {
        // Snapshots v1 : "Quartier Moungali, près de la station"
        quartier = String(snap.texte).split(',')[0].replace(/^quartier\s+/i, '').trim();
      }
    } else if (typeof snap === 'string') {
      quartier = snap.split(',')[0].replace(/^quartier\s+/i, '').trim();
    }
    const key = normalizeQuartier(quartier);
    if (!key) continue;
    const cur = zoneCounts.get(key) || { quartier: prettyQuartier(quartier), order_count: 0, delivery_count: 0 };
    cur.order_count += 1;
    // Pour le delivery_count on enchaînera une seconde requête par zone pour éviter
    // un JOIN énorme. Pour l'instant, on approxime avec order_count.
    zoneCounts.set(key, cur);
  }

  // Pour chaque zone top, on compte les livraisons distinctes.
  const topZoneCandidates = [...zoneCounts.values()]
    .sort((a, b) => b.order_count - a.order_count)
    .slice(0, topZonesLimit);
  const topQuartiers = topZoneCandidates.map((z) => z.quartier);
  if (topQuartiers.length > 0) {
    // Filtre Postgres ILIKE: on fait une requête par zone (top 8, raisonnable).
    await Promise.all(
      topQuartiers.map(async (q) => {
        const { count } = await db
          .from('livraisons')
          .select('id', { count: 'exact', head: true })
          .ilike('adresse_livraison_snapshot->>quartier', q)
          .gte('created_at', since);
        const cur = zoneCounts.get(normalizeQuartier(q));
        if (cur) cur.delivery_count = count || 0;
      }),
    );
  }

  const topZones = topZoneCandidates
    .sort((a, b) => b.order_count - a.order_count)
    .slice(0, topZonesLimit);

  // Croissance : comparatif N-1 (fenêtre précédente) sur les inscriptions clients.
  const previousSince = daysAgoIso(windowDays * 2);
  let previousNewMobileCount = 0;
  if (roleIdsForMobile.length > 0) {
    const { count } = await db
      .from('utilisateurs')
      .select('id', { count: 'exact', head: true })
      .in('role_id', roleIdsForMobile)
      .gte('created_at', previousSince)
      .lt('created_at', newSince);
    previousNewMobileCount = count || 0;
  }

  // ── Durée moyenne de session (dérivée de request_metrics) ──
  // Pour chaque user_id actif 30j, on calcule le delta entre la 1ère et la
  // dernière requête du jour. La "session" est approximée comme la plage
  // d'activité journalière (première → dernière requête).
  let avgSessionDurationMin = 0;
  let medianSessionDurationMin = 0;
  if (reqRows30d.length > 0) {
    const byUser = new Map();
    for (const r of reqRows30d) {
      if (!r.user_id) continue;
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
      byUser.get(r.user_id).push(r);
    }
    const sessionDurations = [];
    for (const rows of byUser.values()) {
      // On groupe par jour puis calcule la plage d'activité par jour.
      const byDay = new Map();
      for (const r of rows) {
        const day = new Date(r.created_at).toISOString().slice(0, 10);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(r);
      }
      for (const dayRows of byDay.values()) {
        if (dayRows.length < 2) continue; // 1 requête = pas de durée mesurable
        const times = dayRows.map((r) => new Date(r.created_at).getTime()).sort((a, b) => a - b);
        const durationMin = (times[times.length - 1] - times[0]) / 60_000;
        if (durationMin >= 0 && durationMin < 1440) sessionDurations.push(durationMin);
      }
    }
    if (sessionDurations.length > 0) {
      const sum = sessionDurations.reduce((s, d) => s + d, 0);
      avgSessionDurationMin = Math.round((sum / sessionDurations.length) * 10) / 10;
      sessionDurations.sort((a, b) => a - b);
      const mid = Math.floor(sessionDurations.length / 2);
      medianSessionDurationMin =
        sessionDurations.length % 2 === 0
          ? Math.round(((sessionDurations[mid - 1] + sessionDurations[mid]) / 2) * 10) / 10
          : Math.round(sessionDurations[mid] * 10) / 10;
    }
  }

  // ── Taux de conversion commande → livraison ──
  const commandesAnnulees = commandesRows.filter((c) =>
    ['annulee', 'refusee', 'remboursee'].includes(c.statut),
  ).length;
  const commandesEnCours = commandesRows.filter((c) =>
    ['en_attente', 'partiellement_acceptee', 'acceptee', 'en_preparation', 'prete', 'en_livraison'].includes(c.statut),
  ).length;
  const tauxLivraison = commandesTotal > 0
    ? Math.round((commandesTerminees / commandesTotal) * 1000) / 10
    : 0;
  const tauxAnnulation = commandesTotal > 0
    ? Math.round((commandesAnnulees / commandesTotal) * 1000) / 10
    : 0;

  // ── Délai moyen de livraison (commande créée → livrée) ──
  let avgDeliveryTimeMin = 0;
  const livrees = commandesRows.filter((c) =>
    ['livree', 'partiellement_livree'].includes(c.statut),
  );
  if (livrees.length > 0) {
    const livreeCmdIds = livrees.map((c) => c.id);
    const { data: livScIds } = await db.from('sous_commandes').select('id').in('commande_id', livreeCmdIds).limit(500);
    const scIds = (livScIds || []).map((r) => r.id);
    if (scIds.length > 0) {
      const { data: livRows } = await db
        .from('livraisons')
        .select('sous_commande_id, livree_at')
        .not('livree_at', 'is', null)
        .in('sous_commande_id', scIds);
      if (livRows && livRows.length > 0) {
        const { data: scMap } = await db.from('sous_commandes').select('id, commande_id').in('id', livRows.map((r) => r.sous_commande_id));
        const scToCmd = new Map((scMap || []).map((r) => [r.id, r.commande_id]));
        const cmdCreatedAt = new Map(commandesRows.map((c) => [c.id, new Date(c.created_at).getTime()]));
        const durations = [];
        for (const lr of livRows) {
          const cmdId = scToCmd.get(lr.sous_commande_id);
          const created = cmdCreatedAt.get(cmdId);
          const delivered = new Date(lr.livree_at).getTime();
          if (created && delivered && delivered > created) {
            durations.push((delivered - created) / 60_000);
          }
        }
        if (durations.length > 0) {
          avgDeliveryTimeMin = Math.round(durations.reduce((s, d) => s + d, 0) / durations.length);
        }
      }
    }
  }

  // ── Top commerces (par nombre de commandes dans la fenêtre) ──
  const commerceOrderCount = new Map();
  const { data: topScs } = await db
    .from('sous_commandes')
    .select('commande_id, restaurant_id, boutique_id')
    .in('commande_id', commandesRows.map((c) => c.id).slice(0, 2000));
  for (const sc of topScs || []) {
    const eid = sc.restaurant_id || sc.boutique_id;
    if (!eid) continue;
    commerceOrderCount.set(eid, (commerceOrderCount.get(eid) || 0) + 1);
  }
  const topCommerceIds = [...commerceOrderCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id]) => id);
  const topCommerces = [];
  if (topCommerceIds.length > 0) {
    const [restos, bouts] = await Promise.all([
      db.from('restaurants').select('id, nom').in('id', topCommerceIds),
      db.from('boutiques').select('id, nom').in('id', topCommerceIds),
    ]);
    const nameMap = new Map();
    for (const r of restos.data || []) nameMap.set(r.id, r.nom || 'Restaurant');
    for (const b of bouts.data || []) nameMap.set(b.id, b.nom || 'Boutique');
    for (const eid of topCommerceIds) {
      topCommerces.push({ id: eid, nom: nameMap.get(eid) || 'Commerce', commandes: commerceOrderCount.get(eid) || 0 });
    }
  }

  return {
    window_days: windowDays,
    generated_at: new Date().toISOString(),
    mobile_users: {
      total: totalMobile,
      total_clients: totalClients,
      total_livreurs: totalLivreurs,
      total_commercants: totalCommercantsRes.count || 0,
      actifs: mobileActifs,
      approuves: mobileApprouves,
      nouveaux_30j: newMobileCount,
      nouveaux_clients_30j: newClientsCount,
      nouveaux_livreurs_30j: newLivreursCount,
      croissance_30j_pct:
        previousNewMobileCount > 0
          ? Math.round(((newMobileCount - previousNewMobileCount) / previousNewMobileCount) * 1000) / 10
          : newMobileCount > 0
          ? 100
          : 0,
    },
    activite: {
      utilisateurs_actifs_7j: distinctUsers7d.size,
      utilisateurs_actifs_30j: distinctUsers30d.size,
      livreurs_actifs_7j: livreursActifs7d,
      requetes_30j: reqRows30d.length,
      commandes_30j: commandesTotal,
      commandes_livrees_30j: commandesTerminees,
      commandes_annulees_30j: commandesAnnulees,
      commandes_en_cours_30j: commandesEnCours,
      taux_livraison_30j: tauxLivraison,
      taux_annulation_30j: tauxAnnulation,
      moyenne_requetes_par_utilisateur_actif_30j: avgRequestsPerActiveUser30d,
      moyenne_commandes_par_client_actif_30j: avgOrdersPerActiveClient30d,
    },
    sessions: {
      duree_moyenne_min: avgSessionDurationMin,
      duree_mediane_min: medianSessionDurationMin,
    },
    livraison: {
      delai_moyen_min: avgDeliveryTimeMin,
    },
    top_commerces: topCommerces,
    top_zones_livraison: topZones.map((z) => ({
      quartier: z.quartier,
      commandes: z.order_count,
      livraisons: z.delivery_count,
    })),
  };
}

module.exports = {
  getUsageDashboard,
  MOBILE_USER_ROLES,
  startOfDayIso,
  daysAgoIso,
};
