const express = require('express');
const { authMiddleware } = require('../middlewares/auth.middleware');
const { requireRoles } = require('../middlewares/role.middleware');
const { validatePromo } = require('../controllers/promo.controller');

const router = express.Router();

router.post(
  '/validate',
  authMiddleware,
  requireRoles(['client', 'admin']),
  validatePromo,
);

module.exports = router;
