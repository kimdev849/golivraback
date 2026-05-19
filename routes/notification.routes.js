const express = require('express');
const {
  listMine,
  unreadCount,
  markRead,
  markAllRead,
} = require('../controllers/notification.controller');
const { authMiddleware } = require('../middlewares/auth.middleware');

const router = express.Router();

router.get('/', authMiddleware, listMine);
router.get('/unread-count', authMiddleware, unreadCount);
router.patch('/read-all', authMiddleware, markAllRead);
router.patch('/:notificationId/read', authMiddleware, markRead);

module.exports = router;
