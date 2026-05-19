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
];

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

module.exports = {
  ADMIN_SETTING_KEYS,
  listAdminSettings,
  updateAdminSettings,
  getPublicSettings,
};
