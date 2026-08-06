/**
 * Service — PawaPay API client
 * Client HTTP minimal pour les opérations deposit / payout / refund.
 *
 * Variables d'environnement :
 *   - PAWAPAY_BASE_URL      : ex. https://api.sandbox.pawapay.io  (défaut sandbox)
 *   - PAWAPAY_API_KEY       : clé Bearer à fournir
 *   - PAWAPAY_WEBHOOK_SECRET: secret HMAC pour vérifier les webhooks
 *
 * Mode "simulation" : si PAWAPAY_API_KEY n'est pas défini, les méthodes renvoient
 * un objet factice (succès) — utile en dev / démo avant l'obtention des credentials.
 */

const { info: logInfo, warn: logWarn, error: logError } = require('../../utils/logger');

const BASE_URL = (process.env.PAWAPAY_BASE_URL || 'https://api.sandbox.pawapay.io').replace(/\/+$/, '');
const API_KEY = String(process.env.PAWAPAY_API_KEY || '').trim();
const WEBHOOK_SECRET = String(process.env.PAWAPAY_WEBHOOK_SECRET || '').trim();

function isLive() {
  return Boolean(API_KEY);
}

function countryToCorrespondent(country, provider) {
  const c = String(country || 'CG').toUpperCase();
  const p = String(provider || '').toLowerCase();
  if (c === 'CG') {
    if (p.includes('mtn')) return 'MTN_MOMO_CG';
    if (p.includes('airtel')) return 'AIRTEL_CG';
  }
  return null;
}

function providerToType(methode) {
  if (methode === 'mtn_money') return 'MTN';
  if (methode === 'airtel_money') return 'AIRTEL';
  return 'MM';
}

