const express = require('express');
const {
  listMine,
  add,
  remove,
  toggle,
  sync,
} = require('../controllers/favorites.controller');
const { authMiddleware } = require('../middlewares/auth.middleware');
const { requireRoles } = require('../middlewares/role.middleware');

const router = express.Router();
const clientOnly = [authMiddleware, requireRoles(['client', 'admin'])];

router.get('/', ...clientOnly, listMine);
router.post('/', ...clientOnly, add);
router.post('/toggle', ...clientOnly, toggle);
router.post('/sync', ...clientOnly, sync);
router.delete('/:enterpriseId', ...clientOnly, remove);

module.exports = router;
