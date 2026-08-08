/**
 * Migration : catégories globales GoLivra (categories_produits + categories_menus).
 *
 * Utilise le même mécanisme que run-migration.js / migrate-location.js :
 * la fonction Postgres `exec_sql` (à créer une fois dans Supabase SQL Editor
 * si elle n'existe pas encore — voir note en bas de fichier).
 *
 * Exécution :
 *   cd golivraback
 *   npm run migrate:categories
 *   (ou) node scripts/migrate-categories.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SQL_FILE = path.join(__dirname, '..', 'sql', 'amendments-categories-globales.sql');
const SQL = fs.readFileSync(SQL_FILE, 'utf8');

const EXEC_SQL_FUNCTION = `CREATE OR REPLACE FUNCTION exec_sql(query text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  EXECUTE query;
END;
$$;`;

async function main() {
  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url || !key) {
    console.error('❌ SUPABASE_URL et SUPABASE_SECRET_KEY requis (fichier .env)');
    process.exit(1);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  // 1) Tentative via RPC exec_sql (si la fonction existe déjà en base).
  const { error } = await db.rpc('exec_sql', { query: SQL });
  if (!error) {
    console.log('✅ Migration des catégories globales appliquée avec succès !');
    console.log('   Redémarrez ensuite le backend (npm run dev / npm start).');
    return;
  }

  // 2) exec_sql n'existe probablement pas : on la crée (si la clé le permet),
  //    puis on relance. Sinon on guide vers Supabase SQL Editor.
  console.log('⚠️  exec_sql indisponible :', (error.message || '').slice(0, 120));
  const created = await db.rpc('exec_sql', { query: EXEC_SQL_FUNCTION }).catch(() => null);
  if (!created || created.error) {
    console.log('');
    console.log('📋 Impossible de créer exec_sql via l’API.');
    console.log('   ➜ Option A : créez la fonction une fois dans Supabase → SQL Editor :');
    console.log('     ' + EXEC_SQL_FUNCTION.split('\n').join('\n     ').slice(0, 400));
    console.log('   ➜ Option B (recommandée si rapide) : ouvrez ce fichier dans Supabase → SQL Editor → Run :');
    console.log('     ' + SQL_FILE);
    console.log('');
    process.exit(2);
  }
  console.log('✅ exec_sql créée, relance de la migration…');
  const retry = await db.rpc('exec_sql', { query: SQL });
  if (retry.error) {
    console.error('❌ Migration échouée :', (retry.error.message || '').slice(0, 200));
    console.error('   Ouvrez le fichier ci-dessous dans Supabase → SQL Editor → Run :');
    console.error('   ' + SQL_FILE);
    process.exit(1);
  }
  console.log('✅ Migration des catégories globales appliquée avec succès !');
  console.log('   Redémarrez ensuite le backend (npm run dev / npm start).');
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
