const { getDb } = require('../config/db');
const { getAppControl } = require('../services/settings.service');
const { createHttpError } = require('../utils/http');

const FLAG_TO_FIELD = {
  orders: 'orders_enabled',
  payments: 'payments_enabled',
  delivery: 'delivery_enabled',
};

const FEATURE_LABELS = {
  orders: 'les commandes',
  payments: 'les paiements',
  delivery: 'les livraisons',
};

/**
 * Bloque un endpoint si la fonctionnalité est désactivée par l'admin
 * (parametres_systeme → golivra_*_enabled). Utilisation :
 *   router.post('/', authMiddleware, requireFeature('orders'), createOrder);
 */
function requireFeature(feature) {
  const field = FLAG_TO_FIELD[feature];
  const label = FEATURE_LABELS[feature] || feature;
  if (!field) {
    throw new Error(`Feature inconnue: ${feature}`);
  }

  return async (req, res, next) => {
    // getAppControl est tolérant : table absente → défauts (tout activé).
    // Le contrôle total est un filet de sécurité, pas un bloqueur en cas de seed.
    const db = getDb();
    const control = await getAppControl(db);

    // Kill switch global : l'app entière est coupée.
    if (!control.app_enabled) {
      const err = createHttpError(503, 'GoLivra est temporairement indisponible. Réessayez plus tard.');
      err.business = true; // règle métier volontaire (admin) → pas un incident technique
      err.code = 'FEATURE_DISABLED';
      req._businessError = true;
      return next(err);
    }

    if (!control[field]) {
      const err = createHttpError(
        503,
        `L'option « ${label} » est temporairement désactivée par l'administrateur. Réessayez plus tard.`
      );
      err.business = true;
      err.code = 'FEATURE_DISABLED';
      req._businessError = true;
      return next(err);
    }

    return next();
  };
}

module.exports = { requireFeature };
