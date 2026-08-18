#!/usr/bin/env node
/**
 * Purge des données expirées / orphelines (maintenance, cron-friendly).
 *
 * Supprime :
 *   1. OTP expirés            (tables `otp` / `otp_codes`)
 *   2. Sessions expirées      (table `sessions` — expires_at dépassé)
 *   3. Paniers abandonnés     (table `paniers` — expire_at dépassé)
 *   4. Positions livreurs     (table `livreur_positions` — plus de X minutes)
 *
 * Conforme RGPD (minimisation + limitation de conservation) : les données
 * temporaires ne sont pas conservées éternellement.
 *
 * Utilisation :
 *   SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/purge-expired.js
 *   (ou via le .env local)
 *
 * Cron suggéré (quotidien) :
 *   0 4 * * * cd /path/golivraback && SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/purge-expired.js >> /var/log/golivra-purge.log 2>&1
 *
 * Sortie : une ligne par table avec le nombre de lignes supprimées. Exit 0
 * même si une table est absente (best-effort, idempotent).
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { resolveSupabaseServerKey } = require('../services/supabase.service');

const POSITION_MAX_AGE_MIN = Number(process.env.PURGE_POSITIONS_OLDER_THAN_MIN || 30);

let failures = 0;
function log(ok, message) {
  console.log(`${ok ? '✅' : '➖'} ${message}`);
  if (!ok) failures += 1;
}

async function main() {
  const { url, key } = resolveSupabaseServerKey();
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const now = new Date().toISOString();

  console.log(`\n=== Purge des données expirées — ${now} ===`);

  // 1. OTP expirés (deux tables possibles selon la version de schéma)
  for (const table of ['otp', 'otp_codes']) {
    const col = table === 'otp' ? 'expire_at' : 'expire_le';
    const { count, error } = await db
      .from(table)
      .delete()
      .lt(col, now)
      .select('id', { count: 'exact', head: true });
    if (error) {
      log(false, `OTP ${table} : ${error.message}`);
    } else {
      log(true, `OTP expirés purgés (${table}) : ${count ?? 0}`);
    }
  }

  // 2. Sessions expirées
  const { count: sessions, error: sessErr } = await db
    .from('sessions')
    .delete()
    .lt('expires_at', now)
    .select('id', { count: 'exact', head: true });
  if (sessErr) log(false, `Sessions : ${sessErr.message}`);
  else log(true, `Sessions expirées purgées : ${sessions ?? 0}`);

  // 3. Paniers abandonnés (expire_at dépassé)
  const { count: paniers, error: cartErr } = await db
    .from('paniers')
    .delete()
    .lt('expire_at', now)
    .select('id', { count: 'exact', head: true });
  if (cartErr) log(false, `Paniers : ${cartErr.message}`);
  else log(true, `Paniers abandonnés purgés : ${paniers ?? 0}`);

  // 4. Positions livreurs trop anciennes (best-effort, table optionnelle)
  const cutoff = new Date(Date.now() - POSITION_MAX_AGE_MIN * 60_000).toISOString();
  for (const table of ['livreur_positions', 'positions_livreurs']) {
    const { count, error } = await db
      .from(table)
      .delete()
      .lt('created_at', cutoff)
      .select('id', { count: 'exact', head: true });
    if (error) {
      // Table absente = pas grave, on passe à la suivante
      continue;
    }
    log(true, `Positions livreurs anciennes purgées (${table}) : ${count ?? 0}`);
  }

  console.log(`\n=== Purge terminée (${failures} échec(s)) ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Erreur :', err.message);
  process.exit(1);
});
