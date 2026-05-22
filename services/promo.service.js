const { createHttpError } = require('../utils/http');

function normalizeCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

function isPromoActive(promo, now = new Date()) {
  if (!promo?.est_actif) return false;
  if (promo.date_debut && new Date(promo.date_debut) > now) return false;
  if (promo.date_fin && new Date(promo.date_fin) < now) return false;
  if (promo.limite_usage != null && Number(promo.nb_utilisation) >= Number(promo.limite_usage)) return false;
  return true;
}

function computeRemise(promo, eligibleSubtotal) {
  const sub = Math.max(0, Number(eligibleSubtotal) || 0);
  let remise = 0;
  const type = String(promo.type_remise || 'pourcentage').toLowerCase();
  const valeur = Number(promo.valeur) || 0;
  if (type === 'montant_fixe') {
    remise = Math.floor(valeur);
  } else {
    remise = Math.floor((sub * valeur) / 100);
  }
  return Math.min(remise, sub);
}

function segmentMatchesPromoScope(promo, segments) {
  if (!promo.restaurant_id && !promo.boutique_id) return true;
  for (const seg of segments || []) {
    const eid = seg.entrepriseId || seg.enterpriseId;
    const etype = seg.establishmentType || seg.establishment_type;
    if (promo.restaurant_id && etype === 'restaurant' && eid === promo.restaurant_id) return true;
    if (promo.boutique_id && etype === 'boutique' && eid === promo.boutique_id) return true;
  }
  return false;
}

/**
 * Valide un code promo sans l'enregistrer (panier / checkout).
 */
async function validatePromoCode(db, clientId, rawCode, { orderSubtotal, deliveryTotal = 0, segments = [] } = {}) {
  const code = normalizeCode(rawCode);
  if (!code || code.length < 3) {
    throw createHttpError(400, 'Code promo invalide.');
  }

  const { data: promo, error } = await db.from('codes_promo').select('*').eq('code', code).maybeSingle();
  if (error) throw error;
  if (!promo || !isPromoActive(promo)) {
    throw createHttpError(404, 'Ce code promo n’est pas valide ou a expiré.');
  }

  if (promo.par_utilisateur != null) {
    const { count, error: uErr } = await db
      .from('utilisations_code_promo')
      .select('id', { count: 'exact', head: true })
      .eq('code_promo_id', promo.id)
      .eq('utilisateur_id', clientId);
    if (uErr) throw uErr;
    if ((count || 0) >= Number(promo.par_utilisateur)) {
      throw createHttpError(400, 'Vous avez déjà utilisé ce code promo.');
    }
  }

  const eligibleSubtotal = Math.max(0, Number(orderSubtotal) || 0);
  const min = Number(promo.montant_min) || 0;
  if (eligibleSubtotal < min) {
    throw createHttpError(400, `Montant minimum ${min} FCFA requis pour ce code.`);
  }

  if (!segmentMatchesPromoScope(promo, segments)) {
    throw createHttpError(400, 'Ce code promo ne s’applique pas aux commerces de votre panier.');
  }

  const remise = computeRemise(promo, eligibleSubtotal);
  if (remise <= 0) {
    throw createHttpError(400, 'Ce code promo ne produit aucune réduction sur votre panier.');
  }

  const delivery = Math.max(0, Number(deliveryTotal) || 0);
  const total = Math.max(0, eligibleSubtotal + delivery - remise);

  return {
    code: promo.code,
    code_promo_id: promo.id,
    description: promo.description || null,
    type_remise: promo.type_remise,
    valeur: Number(promo.valeur),
    remise,
    order_subtotal: eligibleSubtotal,
    delivery_total: delivery,
    total,
  };
}

async function recordPromoUsage(db, { codePromoId, utilisateurId, commandeId, montantRemise }) {
  const { error: insErr } = await db.from('utilisations_code_promo').insert({
    code_promo_id: codePromoId,
    utilisateur_id: utilisateurId,
    commande_id: commandeId,
    montant_remise: montantRemise,
  });
  if (insErr) throw insErr;

  const { data: promo, error: pErr } = await db
    .from('codes_promo')
    .select('nb_utilisation')
    .eq('id', codePromoId)
    .maybeSingle();
  if (pErr) throw pErr;
  if (promo) {
    await db
      .from('codes_promo')
      .update({ nb_utilisation: Number(promo.nb_utilisation ?? 0) + 1 })
      .eq('id', codePromoId);
  }
}

module.exports = {
  normalizeCode,
  validatePromoCode,
  recordPromoUsage,
  computeRemise,
};
