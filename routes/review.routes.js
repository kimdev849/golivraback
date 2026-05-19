const express = require('express');
const { listPendingReviews, submitReview } = require('../controllers/review.controller');
const { authMiddleware } = require('../middlewares/auth.middleware');
const { requireRoles } = require('../middlewares/role.middleware');

const router = express.Router();

router.get('/pending', authMiddleware, requireRoles(['client', 'admin']), listPendingReviews);
router.post('/', authMiddleware, requireRoles(['client', 'admin']), submitReview);

module.exports = router;
