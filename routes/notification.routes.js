const express = require('express');
const {
  listMine,
  unreadCount,
  markRead,
  markAllRead,
  handleRegisterToken,
  handleUnregisterToken,
} = require('../controllers/notification.controller');
const { authMiddleware } = require('../middlewares/auth.middleware');

const router = express.Router();

// Lecture
router.get('/', authMiddleware, listMine);
router.get('/unread-count', authMiddleware, unreadCount);

// Marquer comme lue
router.patch('/read-all', authMiddleware, markAllRead);
router.patch('/:notificationId/read', authMiddleware, markRead);

// Tokens push
router.post('/register-token', authMiddleware, handleRegisterToken);
router.delete('/unregister-token', authMiddleware, handleUnregisterToken);

module.exports = router;
