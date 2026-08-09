const { createHttpError } = require('../utils/http');

const ADMIN_SETTING_KEYS = [
  'platform_fee_percent',
  'merchant_percent',
  'delivery_platform_percent',
  'delivery_logistics_percent',
  'frais_livraison_base_fcfa',
  'frais_livraison_min_fcfa',
  'frais_livraison_max_fcfa',
  'rayon_livraison_defaut_km',
  'golivra_platform_name',
  'golivra_support_email',
  'golivra_maintenance_mode',
  'golivra_signups_open',
  'golivra_email_notifications',
  'golivra_sms_notifications',
  'commission_marketplace_defaut_pct',
  'montant_min_commande_fcfa',
  // ── Contrôle total de l'application (feature flags) ──────────────
  'golivra_app_enabled',
  'golivra_min_app_version',
  'golivra_beta_mode',
  'golivra_beta_phones',
  'golivra_orders_enabled',
  'golivra_payments_enabled',
  'golivra_delivery_enabled',
  'golivra_announcement',
];

/** Valeurs par défaut du contrôle d'application (si la clé manque en base). */
const APP_CONTROL_DEFAULTS = {
  golivra_app_enabled: true,
  golivra_maintenance_mode: false,
  golivra_min_app_version: '1.0.0',
  golivra_beta_mode: false,
  golivra_beta_phones: '',
  golivra_orders_enabled: true,
  golivra_payments_enabled: true,
  golivra_delivery_enabled: true,
  golivra_signups_open: true,
  golivra_announcement: '',
};

function parseParamValue(row) {
  const raw = row.valeur;
  if (row.type === 'boolean') {
    return raw === true || raw === 'true' || raw === '1';
  }
  if (row.type === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  return String(raw ?? '');
}

function serializeParamValue(value, type) {
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') return String(Number(value));
  return String(value ?? '');
}

async function listAdminSettings(db) {
  const { data, error } = await db
    .from('parametres_systeme')
    .select('cle, valeur, type, description, est_public, updated_at')
    .in('cle', ADMIN_SETTING_KEYS)
    .order('cle');
  if (error) throw error;

  const settings = {};
  for (const row of data || []) {
    settings[row.cle] = {
      valeur: parseParamValue(row),
      type: row.type,
      description: row.description,
      est_public: row.est_public,
      updated_at: row.updated_at,
    };
  }
  return settings;
}

async function updateAdminSettings(db, updates, adminUserId) {
  if (!updates || typeof updates !== 'object') {
    throw createHttpError(400, 'Aucun paramètre à mettre à jour.');
  }

  const keys = Object.keys(updates).filter((k) => ADMIN_SETTING_KEYS.includes(k));
  if (keys.length === 0) {
    throw createHttpError(400, 'Clés de paramètres non reconnues.');
  }

  const { data: existing, error: loadErr } = await db
    .from('parametres_systeme')
    .select('cle, type')
    .in('cle', keys);
  if (loadErr) throw loadErr;

  const typeMap = new Map((existing || []).map((r) => [r.cle, r.type]));

  for (const cle of keys) {
    const type = typeMap.get(cle) || (typeof updates[cle] === 'boolean' ? 'boolean' : 'string');
    const valeur = serializeParamValue(updates[cle], type);
    const { error } = await db
      .from('parametres_systeme')
      .update({
        valeur,
        updated_at: new Date().toISOString(),
        updated_par: adminUserId || null,
      })
      .eq('cle', cle);
    if (error) throw error;
  }

  const { invalidatePricingCache } = require('./pricing.service');
  if (typeof invalidatePricingCache === 'function') {
    invalidatePricingCache();
  }

  return listAdminSettings(db);
}

async function getPublicSettings(db) {
  const { data, error } = await db
    .from('parametres_systeme')
    .select('cle, valeur, type')
    .eq('est_public', true);
  if (error) throw error;

  const out = {};
  for (const row of data || []) {
    out[row.cle] = parseParamValue(row);
  }
  return out;
}

/**
 * Statut public structuré de l'application (consommé par le mobile et le
 * middleware de garde). Retourne toujours des valeurs cohérentes, même si
 * la table parametres_systeme est absente ou vide (base pas encore seedée).
 */
async function getAppControl(db) {
  let rows = [];
  try {
    const { data, error } = await db
      .from('parametres_systeme')
      .select('cle, valeur, type')
      .in('cle', Object.keys(APP_CONTROL_DEFAULTS));
    if (!error) rows = data || [];
  } catch {
    rows = [];
  }

  const map = new Map(rows.map((r) => [r.cle, r]));
  const out = {};
  for (const [cle, def] of Object.entries(APP_CONTROL_DEFAULTS)) {
    const row = map.get(cle);
    if (!row) {
      out[cle] = def;
      continue;
    }
    const raw = row.valeur;
    if (typeof def === 'boolean') {
      out[cle] = raw === true || raw === 'true' || raw === '1';
    } else if (typeof def === 'number') {
      const n = Number(raw);
      out[cle] = Number.isFinite(n) ? n : def;
    } else {
      out[cle] = String(raw ?? def);
    }
  }

  // Bêta fermée : liste de téléphones autorisés (séparés par virgules).
  const betaPhones = String(out.golivra_beta_phones || '')
    .split(',')
    .map((p) => p.trim().replace(/^\+/, ''))
    .filter(Boolean);

  return {
    app_enabled: Boolean(out.golivra_app_enabled),
    maintenance_mode: Boolean(out.golivra_maintenance_mode),
    min_app_version: String(out.golivra_min_app_version || '1.0.0'),
    beta_mode: Boolean(out.golivra_beta_mode),
    beta_phones: betaPhones,
    orders_enabled: Boolean(out.golivra_orders_enabled),
    payments_enabled: Boolean(out.golivra_payments_enabled),
    delivery_enabled: Boolean(out.golivra_delivery_enabled),
    signups_open: Boolean(out.golivra_signups_open),
    announcement: String(out.golivra_announcement || ''),
  };
}

module.exports = {
  ADMIN_SETTING_KEYS,
  listAdminSettings,
  updateAdminSettings,
  getPublicSettings,
  getAppControl,
};
