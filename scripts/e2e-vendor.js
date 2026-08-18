#!/usr/bin/env node
/**
 * E2E — Parcours BOUTIQUE/MARCHAND sur une API GoLivra en mode test.
 *
 * Connexion → Commandes reçues → Acceptation → Préparation → Remise au livreur
 *
 * Prérequis :
 *   1. Un compte marchand (restaurateur/commercant) approuvé.
 *   2. Variables d'environnement :
 *        API_BASE_URL      (défaut : http://localhost:3001/api)
 *        E2E_VENDOR_PHONE  (téléphone du compte marchand)
 *        E2E_VENDOR_PASSWORD
 *        E2E_ACCEPT_RISK   ("yes" si API_BASE_URL n'est pas localhost)
 *
 * Usage :
 *   E2E_VENDOR_PHONE=+242060000001 E2E_VENDOR_PASSWORD='…' node scripts/e2e-vendor.js
 *
 * Le script travaille sur la PREMIÈRE commande trouvée dans un état exploitable ;
 * s'il n'y en a aucune, il le signale et s'arrête proprement (exit 0).
 */

const API_BASE_URL = (process.env.API_BASE_URL || 'http://localhost:3001/api').replace(/\/$/, '');

const isLocal = /localhost|127\.0\.0\.1|::1/.test(API_BASE_URL);
if (!isLocal && process.env.E2E_ACCEPT_RISK !== 'yes') {
  console.error(`[E2E] Refus : API_BASE_URL="${API_BASE_URL}" n'est pas localhost (relancez avec E2E_ACCEPT_RISK=yes).`);
  process.exit(2);
}
if (!process.env.E2E_VENDOR_PHONE || !process.env.E2E_VENDOR_PASSWORD) {
  console.error('[E2E] Manque E2E_VENDOR_PHONE et/ou E2E_VENDOR_PASSWORD.');
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
  console.log(`\n=== E2E Parcours BOUTIQUE ===`);
  console.log(`API : ${API_BASE_URL}\n`);

  // 1. Connexion marchand ───────────────────────────────────────────────
  let r = await api('POST', '/auth/login', {
    body: { telephone: process.env.E2E_VENDOR_PHONE, motDePasse: process.env.E2E_VENDOR_PASSWORD },
  });
  if (r.status !== 200 || !r.data?.token) {
    return fail('Connexion marchand', `${r.status} ${JSON.stringify(r.data)}`);
  }
  const token = r.data.token;
  ok(`Connexion OK (${r.data.user?.role ?? '?'})`);

  // 2. Commandes reçues ─────────────────────────────────────────────────
  r = await api('GET', '/orders/vendor/mine', { token });
  if (r.status !== 200) return fail('Liste commandes reçues', `${r.status} ${JSON.stringify(r.data)}`);
  const orders = Array.isArray(r.data) ? r.data : r.data?.orders || r.data?.data || [];
  ok(`Commandes reçues : ${orders.length}`);

  // Trouver la première commande exploitable (sous-commande en attente)
  let target = null;
  for (const order of orders) {
    const sous = order.sous_commandes || [];
    const sc = sous.find((s) => s.statut === 'en_attente');
    if (sc) {
      target = { orderId: order.id, sousCommandeId: sc.id };
      break;
    }
  }
  if (!target) {
    console.warn('  ⚠️  Aucune commande en attente d’acceptation — étapes suivantes ignorées.');
    return finalize();
  }
  ok(`Commande ${target.orderId} (sous-commande ${target.sousCommandeId}) en attente`);

  // 3. Acceptation ──────────────────────────────────────────────────────
  r = await api('PATCH', `/orders/${target.orderId}/status`, {
    token,
    body: { statut: 'acceptee', sousCommandeId: target.sousCommandeId },
  });
  if (r.status !== 200) return fail('Acceptation', `${r.status} ${JSON.stringify(r.data)}`);
  ok('Commande acceptée');

  // 4. Préparation ──────────────────────────────────────────────────────
  r = await api('PATCH', `/orders/${target.orderId}/status`, {
    token,
    body: { statut: 'en_preparation', sousCommandeId: target.sousCommandeId },
  });
  if (r.status !== 200) return fail('Préparation', `${r.status} ${JSON.stringify(r.data)}`);
  ok('Préparation démarrée');

  // 5. Remise au livreur ────────────────────────────────────────────────
  r = await api('PATCH', `/orders/${target.orderId}/status`, {
    token,
    body: { statut: 'pret', sousCommandeId: target.sousCommandeId },
  });
  if (r.status !== 200) return fail('Remise au livreur', `${r.status} ${JSON.stringify(r.data)}`);
  ok('Commande prête, remise au livreur');

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
