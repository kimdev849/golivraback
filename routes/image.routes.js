const express = require('express');
const { serveProductImage, serveEnterpriseImage } = require('../controllers/image.controller');

const router = express.Router();

// Public image endpoints — no auth required, cached 24h by browser.
// These serve bytea images stored in Supabase/Postgres as proper HTTP
// responses with correct content-type, so the web frontend can use them
// in <img> tags without needing data: URLs.
router.get('/products/:id', serveProductImage);
router.get('/enterprises/:id', serveEnterpriseImage);

module.exports = router;
