const { createClient } = require('@supabase/supabase-js');

function decodeJwtRole(key) {
  if (!key.startsWith('eyJ')) return null;
  try {
    const payload = key.split('.')[1];
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const data = JSON.parse(json);
    return data.role || null;
  } catch {
    return null;
  }
}

/**
 * Vérifie que la clé serveur n'est pas une clé publique (anon / publishable).
 * Erreur fréquente : permission denied for schema public
 */
function assertServerSecretKey(key, envName) {
  const trimmed = (key || '').trim();
  if (!trimmed) return;

  if (trimmed.startsWith('sb_publishable_')) {
    throw new Error(
      `${envName} contient une clé PUBLIQUE (sb_publishable_…). ` +
        'Le backend GoLivra doit utiliser la clé SECRÈTE serveur : Supabase → Project Settings → API → ' +
        '« Secret keys » (sb_secret_…) ou l’ancien JWT « service_role ». Ne jamais mettre la clé publishable côté Render.',
    );
  }

  const jwtRole = decodeJwtRole(trimmed);
  if (jwtRole === 'anon') {
    throw new Error(
      `${envName} contient un JWT « anon ». Utilisez le JWT « service_role » (clé secrète) depuis Supabase → Settings → API.`,
    );
  }
}

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    throw new Error(
      'Configuration Supabase manquante (définissez SUPABASE_URL et SUPABASE_SECRET_KEY ou SUPABASE_SERVICE_KEY).',
    );
  }

  assertServerSecretKey(key, 'SUPABASE_SECRET_KEY');

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

module.exports = {
  getSupabaseClient,
  assertServerSecretKey,
};
