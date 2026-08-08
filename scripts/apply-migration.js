/**
 * Applique un fichier SQL de migration (sql/*.sql) sur la base Supabase
 * via la fonction Postgres `exec_sql` (RPC) avec la clé serveur.
 *
 * Usage :
 *   cd golivraback
 *   node scripts/apply-migration.js sql/amendments-paiement-apres-acceptation.sql
 *   node scripts/apply-migration.js sql/amendments-account-deletion-and-engagement.sql
 *
 * Pré-requis : .env avec SUPABASE_URL + SUPABASE_SECRET_KEY (ou SUPABASE_SERVICE_KEY).
 * Idempotent : les fichiers SQL utilisent ADD COLUMN IF NOT EXISTS.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('❌ Usage : node scripts/apply-migration.js <fichier.sql>');
    process.exit(1);
  }
  const sqlFile = path.resolve(process.cwd(), target);
  if (!fs.existsSync(sqlFile)) {
    console.error(`❌ Fichier introuvable : ${sqlFile}`);
    process.exit(1);
  }

  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url || !key) {
    console.error('❌ SUPABASE_URL et SUPABASE_SECRET_KEY requis (fichier .env)');
    process.exit(1);
  }
  if (key.startsWith('sb_publishable_') || key.startsWith('eyJ')) {
    const role = key.startsWith('eyJ') ? decodeJwtRole(key) : '?';
    if (key.startsWith('sb_publishable_') || role === 'anon') {
      console.error('❌ Clé PUBLIQUE détectée (sb_publishable_… ou JWT anon). Utilisez la clé SECRÈTE (sb_secret_… ou service_role).');
      process.exit(1);
    }
  }

  const db = createClient(url, key, { auth: { persistSession: false } });
  const SQL = fs.readFileSync(sqlFile, 'utf8');
  console.log(`📦 Application de : ${target}`);
  console.log('   (via RPC exec_sql — la fonction est créée automatiquement si absente)\n');

  // 1) Tentative d'appliquer la fonction exec_sql (idempotente).
  await db.rpc('exec_sql', {
    query: `CREATE OR REPLACE FUNCTION exec_sql(query text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$ BEGIN EXECUTE query; END; $$;`,
  }).catch(() => {});

  // 2) Tentative : tout le fichier en un appel.
  const { error } = await db.rpc('exec_sql', { query: SQL });
  if (!error) {
    console.log('✅ Migration appliquée avec succès (bloc unique) !');
    return;
  }
  console.log(`⚠️  Bloc unique : ${(error.message || '').slice(0, 140)}`);
  console.log('   → Exécution instruction par instruction…\n');

  // 3) Fallback : chaque instruction séparément (évite un DO $$ multi-états qui échoue).
  const statements = SQL
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 5);
  let ok = 0;
  let fail = 0;
  for (const stmt of statements) {
    const { error: e } = await db.rpc('exec_sql', { query: `${stmt};` });
    if (e) {
      console.warn(`  ⚠️  ${(e.message || '').slice(0, 120)}`);
      fail++;
    } else {
      ok++;
    }
  }
  console.log(`\n✅ ${ok} instructions OK, ${fail} échec(s).`);
  if (fail > 0) {
    console.log('💡 Si des échecs subsistent (souvent des DO $$ / CREATE OR REPLACE FUNCTION),');
    console.log('   collez le fichier dans Supabase → SQL Editor → Run :');
    console.log('   ' + target);
    process.exitCode = 1;
  }
}

function decodeJwtRole(k) {
  try {
    const payload = k.split('.')[1];
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json).role || null;
  } catch {
    return null;
  }
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
