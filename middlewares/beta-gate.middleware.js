const { getDb } = require('../config/db');
const { getAppControl } = require('../services/settings.service');
const { createHttpError } = require('../utils/http');

/**
 * Bêta fermée : si golivra_beta_mode est activé, seuls les téléphones listés
 * dans golivra_beta_phones peuvent se connecter / s'inscrire.
 * Applicable sur /api/auth/login, /api/auth/register, /api/auth/register-vendor.
 */
async function requireBetaAccess(req, res, next) {
  // getAppControl est tolérant (table absente → défauts). Filet, pas bloqueur.
  const db = getDb();
  const control = await getAppControl(db);

  // Kill switch / maintenance gérés par AppStatusGate côté mobile ; ici on
  // ne bloque que la bêta fermée (l'accès même à la connexion est restreint).
  if (!control.beta_mode) return next();

  const phone = String(
    req.body?.telephone || req.body?.phone || req.body?.payload?.telephone || ''
  )
    .trim()
    .replace(/\s+/g, '')
    .replace(/^\+/, '');

  if (!phone) {
    return next(createHttpError(403, 'Accès restreint : téléphone requis.'));
  }

  const allowed = (control.beta_phones || []).some(
    (p) => String(p).replace(/^\+/, '') === phone
  );

  if (!allowed) {
    return next(
      createHttpError(
        403,
        "Accès restreint : GoLivra est en test privé. Votre numéro n'est pas encore autorisé."
      )
    );
  }
  return next();
}

module.exports = { requireBetaAccess };
