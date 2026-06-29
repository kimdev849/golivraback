const express = require('express');
const {
  getPays,
  getVilles,
  getArrondissements,
  getFullTree,
} = require('../controllers/location.controller');

const router = express.Router();

router.get('/pays', getPays);
router.get('/villes', getVilles);
router.get('/villes/:paysId', getVilles);
router.get('/arrondissements', getArrondissements);
router.get('/arrondissements/:villeId', getArrondissements);
router.get('/tree', getFullTree);

module.exports = router;