async function httpJson(path, body, { method = 'POST' } = {}) {
  if (!isLive()) {
    return { ok: false, simulated: true, reason: 'PAWAPAY_API_KEY manquant', path, body };
  }
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  if (text) {
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
  }
  if (!res.ok) {
    logError({ msg: 'pawapay_http_error', url, status: res.status, body: json });
    const err = new Error(`PawaPay ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/**
 * Initie un deposit (paiement client).
 *
 * En mode sandbox, `numeroCompte` peut être swappé automatiquement par le
 * scénario actif (cf. pawapay-sandbox.service). Le mobile envoie toujours
 * le vrai numéro ; le backend fait le swap.
 *
 * @see https://docs.pawapay.io/#operation/initiateDeposit
 */
async function initiateDeposit({ depositId, montantFcfa, currency = 'XAF', methode, numeroCompte, pays = 'CG', metadata = [], sandboxContext = null }) {
  const sandboxResolution = sandboxContext ? resolveSandboxPhone(sandboxContext, numeroCompte, methode) : null;
  const finalPhone = sandboxResolution?.numeroCompte || numeroCompte;
  const finalMethode = sandboxResolution?.methode || methode;
  const finalPays = sandboxResolution?.pays || pays;

  const payload = {
    depositId,
    amount: String(Number(montantFcfa).toFixed(2)),
    currency: String(currency || 'XAF').toUpperCase(),
    correspondent: countryToCorrespondent(finalPays, finalMethode),
    payer: {
      type: 'MSISDN',
      address: { value: normalizePhone(finalPhone) },
    },
    customerMessage: 'GoLivra',
    clientReferenceId: depositId,
    metadata: appendSandboxMetadata(metadata, sandboxResolution),
  };
  try {
    const json = await httpJson('/deposits', payload);
    return { ok: true, simulated: false, data: json, sandbox: sandboxResolution };
  } catch (err) {
    if (!isLive()) return { ok: true, simulated: true, data: null, sandbox: sandboxResolution };
    return { ok: false, simulated: false, error: err.message, body: err.body, sandbox: sandboxResolution };
  }
}

/**
 * Initie un payout (retrait vers Mobile Money).
 * Même logique sandbox que initiateDeposit.
 *
 * @see https://docs.pawapay.io/#operation/initiatePayout
 */
async function initiatePayout({ payoutId, montantFcfa, currency = 'XAF', methode, numeroCompte, pays = 'CG', nomBeneficiaire, metadata = [], sandboxContext = null }) {
  const sandboxResolution = sandboxContext ? resolveSandboxPhone(sandboxContext, numeroCompte, methode) : null;
  const finalPhone = sandboxResolution?.numeroCompte || numeroCompte;
  const finalMethode = sandboxResolution?.methode || methode;
  const finalPays = sandboxResolution?.pays || pays;

  const payload = {
    payoutId,
    amount: String(Number(montantFcfa).toFixed(2)),
    currency: String(currency || 'XAF').toUpperCase(),
    correspondent: countryToCorrespondent(finalPays, finalMethode),
    recipient: {
      type: 'MSISDN',
      address: { value: normalizePhone(finalPhone) },
    },
    customerMessage: 'GoLivra retrait',
    clientReferenceId: payoutId,
    metadata: appendSandboxMetadata(metadata, sandboxResolution),
    ...(nomBeneficiaire ? { recipientName: nomBeneficiaire } : {}),
  };
  try {
    const json = await httpJson('/payouts', payload);
    return { ok: true, simulated: false, data: json, sandbox: sandboxResolution };
  } catch (err) {
    if (!isLive()) return { ok: true, simulated: true, data: null, sandbox: sandboxResolution };
    return { ok: false, simulated: false, error: err.message, body: err.body, sandbox: sandboxResolution };
  }
}

/**
 * Initie un remboursement (refund) d'un dépôt PawaPay.
 * L'argent est reversé automatiquement sur le numéro Mobile Money du payeur.
 *
 * @see https://docs.pawapay.io/#operation/initiateDepositRefund
 */
async function initiateRefund({ refundId, depositId, montantFcfa, motif = null, metadata = [] }) {
  if (!depositId) return { ok: false, simulated: false, error: 'deposit_id_manquant' };
  const payload = {
    refundId,
    depositId,
    amount: String(Number(montantFcfa).toFixed(2)),
    currency: 'XAF',
    reason: String(motif || 'Commande non confirmée par le commerce').slice(0, 60),
    metadata: metadata || [],
  };
  try {
    const json = await httpJson(`/deposits/${encodeURIComponent(depositId)}/refunds`, payload);
    return { ok: true, simulated: false, data: json };
  } catch (err) {
    if (!isLive()) return { ok: true, simulated: true, data: null };
    return { ok: false, simulated: false, error: err.message, body: err.body };
  }
}

// ── Helpers sandbox (import paresseux) ──────────────────────────────────────
let _sandbox = null;
function getSandbox() {
  if (_sandbox === null) {
    try {
      // eslint-disable-next-line global-require
      _sandbox = require('./pawapay-sandbox.service');
    } catch {
      _sandbox = { resolvePhoneForRequest: () => null };
    }
  }
  return _sandbox;
}

function resolveSandboxPhone(sandboxContext, numeroCompte, methode) {
  const sandbox = getSandbox();
  if (typeof sandbox.resolvePhoneForRequest !== 'function') return null;
  return sandbox.resolvePhoneForRequest({
    utilisateurId: sandboxContext?.utilisateurId || null,
    commandeId: sandboxContext?.commandeId || null,
    numeroCompte,
    operateur: methode, // 'mtn_money' | 'airtel_money' (sandbox résout la clé MTN_COG / AIRTEL_COG)
  });
}

function appendSandboxMetadata(metadata, sandboxResolution) {
  if (!sandboxResolution || sandboxResolution.mode !== 'sandbox') return metadata;
  return [
    ...(metadata || []),
    { fieldName: 'sandbox_scenario', fieldValue: sandboxResolution.scenario || 'NONE' },
    { fieldName: 'sandbox_operateur', fieldValue: sandboxResolution.operateur || 'NONE' },
    { fieldName: 'sandbox_statut_attendu', fieldValue: sandboxResolution.statutAttendu || 'NONE' },
    { fieldName: 'sandbox_numero_reel', fieldValue: sandboxResolution.numeroReel || 'NONE' },
  ];
}

/**
 * Vérifie le statut d'un payout.
 */
async function getPayoutStatus(payoutId) {
  if (!isLive()) return { ok: true, simulated: true, data: { payoutId, status: 'COMPLETED' } };
  try {
    const json = await httpJson(`/payouts/${encodeURIComponent(payoutId)}`, null, { method: 'GET' });
    return { ok: true, simulated: false, data: json };
  } catch (err) {
    return { ok: false, simulated: false, error: err.message, body: err.body };
  }
}

function normalizePhone(num) {
  if (!num) return null;
  const s = String(num).replace(/[^\d+]/g, '');
  if (s.startsWith('+')) return s;
  if (s.startsWith('00')) return `+${s.slice(2)}`;
  if (s.length === 9) return `+242${s}`;
  if (s.length === 12 && s.startsWith('242')) return `+${s}`;
  return s;
}

function logConfig() {
  logInfo({
    msg: 'pawapay_config',
    live: isLive(),
    base_url: BASE_URL,
    webhook_secret_set: Boolean(WEBHOOK_SECRET),
  });
}

module.exports = {
  isLive,
  initiateDeposit,
  initiatePayout,
  initiateRefund,
  getPayoutStatus,
  normalizePhone,
  countryToCorrespondent,
  providerToType,
  logConfig,
  WEBHOOK_SECRET,
  BASE_URL,
  API_KEY,
};
