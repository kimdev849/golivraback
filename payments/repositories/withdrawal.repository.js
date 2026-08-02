/**
 * Repository — Withdrawals (demandes de retrait)
 */

const { rowToWithdrawal, rowToPayout } = require('../entities/withdrawal.entity');

async function findById(db, withdrawalId) {
  const { data, error } = await db
    .from('withdrawals')
    .select('*')
    .eq('id', withdrawalId)
    .maybeSingle();
  if (error) throw error;
  return rowToWithdrawal(data);
}

async function findByPayoutId(db, payoutId) {
  if (!payoutId) return null;
  const { data, error } = await db
    .from('withdrawals')
    .select('*')
    .eq('payout_id', payoutId)
    .maybeSingle();
  if (error) throw error;
  return rowToWithdrawal(data);
}

async function create(db, payload) {
  const { data, error } = await db
    .from('withdrawals')
    .insert({
      portefeuille_id: payload.portefeuilleId,
      utilisateur_id: payload.utilisateurId,
      montant: payload.montantFcfa,
      devise: payload.devise || 'XAF',
      methode: payload.methode,
      numero_compte: payload.numeroCompte,
      nom_beneficiaire: payload.nomBeneficiaire || null,
      statut: payload.statut || 'en_attente',
      note_demandeur: payload.noteDemandeur || null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return rowToWithdrawal(data);
}

async function update(db, withdrawalId, patch) {
  const { data, error } = await db
    .from('withdrawals')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', withdrawalId)
    .select('*')
    .single();
  if (error) throw error;
  return rowToWithdrawal(data);
}

async function listForUser(db, utilisateurId, { limit = 50 } = {}) {
  const { data, error } = await db
    .from('withdrawals')
    .select('*')
    .eq('utilisateur_id', utilisateurId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(rowToWithdrawal);
}

async function listEnAttente(db, { limit = 100 } = {}) {
  const { data, error } = await db
    .from('withdrawals')
    .select('*')
    .eq('statut', 'en_attente')
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(rowToWithdrawal);
}

async function listEnTraitement(db, { limit = 100 } = {}) {
  const { data, error } = await db
    .from('withdrawals')
    .select('*')
    .eq('statut', 'en_traitement')
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(rowToWithdrawal);
}

const WITHDRAWAL_STATUT_ALIASES = {
  paye: 'reussi',
  payé: 'reussi',
  approuve: 'en_traitement',
};

function mapStatutForNewTable(statut) {
  return WITHDRAWAL_STATUT_ALIASES[String(statut || '').toLowerCase()] || statut;
}

function isMissingRelationError(error) {
  const msg = String(error?.message || error?.details || '').toLowerCase();
  return (
    String(error?.code) === 'PGRST205' ||
    (msg.includes('relation') && msg.includes('does not exist')) ||
    msg.includes('could not find the table')
  );
}

function isInvalidEnumValueError(error) {
  const msg = String(error?.message || error?.details || '').toLowerCase();
  return msg.includes('invalid input value for enum');
}

async function listAll(db, { statut, limit = 100 } = {}) {
  // Table `withdrawals` (schéma paiements refactorisé).
  const tryNew = async (statutFilter) => {
    let q = db.from('withdrawals').select('*').order('created_at', { ascending: false }).limit(limit);
    if (statutFilter) q = q.eq('statut', statutFilter);
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).map(rowToWithdrawal);
  };

  try {
    return await tryNew(statut ? mapStatutForNewTable(statut) : undefined);
  } catch (err) {
    if (isInvalidEnumValueError(err)) {
      // Le statut demandé n'existe pas dans le nouvel enum (ex. « paye ») →
      // on tente l'équivalent, sinon on relance sans filtre pour ne pas casser la page.
      const mapped = mapStatutForNewTable(statut);
      if (mapped !== statut) {
        try {
          return await tryNew(mapped);
        } catch {
          return tryNew(undefined);
        }
      }
      return tryNew(undefined);
    }
    if (!isMissingRelationError(err)) throw err;
  }

  // Table `withdrawals` absente → fallback sur la table legacy `demandes_retrait`.
  let q = db.from('demandes_retrait').select('*').order('created_at', { ascending: false }).limit(limit);
  if (statut) q = q.eq('statut', statut);
  const { data, error } = await q;
  if (isMissingRelationError(error)) return [];
  if (error) throw error;
  return (data || []).map((row) => ({
    id: row.id,
    portefeuilleId: row.portefeuille_id,
    utilisateurId: row.utilisateur_id,
    montantFcfa: Number(row.montant ?? 0),
    devise: row.devise || 'XAF',
    methode: row.methode,
    numeroCompte: row.numero_compte,
    nomBeneficiaire: row.nom_beneficiaire || null,
    statut: row.statut,
    motifRejet: row.motif_rejet || null,
    noteDemandeur: row.note_demandeur || null,
    noteAdmin: row.note_admin || null,
    payoutId: row.payout_id || null,
    payoutFailureReason: row.payout_failure_reason || null,
    tentatives: Number(row.tentatives ?? 0),
    traitePar: row.traite_par || null,
    traiteAt: row.traite_at || null,
    processedAt: row.processed_at || null,
    creeLe: row.created_at,
    misAJourLe: row.updated_at,
  }));
}

// ── Payouts ───────────────────────────────────────────────────────────────────

async function createPayout(db, payload) {
  const { data, error } = await db
    .from('pawapay_payouts')
    .insert({
      withdrawal_id: payload.withdrawalId,
      payout_id: payload.payoutId || null,
      statut: payload.statut || 'en_attente',
      montant: payload.montantFcfa,
      devise: payload.devise || 'XAF',
      methode: payload.methode,
      numero_compte: payload.numeroCompte,
      pays: payload.pays || 'CG',
      correspondant: payload.correspondant || null,
      request_payload: payload.requestPayload || null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return rowToPayout(data);
}

async function updatePayout(db, payoutRowId, patch) {
  const { data, error } = await db
    .from('pawapay_payouts')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', payoutRowId)
    .select('*')
    .single();
  if (error) throw error;
  return rowToPayout(data);
}

async function findPayoutByPayoutId(db, payoutId) {
  if (!payoutId) return null;
  const { data, error } = await db
    .from('pawapay_payouts')
    .select('*')
    .eq('payout_id', payoutId)
    .maybeSingle();
  if (error) throw error;
  return rowToPayout(data);
}

async function findPayoutByWithdrawalId(db, withdrawalId) {
  const { data, error } = await db
    .from('pawapay_payouts')
    .select('*')
    .eq('withdrawal_id', withdrawalId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return rowToPayout(data);
}

async function listPayoutsEnTraitement(db, { limit = 50 } = {}) {
  const { data, error } = await db
    .from('pawapay_payouts')
    .select('*')
    .in('statut', ['soumis', 'en_traitement'])
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(rowToPayout);
}

module.exports = {
  // Withdrawals
  findById: findById,
  findByPayoutId,
  create,
  update,
  listForUser,
  listEnAttente,
  listEnTraitement,
  listAll,
  // Payouts
  createPayout,
  updatePayout,
  findPayoutByPayoutId,
  findPayoutByWithdrawalId,
  listPayoutsEnTraitement,
};
