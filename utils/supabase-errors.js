/**
 * Messages lisibles pour erreurs Supabase / PostgreSQL (évite « Erreur lors de l'accès aux données »).
 */

const SCHEMA_COLUMN_CODES = new Set(['42703', 'PGRST204']);

function parseMissingColumn(error) {
  const raw = String(error?.message || '');
  const details = String(error?.details || error?.hint || '');
  const combined = `${raw} ${details}`;

  const pgrst = combined.match(/Could not find the ['"](\w+)['"] column of/i);
  if (pgrst) return pgrst[1];

  const pgQuoted = combined.match(/column ["'](\w+)["']/i);
  if (pgQuoted) return pgQuoted[1];

  return null;
}

function isMissingColumnError(error) {
  if (!error) return false;
  if (SCHEMA_COLUMN_CODES.has(String(error.code || ''))) return true;
  const msg = String(error.message || '').toLowerCase();
  return msg.includes('could not find') && msg.includes('column');
}

function normalizeSupabaseError(err) {
  if (!err || typeof err !== 'object') {
    return { status: 500, message: 'Erreur interne du serveur.', code: 'ERREUR' };
  }

  if (err.status || err.statusCode) {
    return {
      status: err.status || err.statusCode,
      message: err.message || 'Erreur',
      code: err.code || 'ERREUR',
    };
  }

  const code = String(err.code || '');
  const details = String(err.details || err.hint || '').trim();
  const raw = String(err.message || '').trim();

  if (code === 'PGRST116') {
    return {
      status: 409,
      message:
        'Données en double en base (plusieurs livraisons pour la même commande). Exécutez le script SQL de dédoublonnage puis réessayez.',
      code: 'DONNEES_DUPLICATES',
    };
  }

  if (isMissingColumnError(err)) {
    const col = parseMissingColumn(err);
    const cacheHint =
      ' Si le script SQL est déjà exécuté : Supabase → Project Settings → API → « Reload schema » (cache PostgREST), puis redéployez l’API Render.';
    return {
      status: 500,
      message: col
        ? `Colonne « ${col} » absente du cache API.${cacheHint}`
        : `Schéma base / cache API incomplet.${cacheHint}`,
      code: 'SCHEMA_INCOMPLET',
    };
  }

  if (code === '23505') {
    // Un doublon côté base. On NE FORCE PAS un message spécifique ici : le contrôleur métier
    // (auth, enterprise…) peut avoir déjà traduit l'erreur en message FR précis. Si l'erreur
    // arrive brute (sans `err.status`), on laisse le `raw` (souvent "duplicate key value
    // violates unique constraint \"…\"") plutôt que d'inventer un message métier hors contexte.
    return {
      status: 409,
      message: raw || details || 'Donnée déjà existante (contrainte d’unicité).',
      code: 'CONFLIT_DONNEES',
    };
  }

  if (code === '23503') {
    return { status: 400, message: 'Référence invalide en base.', code: 'REFERENCE_INVALIDE' };
  }

  if (code === '23514') {
    return {
      status: 400,
      message: 'Statut ou données invalides pour cette livraison.',
      code: 'CONTRAINTE_STATUT',
    };
  }

  if (code.startsWith('23')) {
    return {
      status: 400,
      message: details || raw || 'Les données ne respectent pas les contraintes de la base.',
      code: 'DONNEES_INVALIDES',
    };
  }

  return {
    status: 500,
    message: raw || details || 'Erreur lors de l’accès aux données.',
    code: 'ERREUR_BASE',
  };
}

module.exports = { normalizeSupabaseError, parseMissingColumn, isMissingColumnError };
