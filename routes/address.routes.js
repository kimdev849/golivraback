const express = require('express');
const {
  listAddresses,
  createAddress,
  updateAddress,
  removeAddress,
  markPrincipal,
} = require('../controllers/address.controller');
const { authMiddleware } = require('../middlewares/auth.middleware');

const router = express.Router();

router.use(authMiddleware);

router.get('/', listAddresses);
router.post('/', createAddress);
router.patch('/:addressId', updateAddress);
router.delete('/:addressId', removeAddress);
router.post('/:addressId/principal', markPrincipal);

module.exports = router;
