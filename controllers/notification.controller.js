const { getDb } = require('../config/db');
const { createHttpError } = require('../utils/http');
const {
  listNotificationsForUser,
  countUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} = require('../services/notification.service');
const {
  registerToken,
  unregisterToken,
} = require('../services/push.service');

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

/**
 * POST /api/notifications/register-token
 * Body : { expoPushToken: string, platform: 'ios' | 'android' | 'web' }
 */
async function handleRegisterToken(req, res, next) {
  try {
    const { expoPushToken, platform } = req.body;

    if (!expoPushToken || typeof expoPushToken !== 'string') {
      throw createHttpError(400, 'expoPushToken manquant ou invalide.');
    }

    const validPlatforms = ['ios', 'android', 'web'];
    const normalizedPlatform = typeof platform === 'string' && validPlatforms.includes(platform)
      ? platform
      : 'android';

    const db = getDb();
    await registerToken(db, req.auth.userId, expoPushToken.trim(), normalizedPlatform);

    return res.json({ ok: true, token: expoPushToken.trim(), platform: normalizedPlatform });
  } catch (error) {
    return next(error);
  }
}

/**
 * DELETE /api/notifications/unregister-token
 * Body : { expoPushToken: string }
 */
async function handleUnregisterToken(req, res, next) {
  try {
    const { expoPushToken } = req.body;

    if (!expoPushToken || typeof expoPushToken !== 'string') {
      throw createHttpError(400, 'expoPushToken manquant.');
    }

    const db = getDb();
    await unregisterToken(db, req.auth.userId, expoPushToken.trim());

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
  handleRegisterToken,
  handleUnregisterToken,
};
