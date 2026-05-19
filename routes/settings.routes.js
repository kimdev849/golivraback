const express = require('express');
const { getPublic, listAdmin, updateAdmin } = require('../controllers/settings.controller');
const { authMiddleware } = require('../middlewares/auth.middleware');
const { requireRoles } = require('../middlewares/role.middleware');

const router = express.Router();
const adminOnly = [authMiddleware, requireRoles(['admin'])];

router.get('/public', getPublic);
router.get('/admin', ...adminOnly, listAdmin);
router.patch('/admin', ...adminOnly, updateAdmin);

module.exports = router;
