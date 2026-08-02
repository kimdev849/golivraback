const express = require('express');
const { getMine, replace, clear } = require('../controllers/cart.controller');
const { authMiddleware } = require('../middlewares/auth.middleware');

const router = express.Router();
// Tout utilisateur authentifié peut avoir un panier (les vendeurs sont aussi
// clients de l'app). La restriction client-only générait des 403 en masse.
const anyAuth = [authMiddleware];

router.get('/', ...anyAuth, getMine);
router.put('/', ...anyAuth, replace);
router.delete('/', ...anyAuth, clear);

module.exports = router;
