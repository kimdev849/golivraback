#!/usr/bin/env node
/**
 * E2E — Parcours CLIENT complet sur une API GoLivra en mode test.
 *
 * Inscription → OTP → Connexion → Boutiques → Produits → Panier →
 * Commande → Paiement → Suivi → Historique
 *
 * Prérequis :
 *   1. Un serveur GoLivra qui tourne avec OTP_TEST_MODE=1 (le code OTP est
 *      renvoyé dans la réponse) et PAYMENT_MODE=test (paiement simulé).
 *   2. Variables d'environnement :
 *        API_BASE_URL    (défaut : http://localhost:3001/api)
 *        E2E_PHONE       (optionnel, numéro de test ; sinon généré unique)
 *        E2E_ACCEPT_RISK (doit être "yes" si API_BASE_URL n'est pas localhost)
 *
 * Usage :
 *   node scripts/e2e-client.js
 *
 * Le script utilise des numéros de téléphone de test (+242 06 0X XX XX XX
 * selon la liste de test du validateur) et n'envoie aucun SMS réel si le
 * serveur est bien en OTP_TEST_MODE.
 */

const API_BASE_URL = (process.env.API_BASE_URL || 'http://localhost:3001/api').replace(/\/$/, '');

// ── Garde anti-production ──────────────────────────────────────────────
const isLocal = /localhost|127\.0\.0\.1|::1/.test(API_BASE_URL);
if (!isLocal && process.env.E2E_ACCEPT_RISK !== 'yes') {
  console.error(
    `[E2E] Refus : API_BASE_URL="${API_BASE_URL}" n'est pas localhost.\n` +
      `Ce script crée de vraies commandes (test) et consomme du quota OTP/paiement.\n` +
      `Si vous voulez vraiment l'exécuter contre cette URL, relancez avec E2E_ACCEPT_RISK=yes.`,
  );
  process.exit(2);
}

const TEST_PHONES = [
  '+242060000001', '+242060000002', '+242060000003', '+242060000004', '+242060000005',
];

let stepPassed = 0;
let stepFailed = 0;

