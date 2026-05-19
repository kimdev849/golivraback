const { getDb } = require('../config/db');
const { createHttpError } = require('../utils/http');
const {
  listNotificationsForUser,
  countUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} = require('../services/notification.service');

async function listMine(req, res, next) {
  try {
    const db = getDb();
    const limit = Number(req.query.limit) || 50;
    const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';
    const items = await listNotificationsForUser(db, req.auth.userId, { limit, unreadOnly });
    const unread_count = await countUnreadNotifications(db, req.auth.userId);
    return res.json({ items, unread_count });
  } catch (error) {
    return next(error);
  }
}

async function unreadCount(req, res, next) {
  try {
    const db = getDb();
    const count = await countUnreadNotifications(db, req.auth.userId);
    return res.json({ unread_count: count });
  } catch (error) {
    return next(error);
  }
}

async function markRead(req, res, next) {
  try {
    const { notificationId } = req.params;
    const db = getDb();
    const row = await markNotificationRead(db, req.auth.userId, notificationId);
    if (!row) throw createHttpError(404, 'Notification introuvable.');
    return res.json({ ok: true, id: row.id, est_lue: row.est_lue });
  } catch (error) {
    return next(error);
  }
}

async function markAllRead(req, res, next) {
  try {
    const db = getDb();
    await markAllNotificationsRead(db, req.auth.userId);
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listMine,
  unreadCount,
  markRead,
  markAllRead,
};
