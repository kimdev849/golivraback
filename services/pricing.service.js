/**
 * Tarification dynamique — aucun montant fixe en dur.
 * Config : parametres_systeme + variables d'environnement (override).
 */

const CONFIG_KEYS = [
  'platform_fee_percent',
  'merchant_percent',
  'delivery_platform_percent',
  'delivery_logistics_percent',
  'frais_livraison_base_fcfa',
  'frais_livraison_min_fcfa',
  'frais_livraison_max_fcfa',
  'payment_test_min_fcfa',
  'payment_test_max_fcfa',
];

const ENV_MAP = {
  platform_fee_percent: 'PLATFORM_FEE_PERCENT',
  merchant_percent: 'MERCHANT_PERCENT',
  delivery_platform_percent: 'DELIVERY_PLATFORM_PERCENT',
  delivery_logistics_percent: 'DELIVERY_LOGISTICS_PERCENT',
  frais_livraison_base_fcfa: 'FRAIS_LIVRAISON_BASE_FCFA',
  frais_livraison_min_fcfa: 'FRAIS_LIVRAISON_MIN_FCFA',
  frais_livraison_max_fcfa: 'FRAIS_LIVRAISON_MAX_FCFA',
  payment_test_min_fcfa: 'PAYMENT_TEST_MIN_FCFA',
  payment_test_max_fcfa: 'PAYMENT_TEST_MAX_FCFA',
};

const DEFAULTS = {
  /** GoLivra ne prélève rien sur les ventes — uniquement sur les frais de livraison. */
  platform_fee_percent: 0,
  merchant_percent: 100,
  delivery_platform_percent: 20,
  delivery_logistics_percent: 80,
  frais_livraison_base_fcfa: 500,
  frais_livraison_min_fcfa: 200,
  frais_livraison_max_fcfa: 500,
  payment_test_min_fcfa: 1000,
  payment_test_max_fcfa: 2000,
};

let cachedConfig = null;
let cacheExpiresAt = 0;
const CACHE_MS = 60_000;

function parseNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeConfig(raw) {
  const platform = parseNumber(raw.platform_fee_percent, DEFAULTS.platform_fee_percent);
  let merchant = parseNumber(raw.merchant_percent, DEFAULTS.merchant_percent);
  if (!raw.merchant_percent && raw.platform_fee_percent) {
    merchant = Math.max(0, 100 - platform);
  }

  const deliveryPlatform = parseNumber(
    raw.delivery_platform_percent,
    DEFAULTS.delivery_platform_percent,
  );
  let deliveryLogistics = parseNumber(
    raw.delivery_logistics_percent,
    DEFAULTS.delivery_logistics_percent,
  );
  if (!raw.delivery_logistics_percent && raw.delivery_platform_percent) {
    deliveryLogistics = Math.max(0, 100 - deliveryPlatform);
  }

  return {
    platform_fee_percent: platform,
    merchant_percent: merchant,
    delivery_platform_percent: deliveryPlatform,
    delivery_logistics_percent: deliveryLogistics,
    frais_livraison_base_fcfa: parseNumber(
      raw.frais_livraison_base_fcfa,
      DEFAULTS.frais_livraison_base_fcfa,
    ),
    frais_livraison_min_fcfa: parseNumber(raw.frais_livraison_min_fcfa, DEFAULTS.frais_livraison_min_fcfa),
    frais_livraison_max_fcfa: parseNumber(raw.frais_livraison_max_fcfa, DEFAULTS.frais_livraison_max_fcfa),
    payment_test_min_fcfa: parseNumber(raw.payment_test_min_fcfa, DEFAULTS.payment_test_min_fcfa),
    payment_test_max_fcfa: parseNumber(raw.payment_test_max_fcfa, DEFAULTS.payment_test_max_fcfa),
  };
}

async function loadParametresFromDb(db) {
  const { data, error } = await db.from('parametres_systeme').select('cle, valeur').in('cle', CONFIG_KEYS);
  if (error) throw error;
  const map = { ...DEFAULTS };
  for (const row of data || []) {
    if (row.cle && row.valeur != null) map[row.cle] = row.valeur;
  }
  return map;
}

function applyEnvOverrides(base) {
  const out = { ...base };
  for (const [key, envName] of Object.entries(ENV_MAP)) {
    if (process.env[envName] != null && String(process.env[envName]).trim() !== '') {
      out[key] = process.env[envName];
    }
  }
  return normalizeConfig(out);
}

/** Config tarifaire (cache 1 min). */
async function getPricingConfig(db) {
  const now = Date.now();
  if (cachedConfig && now < cacheExpiresAt) return cachedConfig;

  let base = { ...DEFAULTS };
  if (db) {
    try {
      base = await loadParametresFromDb(db);
    } catch {
      base = { ...DEFAULTS };
    }
  }
  cachedConfig = applyEnvOverrides(base);
  cacheExpiresAt = now + CACHE_MS;
  return cachedConfig;
}

function invalidatePricingCache() {
  cachedConfig = null;
  cacheExpiresAt = 0;
}

/**
 * Répartit un montant entre commerce et plateforme (ex. 80 % / 20 %).
 * @returns {{ merchant: number, platform: number, total: number }}
 */
function splitByPercent(total, merchantPercent, platformPercent) {
  const t = Number(total);
  if (!Number.isFinite(t) || t <= 0) {
    return { merchant: 0, platform: 0, total: 0 };
  }
  const mPct = Number(merchantPercent);
  const merchant = Math.round((t * mPct) / 100);
  const platform = Math.round(t - merchant);
  return { merchant, platform, total: t };
}

/** Répartition des frais de livraison (indépendant du paiement produits). */
function splitDeliveryFee(fraisLivraison, config) {
  const frais = Number(fraisLivraison);
  if (!Number.isFinite(frais) || frais <= 0) {
    return { logistics: 0, platform: 0, total: 0 };
  }
  const logistics = Math.round((frais * config.delivery_logistics_percent) / 100);
  const platform = Math.round(frais - logistics);
  return { logistics, platform, total: frais };
}

/** Frais de livraison : priorité au commerce, sinon paramètre système. */
async function resolveDeliveryFeeForEstablishment(db, establishmentRow) {
  const config = await getPricingConfig(db);
  const fromEst = Number(establishmentRow?.frais_livraison);
  if (Number.isFinite(fromEst) && fromEst > 0) {
    return Math.round(fromEst);
  }
  return Math.round(config.frais_livraison_base_fcfa);
}

/** Montant aléatoire DEV (test split) — uniquement si PAYMENT_TEST_RANDOMIZE=1. */
function randomTestPaymentAmount(config) {
  if (String(process.env.PAYMENT_TEST_RANDOMIZE || '') !== '1') return null;
  const min = Math.round(config.payment_test_min_fcfa);
  const max = Math.round(config.payment_test_max_fcfa);
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function getPublicPricingSnapshot(config) {
  return {
    platform_fee_percent: config.platform_fee_percent,
    merchant_percent: config.merchant_percent,
    delivery_platform_percent: config.delivery_platform_percent,
    delivery_logistics_percent: config.delivery_logistics_percent,
    frais_livraison_base_fcfa: config.frais_livraison_base_fcfa,
    frais_livraison_min_fcfa: config.frais_livraison_min_fcfa,
    frais_livraison_max_fcfa: config.frais_livraison_max_fcfa,
  };
}

module.exports = {
  getPricingConfig,
  invalidatePricingCache,
  splitByPercent,
  splitDeliveryFee,
  resolveDeliveryFeeForEstablishment,
  randomTestPaymentAmount,
  getPublicPricingSnapshot,
  DEFAULTS,
};