function ok(label) {
  stepPassed += 1;
  console.log(`  ✅ ${label}`);
}
function fail(label, detail) {
  stepFailed += 1;
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

function pickTestPhone() {
  const last = TEST_PHONES[TEST_PHONES.length - 1];
  const n = Number(last.slice(-9)) + 1;
  return `${last.slice(0, -9)}${String(n).padStart(9, '0')}`;
}

async function main() {
  const phone = process.env.E2E_PHONE || pickTestPhone();
  const nom = `E2E Client ${Date.now() % 100000}`;
  const motDePasse = 'GoLivra#2026';
  console.log(`\n=== E2E Parcours CLIENT ===`);
  console.log(`API  : ${API_BASE_URL}`);
  console.log(`Tél  : ${phone}\n`);

  // 1. Inscription avec OTP (mode test) ────────────────────────────────
  let r = await api('POST', '/otp/request', { body: { telephone: phone } });
  if (r.status !== 200) return fail('OTP /request', `${r.status} ${JSON.stringify(r.data)}`);
  const otpCode = r.data?.otpCode || r.data?.code;
  if (!otpCode) {
    return fail(
      'OTP /request',
      'pas de code en mode test — le serveur tourne-t-il avec OTP_TEST_MODE=1 ? ' + JSON.stringify(r.data),
    );
  }
  ok('OTP demandé (mode test, code reçu)');

  r = await api('POST', '/otp/verify', { body: { telephone: phone, code: String(otpCode) } });
  if (r.status !== 200 || r.data?.verified !== true) {
    return fail('OTP /verify', `${r.status} ${JSON.stringify(r.data)}`);
  }
  ok('OTP vérifié');

  r = await api('POST', '/auth/register', {
    body: { nom, telephone: phone, motDePasse, otpCode: String(otpCode), role: 'client' },
  });
  if (r.status !== 201 || !r.data?.token) {
    return fail('Inscription', `${r.status} ${JSON.stringify(r.data)}`);
  }
  const token = r.data.token;
  const userId = r.data.user?.id;
  ok(`Inscription OK (user ${userId})`);

  // 2. Connexion ───────────────────────────────────────────────────────
  r = await api('POST', '/auth/login', { body: { telephone: phone, motDePasse } });
  if (r.status !== 200 || !r.data?.token) {
    return fail('Connexion', `${r.status} ${JSON.stringify(r.data)}`);
  }
  ok('Connexion OK');

  // 3. Voir les boutiques (feed) ───────────────────────────────────────
  r = await api('GET', '/products/feed', { token });
  if (r.status !== 200) return fail('Feed boutiques', `${r.status} ${JSON.stringify(r.data)}`);
  ok('Feed boutiques chargé');

  // 4. Trouver un commerce ouvert avec un produit commandable ─────────
  r = await api('GET', '/enterprises', { token });
  if (r.status !== 200) return fail('Liste entreprises', `${r.status} ${JSON.stringify(r.data)}`);
  const enterprises = Array.isArray(r.data) ? r.data : r.data?.enterprises || r.data?.data || [];
  ok(`Liste entreprises (${enterprises.length})`);

  let chosen = null;
  for (const ent of enterprises) {
    if (ent.statut !== 'active' || ent.est_ouvert !== true) continue;
    const type = ent.type === 'restaurant' || ent.type === 'restaurateur' ? 'restaurant' : 'boutique';
    const pr = await api('GET', `/products/enterprise/${ent.id}`, { token });
    if (pr.status !== 200) continue;
    const products = Array.isArray(pr.data) ? pr.data : pr.data?.products || pr.data?.data || [];
    const avail = products.find(
      (p) =>
        p.est_disponible === true &&
        (p.stock === null || p.stock === undefined || Number(p.stock) > 0),
    );
    if (avail) {
      chosen = { ent, type, product: avail };
      break;
    }
  }
  if (!chosen) {
    console.warn('  ⚠️  Aucun commerce ouvert avec produit commandable en base — étapes panier/commande/paiement ignorées.');
    return finalize();
  }
  const { ent, type, product } = chosen;
  ok(`Boutique « ${ent.nom} » (${type}) ouverte — produit « ${product.nom} »`);

  // 5. Panier ──────────────────────────────────────────────────────────
  const segment = {
    entrepriseId: ent.id,
    establishmentType: type,
    articles: [{ itemId: product.id, quantite: 1 }],
  };
  r = await api('PUT', '/cart', { token, body: { segments: [segment] } });
  if (r.status !== 200) return fail('Panier', `${r.status} ${JSON.stringify(r.data)}`);
  ok('Article ajouté au panier');

  // 6. Commande ────────────────────────────────────────────────────────
  r = await api('POST', '/orders', {
    token,
    body: {
      methodePaiement: 'airtel_money',
      adresseLivraison: 'Quartier E2E, Avenue de test, immeuble 1',
      segments: [segment],
    },
  });
  if (r.status !== 201 || !r.data?.id) {
    return fail('Création commande', `${r.status} ${JSON.stringify(r.data)}`);
  }
  const orderId = r.data.id;
  ok(`Commande créée (${orderId})`);

  // 7. Paiement (simulé en mode test) ──────────────────────────────────
  r = await api('POST', `/orders/${orderId}/pay`, {
    token,
    body: { methodePaiement: 'airtel_money', numero_compte: phone.replace('+24206', '06') },
  });
  if (r.status !== 200) return fail('Paiement', `${r.status} ${JSON.stringify(r.data)}`);
  const payStatut = r.data?.paiement?.statut || r.data?.deja_valide;
  ok(`Paiement initié (statut: ${payStatut ?? 'ok'}, test_mode: ${r.data?.test_mode})`);

  // 8. Suivi commande ──────────────────────────────────────────────────
  r = await api('GET', `/orders/${orderId}`, { token });
  if (r.status !== 200) return fail('Suivi commande', `${r.status} ${JSON.stringify(r.data)}`);
  ok(`Suivi commande (statut: ${r.data?.statut ?? '?'})`);

  r = await api('GET', `/delivery/status/${orderId}`, { token });
  if (r.status !== 200) {
    console.warn(`  ⚠️  Suivi livraison indisponible (${r.status}) — étape non bloquante.`);
  } else {
    ok('Suivi livraison consulté');
  }

  // 9. Historique ──────────────────────────────────────────────────────
  r = await api('GET', '/orders', { token });
  if (r.status !== 200) return fail('Historique commandes', `${r.status} ${JSON.stringify(r.data)}`);
  ok(`Historique chargé (${Array.isArray(r.data) ? r.data.length : '?'} commandes)`);

  // 10. Déconnexion propre ─────────────────────────────────────────────
  r = await api('POST', '/auth/logout', { token });
  if (r.status !== 200) console.warn(`  ⚠️  Logout (${r.status}) — non bloquant`);
  else ok('Déconnexion OK');

  finalize();
}

function finalize() {
  console.log(`\n=== Résultat : ${stepPassed} étapes OK, ${stepFailed} échec(s) ===`);
  process.exit(stepFailed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n[E2E] Erreur fatale :', err.message);
  process.exit(1);
});
