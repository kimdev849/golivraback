const express = require('express');
const {
  listMine,
  add,
  remove,
  toggle,
  sync,
  listMineProducts,
  toggleProduct,
  removeProduct,
} = require('../controllers/favorites.controller');
const { authMiddleware } = require('../middlewares/auth.middleware');

const router = express.Router();
// Tout utilisateur authentifié (client, restaurateur, commercant, livreur, admin…)
// peut gérer ses favoris. Les rôles vendeurs sont également clients de l'app.
const anyAuth = [authMiddleware];

router.get('/', ...anyAuth, listMine);
router.post('/', ...anyAuth, add);
router.post('/toggle', ...anyAuth, toggle);
router.post('/sync', ...anyAuth, sync);
router.delete('/:enterpriseId', ...anyAuth, remove);

// Favoris PRODUITS (plats + articles). Endpoints scopes sous /products
// pour ne pas interferer avec les routes entreprises ci-dessus.
router.get('/products', ...anyAuth, listMineProducts);
router.post('/products/toggle', ...anyAuth, toggleProduct);
router.delete('/products/:productId', ...anyAuth, removeProduct);

module.exports = router;
