#!/usr/bin/env node
/**
 * Applique la migration RLS sur la VRAIE base Supabase.
 *
 * La migration (sql/rls-deny-by-default.sql) active RLS deny-by-default sur
 * les tables sensibles et retire ces tables de la publication Realtime.
 *
 * Prérequis :
 *   - DATABASE_URL (chaîne postgres://…) dans .env ou l'environnement.
 *     Supabase → Project Settings → Database → Connection string
 *     (utiliser le « Session pooler » pour un outil local, ou la connexion
 *     directe si le pooler pose problème).
 *   - Un BACKUP manuel doit avoir été déclenché avant (Dashboard → Database →
 *     Backups → Trigger a backup). Le script refuse de tourner sans --yes.
 *
 * Usage :
 *   node scripts/apply-rls.js --yes
 *
 * Le flag --yes est obligatoire : le script affiche d'abord ce qu'il va
 * exécuter et l'utilisateur doit confirmer explicitement.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const DATABASE_URL =
  process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PG_CONNECTION_STRING;

if (!DATABASE_URL) {
  console.error(
    '❌ DATABASE_URL manquant. Ajoutez-le au fichier .env local (gitignoré) :\n' +
      '   DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres\n' +
      '   (Supabase → Project Settings → Database → Connection string → Session pooler)',
  );
  process.exit(1);
}

if (!process.argv.includes('--yes')) {
  console.error(
    '⛔ Refus de tourner sans confirmation.\n' +
      '   Le script va exécuter sql/rls-deny-by-default.sql sur la base pointée par DATABASE_URL.\n' +
      '   1. Avez-vous déclenché un BACKUP manuel ? (Supabase → Database → Backups)\n' +
      '   2. Relancez avec : node scripts/apply-rls.js --yes',
  );
  process.exit(2);
}

async function main() {
  const file = path.join(__dirname, '..', 'sql', 'rls-deny-by-default.sql');
  const sql = fs.readFileSync(file, 'utf8');

  const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  console.log(`✅ Connecté à la base. Application de ${path.basename(file)}…\n`);

  try {
    const res = await client.query(sql);
    for (const result of res) {
      if (result.command) console.log(`   → ${result.command} (${result.rowCount ?? '-'} ligne(s))`);
    }
  } catch (err) {
    console.error('❌ Échec de la migration :', err.message);
    process.exit(3);
  } finally {
    await client.end();
  }

  console.log('\n✅ Migration appliquée. Vérifiez avec :');
  console.log('   node scripts/verify-rls.js');
}

main().catch((err) => {
  console.error('Erreur :', err.message);
  process.exit(1);
});
