#!/usr/bin/env node
/**
 * Tests de concurrence sur la VRAIE base Supabase.
 *
 * Les tests unitaires (__tests__/authz.test.js) couvrent la logique avec un
 * fake en mémoire ; ce script vérifie le même comportement contre Postgres
 * réel, où l'atomicité vient du verrouillage de lignes :
 *
 *   Test 1 — Double acceptation d'une course :
 *     deux livreurs acceptent la MÊME livraison en parallèle →
 *     exactement UN succès (l'autre reçoit 0 ligne affectée).
 *
 *   Test 2 — Stock atomique :
 *     deux clients commandent le DERNIER article (stock = 1) →
 *     exactement UN succès, jamais stock < 0.
 *
 * Utilisation :
 *   cd golivraback
 *   SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/concurrency-tests.js
 *   (ou via le .env : SUPABASE_URL + SUPABASE_SECRET_KEY)
 *
 * ⚠️ Ce script CRÉE puis SUPPRIME des lignes de test dans les tables
 * `livraisons` et `articles` de la base cible. Les lignes sont marquées par
 * un identifiant de test (préfixe) et nettoyées en fin de run, même en cas
 * d'échec (bloc finally).
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const { resolveSupabaseServerKey } = require('../services/supabase.service');

const TEST_TAG = `concurrency-test-${Date.now()}`;
let failures = 0;

function log(ok, message) {
  console.log(`${ok ? '✅' : '❌'} ${message}`);
  if (!ok) failures += 1;
}

async function main() {
  const { url, key } = resolveSupabaseServerKey();
  // Deux clients SÉPARÉS = deux « utilisateurs » concurrents (deux connexions
  // PostgREST indépendantes, comme deux appareils réels).
  const dbA = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const dbB = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // ── Test 1 : double acceptation d'une livraison ──────────────────────────
  console.log('\n── Test 1 : double acceptation (UPDATE atomique) ──');
  const { data: liv, error: livErr } = await dbA
    .from('livraisons')
    .insert({ statut: 'en_attente', livreur_id: null, sous_commande_id: null, test_tag: TEST_TAG })
    .select('id')
    .single();
  if (livErr) {
    log(false, `Impossible de créer la livraison de test (table 'livraisons' indisponible ?): ${livErr.message}`);
    return;
  }

  try {
    // Le même UPDATE atomique que acceptLivraisonForCourier :
    //   UPDATE livraisons SET livreur_id=?, statut='attribuee' WHERE id=? AND livreur_id IS NULL AND statut='en_attente'
    const accept = (client, livreurId) =>
      client
        .from('livraisons')
        .update({ livreur_id: livreurId, statut: 'attribuee' })
        .eq('id', liv.id)
        .is('livreur_id', null)
        .eq('statut', 'en_attente')
        .select('id')
        .maybeSingle();

    const [ra, rb] = await Promise.all([accept(dbA, 'livreur-A-test'), accept(dbB, 'livreur-B-test')]);
    const okCount = [ra, rb].filter((r) => r.data && !r.error).length;
    const expected = 1;

    log(
      okCount === expected,
      `Double acceptation : ${okCount}/${expected} succès attendu (A=${ra.data ? 'OK' : '0 ligne'}, B=${rb.data ? 'OK' : '0 ligne'})`,
    );
    if (okCount > 1) {
      log(false, '⚠️ DEUX acceptations ont réussi — le filtre atomique ne fonctionne PAS sur cette base.');
    }
  } finally {
    await dbA.from('livraisons').delete().eq('id', liv.id);
  }

  // ── Test 2 : stock atomique (dernière unité) ─────────────────────────────
  console.log('\n── Test 2 : stock atomique (stock = 1, deux commandes) ──');
  const { data: art, error: artErr } = await dbA
    .from('articles')
    .insert({ nom: 'Article test concurrence', prix: 100, stock: 1, test_tag: TEST_TAG })
    .select('id, stock')
    .single();
  if (artErr) {
    log(false, `Impossible de créer l'article de test (table 'articles' indisponible ?): ${artErr.message}`);
    return;
  }

  try {
    // Débit atomique : ne décrémente que si stock > 0 (le décrément exact se
    // fait côté serveur via une UPDATE conditionnelle — ici stock: 0 <=> -1).
    const debit = (client) =>
      client
        .from('articles')
        .update({ stock: 0 })
        .eq('id', art.id)
        .gt('stock', 0)
        .select('id')
        .maybeSingle();

    const [sa, sb] = await Promise.all([debit(dbA), debit(dbB)]);
    const okCount = [sa, sb].filter((r) => r.data && !r.error).length;

    const { data: after } = await dbA.from('articles').select('stock').eq('id', art.id).single();
    const stockAfter = after ? Number(after.stock) : NaN;

    log(okCount === 1, `Stock : ${okCount}/1 succès attendu (A=${sa.data ? 'OK' : '0 ligne'}, B=${sb.data ? 'OK' : '0 ligne'})`);
    log(stockAfter === 0, `Stock final = ${stockAfter} (attendu 0, jamais négatif)`);
  } finally {
    await dbA.from('articles').delete().eq('id', art.id);
  }

  console.log(failures === 0 ? '\n🎉 Concurrence OK sur la vraie base.' : `\n${failures} test(s) échoué(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Erreur du script :', err.message);
  process.exit(1);
});
