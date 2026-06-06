const DEFAULT_PREFERENCES = {
  notif_push_enabled: true,
  notif_email_enabled: true,
  dark_mode: null,
  langue: 'fr',
};

function mergePreferences(raw) {
  const base = { ...DEFAULT_PREFERENCES };
  if (!raw || typeof raw !== 'object') return base;
  if (typeof raw.notif_push_enabled === 'boolean') base.notif_push_enabled = raw.notif_push_enabled;
  if (typeof raw.notif_email_enabled === 'boolean') base.notif_email_enabled = raw.notif_email_enabled;
  if (typeof raw.dark_mode === 'boolean' || raw.dark_mode === null) base.dark_mode = raw.dark_mode;
  if (typeof raw.langue === 'string' && raw.langue.length <= 10) base.langue = raw.langue;
  return base;
}

async function getPreferences(db, userId) {
  const { data, error } = await db
    .from('utilisateurs')
    .select('preferences_json')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    if (/preferences_json|column/i.test(error.message || '')) {
      return mergePreferences(null);
    }
    throw error;
  }

  return mergePreferences(data?.preferences_json);
}

async function updatePreferences(db, userId, patch) {
  const current = await getPreferences(db, userId);
  const next = mergePreferences({ ...current, ...patch });

  const { error } = await db
    .from('utilisateurs')
    .update({ preferences_json: next, updated_at: new Date().toISOString() })
    .eq('id', userId);

  if (error) {
    if (/preferences_json|column/i.test(error.message || '')) {
      const { createHttpError } = require('../utils/http');
      throw createHttpError(
        503,
        'Colonne preferences_json absente. Exécutez sql/amendments-features-v5.sql sur Supabase.',
      );
    }
    throw error;
  }

  return next;
}

module.exports = {
  DEFAULT_PREFERENCES,
  mergePreferences,
  getPreferences,
  updatePreferences,
};
