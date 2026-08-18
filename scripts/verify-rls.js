#!/usr/bin/env node
/**
 * Vérifie l'état RLS / Realtime sur la vraie base Supabase (lecture seule).
 *
 * Exécute sql/verify-rls.sql et affiche :
 *   1. Tables sensibles et leur état RLS (rowsecurity)
 *   2. Policies RLS existantes
 *   3. Tables encore dans la publication Realtime
 *   4. Privilèges anon/authenticated sur `commandes`
 *
 * À lancer AVANT et APRÈS scripts/apply-rls.js.
 *
 * Usage : node scripts/verify-rls.js
 * (nécessite DATABASE_URL dans .env — voir scripts/apply-rls.js)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const DATABASE_URL =
  process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PG_CONNECTION_STRING;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL manquant (voir scripts/apply-rls.js pour l’obtenir).');
  process.exit(1);
}

async function main() {
  const file = path.join(__dirname, '..', 'sql', 'verify-rls.sql');
  const sql = fs.readFileSync(file, 'utf8');

  const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    const res = await client.query(sql);
    res.forEach((result, i) => {
      const label = ['RLS par table', 'Policies existantes', 'Tables dans supabase_realtime', 'Privilèges anon sur commandes'][i] || `Requête ${i + 1}`;
      console.log(`\n── ${label} ──`);
      if (!result.rows.length) {
        console.log('   (aucun résultat)');
      } else {
        console.table(result.rows);
      }
    });
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Erreur :', err.message);
  process.exit(1);
});
