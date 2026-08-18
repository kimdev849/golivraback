#!/usr/bin/env node
/**
 * E2E — Parcours LIVREUR sur une API GoLivra en mode test.
 *
 * Connexion → Missions disponibles → Acceptation → Récupération → Livraison → Confirmation
 *
 * Prérequis :
 *   1. Un compte livreur approuvé.
 *   2. Variables d'environnement :
 *        API_BASE_URL       (défaut : http://localhost:3001/api)
 *        E2E_COURIER_PHONE  (téléphone du compte livreur)
 *        E2E_COURIER_PASSWORD
 *        E2E_ACCEPT_RISK    ("yes" si API_BASE_URL n'est pas localhost)
 *
 * Usage :
 *   E2E_COURIER_PHONE=+242060000010 E2E_COURIER_PASSWORD='…' node scripts/e2e-courier.js
 *
 * Le script travaille sur la PREMIÈRE mission exploitable ; s'il n'y en a
 * aucune, il le signale et s'arrête proprement (exit 0).
 */

const API_BASE_URL = (process.env.API_BASE_URL || 'http://localhost:3001/api').replace(/\/$/, '');

const isLocal = /localhost|127\.0\.0\.1|::1/.test(API_BASE_URL);
if (!isLocal && process.env.E2E_ACCEPT_RISK !== 'yes') {
  console.error(`[E2E] Refus : API_BASE_URL="${API_BASE_URL}" n'est pas localhost (relancez avec E2E_ACCEPT_RISK=yes).`);
  process.exit(2);
}
if (!process.env.E2E_COURIER_PHONE || !process.env.E2E_COURIER_PASSWORD) {
  console.error('[E2E] Manque E2E_COURIER_PHONE et/ou E2E_COURIER_PASSWORD.');
  process.exit(2);
}

let okCount = 0;
let failCount = 0;
function ok(label) {
  okCount += 1;
  console.log(`  ✅ ${label}`);
}
function fail(label, detail) {
  failCount += 1;
  console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
}

async function api(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

async function main() {
  console.log(`\n=== E2E Parcours LIVREUR ===`);
  console.log(`API : ${API_BASE_URL}\n`);

  // 1. Connexion livreur ────────────────────────────────────────────────
  let r = await api('POST', '/auth/login', {
    body: { telephone: process.env.E2E_COURIER_PHONE, motDePasse: process.env.E2E_COURIER_PASSWORD },
  });
  if (r.status !== 200 || !r.data?.token) {
    return fail('Connexion livreur', `${r.status} ${JSON.stringify(r.data)}`);
  }
  const token = r.data.token;
  ok(`Connexion OK (${r.data.user?.role ?? '?'})`);

  // 2. Se rendre disponible ─────────────────────────────────────────────
  r = await api('PATCH', '/delivery/courier/availability', { token, body: { disponible: true } });
  if (r.status !== 200) {
    console.warn(`  ⚠️  Disponibilité (${r.status}) — non bloquant`);
  } else {
    ok('Livreur disponible');
  }

  // 3. Missions disponibles ─────────────────────────────────────────────
  r = await api('GET', '/delivery/courier/missions', { token });
  if (r.status !== 200) return fail('Liste missions', `${r.status} ${JSON.stringify(r.data)}`);
  const missions = Array.isArray(r.data) ? r.data : r.data?.missions || r.data?.data || [];
  ok(`Missions : ${missions.length}`);

  // Trouver une mission « en_attente » (à accepter) ou déjà attribuée
  let target = missions.find((m) => m.statut === 'en_attente' || m.statut === 'disponible');
  const own = missions.find((m) => m.statut === 'attribuee' || m.statut === 'en_collecte');
  if (!target && own) target = own;
  if (!target) {
    console.warn('  ⚠️  Aucune mission exploitable — étapes suivantes ignorées.');
    return finalize();
  }
  const deliveryId = target.id || target.livraison_id;
  ok(`Mission ${deliveryId} (statut: ${target.statut})`);

  // 4. Acceptation (si encore disponible) ───────────────────────────────
  if (target.statut === 'en_attente' || target.statut === 'disponible') {
    r = await api('POST', `/delivery/courier/accept/${deliveryId}`, { token });
    if (r.status !== 200) return fail('Acceptation mission', `${r.status} ${JSON.stringify(r.data)}`);
    ok('Mission acceptée');
  } else {
    console.log('  · mission déjà attribuée — acceptation ignorée');
  }

  // 5. Récupération (collecte) ──────────────────────────────────────────
  r = await api('POST', `/delivery/courier/advance/${deliveryId}`, { token });
  if (r.status !== 200) return fail('Récupération', `${r.status} ${JSON.stringify(r.data)}`);
  ok('Colis récupéré');

  // 6. Livraison (avancement suivant) ───────────────────────────────────
  r = await api('POST', `/delivery/courier/advance/${deliveryId}`, { token });
  if (r.status !== 200) return fail('Livraison en route', `${r.status} ${JSON.stringify(r.data)}`);
  ok('Livraison en route');

  // 7. Confirmation de livraison ────────────────────────────────────────
  r = await api('POST', `/delivery/courier/complete/${deliveryId}`, { token });
  if (r.status !== 200) return fail('Confirmation livraison', `${r.status} ${JSON.stringify(r.data)}`);
  ok('Livraison confirmée');

  finalize();
}

function finalize() {
  console.log(`\n=== Résultat : ${okCount} étapes OK, ${failCount} échec(s) ===`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n[E2E] Erreur fatale :', err.message);
  process.exit(1);
});
