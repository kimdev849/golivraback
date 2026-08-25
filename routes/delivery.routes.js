const express = require('express');
const { authMiddleware } = require('../middlewares/auth.middleware');
const { requireRoles } = require('../middlewares/role.middleware');
const { requireFeature } = require('../middlewares/feature-flag.middleware');
const {
  getDeliveryStatus,
  getDeliveryDetails,
  getCourierProfile,
  listCourierMissions,
  updateCourierAvailability,
  updateCourierPosition,
  acceptDelivery,
  advanceDelivery,
  completeDelivery,
} = require('../controllers/delivery.controller');
const { getAdminActiveTracking } = require('../controllers/tracking.controller');
const {
  createVendorExternalDelivery,
  listVendorExternalDeliveriesHandler,
  getExternalDeliveryPaymentStatusHandler,
} = require('../controllers/vendor-delivery.controller');

const { getDb } = require('../config/db');

/** Suivi public d'une livraison externe — pas d'auth requise. */
async function publicTrackExternalDelivery(req, res, next) {
  try {
    const { deliveryId } = req.params;
    const { telephone } = req.query; // ?telephone=+24206...
    const db = getDb();

    const { data: liv, error } = await db
      .from('livraisons')
      .select('id, statut, client_nom, client_telephone, created_at, livree_at, montant_total, restaurant_id, boutique_id')
      .eq('id', deliveryId)
      .eq('type_livraison', 'externe')
      .maybeSingle();
    if (error) throw error;
    if (!liv) return res.status(404).json({ message: 'Livraison introuvable.' });

    // Sécurité : seuls le créateur ou le destinataire (par téléphone) peuvent suivre.
    if (telephone && liv.client_telephone && telephone.replace(/\s/g, '') !== liv.client_telephone.replace(/\s/g, '')) {
      return res.status(403).json({ message: 'Accès non autorisé.' });
    }

    // Nom du commerce
    let commerceNom = '';
    if (liv.restaurant_id) {
      const { data: r } = await db.from('restaurants').select('nom').eq('id', liv.restaurant_id).maybeSingle();
      commerceNom = r?.nom || '';
    } else if (liv.boutique_id) {
      const { data: b } = await db.from('boutiques').select('nom').eq('id', liv.boutique_id).maybeSingle();
      commerceNom = b?.nom || '';
    }

    return res.json({
      id: liv.id,
      statut: liv.statut,
      client_nom: liv.client_nom,
      commerce_nom: commerceNom,
      montant_total: liv.montant_total,
      created_at: liv.created_at,
      livree_at: liv.livree_at,
    });
  } catch (err) {
    return next(err);
  }
}

const router = express.Router();

router.get('/status/:orderId', authMiddleware, getDeliveryStatus);
router.get('/tracking/active', authMiddleware, requireRoles(['admin']), getAdminActiveTracking);
// Suivi public d'une livraison externe par téléphone du destinataire (pas d'auth requise).
router.get('/track/:deliveryId', publicTrackExternalDelivery);
router.get('/:deliveryId/details', authMiddleware, getDeliveryDetails);
router.get(
  '/vendor/externe',
  authMiddleware,
  requireRoles(['restaurateur', 'commercant', 'admin']),
  listVendorExternalDeliveriesHandler,
);
router.post(
  '/vendor/externe',
  authMiddleware,
  requireRoles(['restaurateur', 'commercant', 'admin']),
  requireFeature('delivery'),
  createVendorExternalDelivery,
);
router.get(
  '/vendor/externe/:deliveryId/payment-status',
  authMiddleware,
  requireRoles(['restaurateur', 'commercant', 'admin']),
  getExternalDeliveryPaymentStatusHandler,
);
router.get('/courier/me', authMiddleware, requireRoles(['livreur', 'admin']), getCourierProfile);
router.get('/courier/missions', authMiddleware, requireRoles(['livreur', 'admin']), listCourierMissions);
router.patch('/courier/availability', authMiddleware, requireRoles(['livreur', 'admin']), updateCourierAvailability);
router.post('/courier/position', authMiddleware, requireRoles(['livreur', 'admin']), updateCourierPosition);
router.post('/courier/accept/:deliveryId', authMiddleware, requireRoles(['livreur', 'admin']), acceptDelivery);
router.post('/courier/advance/:deliveryId', authMiddleware, requireRoles(['livreur', 'admin']), advanceDelivery);
router.post('/courier/complete/:deliveryId', authMiddleware, requireRoles(['livreur', 'admin']), completeDelivery);

module.exports = router;
