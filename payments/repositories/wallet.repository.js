/**
 * Repository — Portefeuilles
 * Accès brut à la table `portefeuilles`.
 */

const { rowToWallet } = require('../entities/wallet.entity');

async function findByUtilisateur(db, utilisateurId) {
  const { data, error } = await db
    .from('portefeuilles')
    .select('*')
    .eq('utilisateur_id', utilisateurId)
    .maybeSingle();
  if (error) throw error;
  return rowToWallet(data);
}

async function getOrCreate(db, utilisateurId) {
  const existing = await findByUtilisateur(db, utilisateurId);
  if (existing) return existing;
  const { data, error } = await db
    .from('portefeuilles')
    .insert({ utilisateur_id: utilisateurId })
    .select('*')
    .single();
  if (!error) return rowToWallet(data);
  // 23505 = contrainte d'unicité violée (2 requêtes simultanées ont inséré en
  // parallèle). On relit : le portefeuille existe forcément maintenant.
  if (String(error.code) === '23505') {
    const again = await findByUtilisateur(db, utilisateurId);
    if (again) return again;
  }
  throw error;
}

async function updateSolde(db, portefeuilleId, { solde, soldeEnAttente }) {
  const patch = { updated_at: new Date().toISOString() };
  if (solde != null) patch.solde = solde;
  if (soldeEnAttente != null) patch.solde_en_attente = soldeEnAttente;
  const { data, error } = await db
    .from('portefeuilles')
    .update(patch)
    .eq('id', portefeuilleId)
    .select('*')
    .single();
  if (error) throw error;
  return rowToWallet(data);
}

/** Liste tous les wallets (admin). */
async function listAll(db, { limit = 200 } = {}) {
  const { data, error } = await db
    .from('portefeuilles')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(rowToWallet);
}

module.exports = { findByUtilisateur, getOrCreate, updateSolde, listAll };
