/** Notifications in-app (table `notifications`). */

async function insertNotification(db, { utilisateurId, type, titre, corps, data }) {
  const { error } = await db.from('notifications').insert({
    utilisateur_id: utilisateurId,
    type: type || 'system',
    titre,
    corps: corps || null,
    data: data || null,
  });
  if (error) throw error;
}

/**
 * Prévient tous les livreurs disponibles (sans mission active) qu’une course est ouverte.
 */
async function notifyAvailableCouriersForDelivery(db, livraisonId) {
  const { listAvailableCouriers } = require('./dispatch.service');
  const couriers = await listAvailableCouriers(db);
  if (!couriers.length) return { notified: 0 };

  const userIds = [...new Set(couriers.map((c) => c.utilisateur_id).filter(Boolean))];
  if (!userIds.length) return { notified: 0 };

  const rows = userIds.map((utilisateurId) => ({
    utilisateur_id: utilisateurId,
    type: 'livraison_statut',
    titre: 'Nouvelle course disponible',
    corps: 'Une livraison vous attend. Ouvrez l’app livreur pour l’accepter.',
    data: { livraison_id: livraisonId, action: 'open_delivery' },
  }));

  const { error } = await db.from('notifications').insert(rows);
  if (error) throw error;
  return { notified: rows.length };
}

function mapNotificationRow(row) {
  return {
    id: row.id,
    type: row.type,
    titre: row.titre,
    corps: row.corps,
    data: row.data,
    est_lue: Boolean(row.est_lue),
    lue_at: row.lue_at,
    created_at: row.created_at,
  };
}

async function listNotificationsForUser(db, userId, { limit = 50, unreadOnly = false } = {}) {
  let q = db
    .from('notifications')
    .select('id, type, titre, corps, data, est_lue, lue_at, created_at')
    .eq('utilisateur_id', userId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Number(limit) || 50, 100));

  if (unreadOnly) {
    q = q.eq('est_lue', false);
  }

  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(mapNotificationRow);
}

async function countUnreadNotifications(db, userId) {
  const { count, error } = await db
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('utilisateur_id', userId)
    .eq('est_lue', false);
  if (error) throw error;
  return count || 0;
}

async function markNotificationRead(db, userId, notificationId) {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('notifications')
    .update({ est_lue: true, lue_at: now })
    .eq('id', notificationId)
    .eq('utilisateur_id', userId)
    .select('id, est_lue, lue_at')
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function markAllNotificationsRead(db, userId) {
  const now = new Date().toISOString();
  const { error } = await db
    .from('notifications')
    .update({ est_lue: true, lue_at: now })
    .eq('utilisateur_id', userId)
    .eq('est_lue', false);
  if (error) throw error;
}

async function notifyUserSafe(db, payload) {
  try {
    await insertNotification(db, payload);
  } catch (err) {
    console.warn('[notifications] insert failed:', err?.message || err);
  }
}

module.exports = {
  insertNotification,
  notifyAvailableCouriersForDelivery,
  listNotificationsForUser,
  countUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  notifyUserSafe,
  mapNotificationRow,
};
