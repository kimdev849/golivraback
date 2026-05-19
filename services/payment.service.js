const { createHttpError } = require('../utils/http');
const { getPricingConfig, randomTestPaymentAmount } = require('./pricing.service');

/** test = succès immédiat ; airtel | mtn = APIs réelles (à brancher). */
const PAYMENT_MODE = String(process.env.PAYMENT_MODE || 'test').toLowerCase();

const PROVIDER_ALIASES = {
  airtel: 'airtel_money',
  airtel_money: 'airtel_money',
  mtn: 'mtn_money',
  mtn_money: 'mtn_money',
};

function normalizeProvider(input) {
  const key = String(input || 'airtel').trim().toLowerCase();
  return PROVIDER_ALIASES[key] || 'airtel_money';
}

function isTestPaymentMode() {
  return PAYMENT_MODE === 'test' || PAYMENT_MODE === 'mock' || PAYMENT_MODE === 'dev';
}

async function assertOrderOwnedByClient(db, commandeId, clientId) {
  const { data: commande, error } = await db
    .from('commandes')
    .select('id, client_id, total, methode_paiement, statut')
    .eq('id', commandeId)
    .maybeSingle();
  if (error) throw error;
  if (!commande) throw createHttpError(404, 'Commande introuvable.');
  if (commande.client_id !== clientId) throw createHttpError(403, 'Accès non autorisé.');
  return commande;
}

async function getPendingPaymentForOrder(db, commandeId) {
  const { data, error } = await db
    .from('paiements')
    .select('*')
    .eq('commande_id', commandeId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Paiement commande client — en mode test, validation immédiate (Airtel / MTN simulés).
 */
async function payOrderForClient(db, commandeId, clientId, { provider } = {}) {
  const commande = await assertOrderOwnedByClient(db, commandeId, clientId);
  const paiement = await getPendingPaymentForOrder(db, commandeId);

  if (!paiement) throw createHttpError(404, 'Paiement introuvable pour cette commande.');
  if (paiement.statut === 'valide') {
    const { creditVendorsOnOrderPaid } = require('./wallet.service');
    await creditVendorsOnOrderPaid(db, commandeId, paiement.id).catch((err) => {
      console.error('[wallet] creditVendorsOnOrderPaid (retry)', commandeId, err?.message || err);
    });
    return { commande, paiement, deja_valide: true };
  }

  const methode = normalizeProvider(provider || commande.methode_paiement);
  const now = new Date().toISOString();

  if (!isTestPaymentMode()) {
    throw createHttpError(
      501,
      'Paiement live Airtel / MTN : configurez PAYMENT_MODE=test en développement ou branchez les APIs.',
    );
  }

  const reference = `TEST_${Date.now()}`;
  const pricingConfig = await getPricingConfig(db);
  const testRandom = randomTestPaymentAmount(pricingConfig);
  const metadata = {
    ...(paiement.metadata && typeof paiement.metadata === 'object' ? paiement.metadata : {}),
    mode: 'test',
    provider: methode === 'mtn_money' ? 'mtn' : 'airtel',
    paid_at: now,
    montant_commande_fcfa: Number(commande.total ?? paiement.montant),
    ...(testRandom != null ? { dev_test_random_fcfa: testRandom } : {}),
  };

  const { data: updatedPayment, error: payErr } = await db
    .from('paiements')
    .update({
      statut: 'valide',
      methode,
      reference_externe: reference,
      numero_transaction: reference,
      metadata,
      paye_at: now,
      updated_at: now,
    })
    .eq('id', paiement.id)
    .eq('statut', 'en_attente')
    .select('*')
    .maybeSingle();

  if (payErr) throw payErr;
  if (!updatedPayment) {
    const again = await getPendingPaymentForOrder(db, commandeId);
    if (again?.statut === 'valide') {
      return { commande, paiement: again, deja_valide: true };
    }
    throw createHttpError(409, 'Le paiement ne peut plus être validé.');
  }

  const { creditVendorsOnOrderPaid } = require('./wallet.service');
  await creditVendorsOnOrderPaid(db, commandeId, updatedPayment.id).catch((err) => {
    console.error('[wallet] creditVendorsOnOrderPaid', commandeId, err?.message || err);
  });

  return { commande, paiement: updatedPayment, deja_valide: false };
}

async function assertCommandePayee(db, commandeId) {
  const paiement = await getPendingPaymentForOrder(db, commandeId);
  if (!paiement || paiement.statut !== 'valide') {
    throw createHttpError(402, 'Le paiement doit être validé avant de traiter la commande.');
  }
  return paiement;
}

module.exports = {
  PAYMENT_MODE,
  isTestPaymentMode,
  payOrderForClient,
  assertCommandePayee,
  getPendingPaymentForOrder,
};
