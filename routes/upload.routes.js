const express = require('express');
const { uploadBase64Image } = require('../controllers/upload.controller');
const { authMiddleware } = require('../middlewares/auth.middleware');
const { requireRoles } = require('../middlewares/role.middleware');

const router = express.Router();

const UPLOAD_ROLES = ['client', 'restaurateur', 'commercant', 'livreur', 'admin'];

router.post('/image', authMiddleware, requireRoles(UPLOAD_ROLES), uploadBase64Image);
router.post('/public-image', uploadBase64Image);

module.exports = router;
