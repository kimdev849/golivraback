const express = require('express');
const { getMine, replace, clear } = require('../controllers/cart.controller');
const { authMiddleware } = require('../middlewares/auth.middleware');
const { requireRoles } = require('../middlewares/role.middleware');

const router = express.Router();
const clientOnly = [authMiddleware, requireRoles(['client', 'admin'])];

router.get('/', ...clientOnly, getMine);
router.put('/', ...clientOnly, replace);
router.delete('/', ...clientOnly, clear);

module.exports = router;
