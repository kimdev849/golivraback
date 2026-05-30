const { createHttpError } = require('../utils/http');
const { getPricingConfig, splitByPercent, splitDeliveryFee } = require('./pricing.service');

let cachedGolivraUserId = null;

async function resolveGolivraPlatformUserId(db) {
  if (process.env.GOLIVRA_PLATFORM_USER_ID) {
    return process.env.GOLIVRA_PLATFORM_USER_ID;
  }
  if (cachedGolivraUserId) return cachedGolivraUserId;

  const email = String(process.env.GOLIVRA_PLATFORM_EMAIL || 'golivra@gmail.com').trim();
  const { data: byEmail } = await db
    .from('utilisateurs')
    .select('id')
    .ilike('email', email)
    .maybeSingle();
  if (byEmail?.id) {
    cachedGolivraUserId = byEmail.id;
    return byEmail.id;
  }

  const { data: role } = await db.from('roles').select('id').eq('nom', 'admin').maybeSingle();
  if (role?.id) {
    const { data: admin } = await db
      .from('utilisateurs')
      .select('id')
      .eq('role_id', role.id)
      .eq('est_actif', true)
      .limit(1)
      .maybeSingle();
    if (admin?.id) {
      cachedGolivraUserId = admin.id;
      return admin.id;
    }
  }

  throw createHttpError(500, 'Compte portefeuille GoLivra introuvable (admin ou GOLIVRA_PLATFORM_USER_ID).');
}

async function getOrCreatePortefeuille(db, utilisateurId) {
  const { data: existing, error: exErr } = await db
    .from('portefeuilles')
    .select('*')
    .eq('utilisateur_id', utilisateurId)
    .maybeSingle();
  if (exErr) throw exErr;
  if (existing) return existing;

  const { data: created, error: insErr } = await db
    .from('portefeuilles')
    .insert({ utilisateur_id: utilisateurId })
    .select('*')
    .single();
  if (insErr) throw insErr;
  return created;
}

async function hasWalletTransaction(db, { portefeuilleId, type, referenceType, referenceId }) {
  const { data } = await db
    .from('transactions_portefeuille')
    .select('id')
    .eq('portefeuille_id', portefeuilleId)
    .eq('type', type)
    .eq('reference_type', referenceType)
    .eq('reference_id', referenceId)
    .maybeSingle();
  return Boolean(data?.id);
}

async function creditWallet(
  db,
  utilisateurId,
  montant,
  { type = 'credit', referenceType, referenceId, description } = {},
) {
  const amount = Number(montant);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const portefeuille = await getOrCreatePortefeuille(db, utilisateurId);
  if (referenceType && referenceId) {
    const exists = await hasWalletTransaction(db, {
      portefeuilleId: portefeuille.id,
      type,
      referenceType,
      referenceId,
    });
    if (exists) return portefeuille;
  }

  const soldeAvant = Number(portefeuille.solde ?? 0);
  const soldeApres = soldeAvant + amount;
  const now = new Date().toISOString();

  const { error: txErr } = await db.from('transactions_portefeuille').insert({
    portefeuille_id: portefeuille.id,
    type,
    montant: amount,
    solde_avant: soldeAvant,
    solde_apres: soldeApres,
    reference_type: referenceType || null,
    reference_id: referenceId || null,
    description: description || null,
    created_at: now,
  });
  if (txErr) throw txErr;

  const { data: updated, error: upErr } = await db
    .from('portefeuilles')
    .update({ solde: soldeApres, updated_at: now })
    .eq('id', portefeuille.id)
    .select('*')
    .single();
  if (upErr) throw upErr;
  return updated;
}

async function getEstablishmentOwnerId(db, sc) {
  if (sc.restaurant_id) {
    const { data } = await db
      .from('restaurants')
      .select('proprietaire_id')
      .eq('id', sc.restaurant_id)
      .maybeSingle();
    return data?.proprietaire_id || null;
  }
  if (sc.boutique_id) {
    const { data } = await db
      .from('boutiques')
      .select('proprietaire_id')
      .eq('id', sc.boutique_id)
      .maybeSingle();
    return data?.proprietaire_id || null;
  }
  return null;
}

async function markCommandeEscrowCredited(db, commandeId) {
  const now = new Date().toISOString();
  const { error } = await db
    .from('commandes')
    .update({ escrow_credite_at: now, updated_at: now })
    .eq('id', commandeId);
  if (error && !String(error.message || '').includes('escrow_credite_at')) {
    throw error;
  }
}

/**
 * Paiement validé → fonds sur le portefeuille escrow GoLivra (pas de versement marchand avant livraison).
 */
async function holdOrderPaymentInEscrow(db, commandeId, paiementId) {
  const { data: commande, error } = await db
    .from('commandes')
    .select('id, total, escrow_credite_at')
    .eq('id', commandeId)
    .maybeSingle();
  if (error) throw error;
  if (!commande) throw createHttpError(404, 'Commande introuvable.');

  if (commande.escrow_credite_at) {
    return { commande_id: commandeId, paiement_id: paiementId, deja_credite: true };
  }

  const total = Number(commande.total ?? 0);
  if (total <= 0) {
    await markCommandeEscrowCredited(db, commandeId);
    return { commande_id: commandeId, paiement_id: paiementId, montant_fcfa: 0 };
  }

  const golivraUserId = await resolveGolivraPlatformUserId(db);
  await creditWallet(db, golivraUserId, total, {
    type: 'credit',
    referenceType: 'escrow_commande',
    referenceId: commandeId,
    description: `Escrow — paiement commande ${commandeId}`,
  });
  await markCommandeEscrowCredited(db, commandeId);

  return { commande_id: commandeId, paiement_id: paiementId, montant_fcfa: total, escrow: true };
}

/** @deprecated — conservé pour compatibilité d’import ; utilise l’escrow. */
async function creditVendorsOnOrderPaid(db, commandeId, paiementId) {
  return holdOrderPaymentInEscrow(db, commandeId, paiementId);
}

async function resolveDeliveryCommissionPercent(db, entrepriseLogistiqueId) {
  if (entrepriseLogistiqueId) {
    const { data } = await db
      .from('entreprises_logistiques')
      .select('commission_pct')
      .eq('id', entrepriseLogistiqueId)
      .maybeSingle();
    const pct = Number(data?.commission_pct);
    if (Number.isFinite(pct) && pct >= 0 && pct <= 100) return pct;
  }
  const config = await getPricingConfig(db);
  return Number(config.delivery_platform_percent);
}

async function resolveDriverUserId(db, livraison) {
  if (!livraison?.livreur_id) return null;
  const { data } = await db
    .from('livreurs')
    .select('utilisateur_id')
    .eq('id', livraison.livreur_id)
    .maybeSingle();
  return data?.utilisateur_id || null;
}

async function markSousCommandeReglee(db, sousCommandeId) {
  const now = new Date().toISOString();
  const { error } = await db
    .from('sous_commandes')
    .update({ reglee_at: now, updated_at: now })
    .eq('id', sousCommandeId);
  if (error && !String(error.message || '').includes('reglee_at')) {
    throw error;
  }
}

/**
 * Livraison terminée (ou sous-commande « livrée ») → répartition unique :
 * commerce = produit ; livreur = livraison − commission GoLivra ; GoLivra = % livraison (contrat entreprise).
 */
async function settleSousCommandePayout(db, sousCommandeId, livraison = null) {
  const { data: sc, error: scErr } = await db
    .from('sous_commandes')
    .select('*')
    .eq('id', sousCommandeId)
    .maybeSingle();
  if (scErr) throw scErr;
  if (!sc) return { skipped: true, reason: 'sous_commande_absente' };

  if (sc.reglee_at) {
    return { skipped: true, reason: 'deja_reglee', sous_commande_id: sousCommandeId };
  }

  const golivraUserId = await resolveGolivraPlatformUserId(db);
  const golivraPf = await getOrCreatePortefeuille(db, golivraUserId);
  const existsSettlement = await hasWalletTransaction(db, {
    portefeuilleId: golivraPf.id,
    type: 'debit',
    referenceType: 'escrow_sous_commande',
    referenceId: sousCommandeId,
  });
  if (existsSettlement) {
    return { skipped: true, reason: 'deja_reglee', sous_commande_id: sousCommandeId };
  }
  const merchantRef = `${sousCommandeId}:merchant`;
  const ownerId = await getEstablishmentOwnerId(db, sc);
  const produit = Number(sc.sous_total ?? 0);
  const frais = Number(sc.frais_livraison ?? 0);
  const entrepriseId = livraison?.entreprise_logistique_id || null;
  const commissionPct = await resolveDeliveryCommissionPercent(db, entrepriseId);
  const commissionGolivra = frais > 0 ? Math.round((frais * commissionPct) / 100) : 0;
  const livreurPart = Math.max(0, frais - commissionGolivra);

  const { data: commande } = await db
    .from('commandes')
    .select('escrow_credite_at')
    .eq('id', sc.commande_id)
    .maybeSingle();
  const escrowHeld = Boolean(commande?.escrow_credite_at);

  const escrowDebit = escrowHeld ? produit + livreurPart : 0;
  if (escrowHeld && escrowDebit > 0 && !existsSettlement) {
    await debitWallet(db, golivraUserId, escrowDebit, {
      type: 'debit',
      referenceType: 'escrow_sous_commande',
      referenceId: sousCommandeId,
      description: `Sortie escrow — sous-commande ${sc.numero || sousCommandeId}`,
    });
  }

  if (ownerId && produit > 0) {
    const alreadyMerchant = await hasWalletTransaction(db, {
      portefeuilleId: (await getOrCreatePortefeuille(db, ownerId)).id,
      type: 'credit',
      referenceType: 'sous_commande',
      referenceId: sc.id,
    });
    const alreadyMerchantV2 = await hasWalletTransaction(db, {
      portefeuilleId: (await getOrCreatePortefeuille(db, ownerId)).id,
      type: 'credit',
      referenceType: 'vente_sous_commande',
      referenceId: merchantRef,
    });
    if (!alreadyMerchant && !alreadyMerchantV2) {
      await creditWallet(db, ownerId, produit, {
        type: 'credit',
        referenceType: 'vente_sous_commande',
        referenceId: merchantRef,
        description: `Vente livrée — ${sc.numero || sousCommandeId}`,
      });
    }
  }

  const driverUserId = await resolveDriverUserId(db, livraison);
  if (livreurPart > 0) {
    const driverRef = `${sousCommandeId}:driver`;
    if (driverUserId) {
      await creditWallet(db, driverUserId, livreurPart, {
        type: 'gain_livraison',
        referenceType: 'livraison_sous_commande',
        referenceId: driverRef,
        description: `Livraison — ${livreurPart} FCFA (commission plateforme ${commissionPct} %)`,
      });
    } else if (entrepriseId) {
      const gestionnaireId = await resolveLogisticsGestionnaireId(db, entrepriseId);
      if (gestionnaireId) {
        await creditWallet(db, gestionnaireId, livreurPart, {
          type: 'commission_logistique',
          referenceType: 'sous_commande',
          referenceId: driverRef,
          description: `Livraison entreprise — ${livreurPart} FCFA`,
        });
      }
    }
  }

  // La commission reste sur le portefeuille GoLivra (escrow entrant − sorties marchand/livreur).

  await markSousCommandeReglee(db, sousCommandeId);

  return {
    sous_commande_id: sousCommandeId,
    produit_fcfa: produit,
    livreur_fcfa: livreurPart,
    golivra_fcfa: commissionGolivra,
    commission_pct: commissionPct,
    escrow: escrowHeld,
  };
}

async function debitWallet(
  db,
  utilisateurId,
  montant,
  { type = 'debit', referenceType, referenceId, description } = {},
) {
  const amount = Number(montant);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw createHttpError(400, 'Montant de débit invalide.');
  }

  const portefeuille = await getOrCreatePortefeuille(db, utilisateurId);
  if (referenceType && referenceId) {
    const exists = await hasWalletTransaction(db, {
      portefeuilleId: portefeuille.id,
      type,
      referenceType,
      referenceId,
    });
    if (exists) return portefeuille;
  }

  const soldeAvant = Number(portefeuille.solde ?? 0);
  if (soldeAvant < amount) {
    throw createHttpError(400, 'Solde insuffisant.');
  }

  const soldeApres = soldeAvant - amount;
  const now = new Date().toISOString();

  const { error: txErr } = await db.from('transactions_portefeuille').insert({
    portefeuille_id: portefeuille.id,
    type,
    montant: amount,
    solde_avant: soldeAvant,
    solde_apres: soldeApres,
    reference_type: referenceType || null,
    reference_id: referenceId || null,
    description: description || null,
    created_at: now,
  });
  if (txErr) throw txErr;

  const { data: updated, error: upErr } = await db
    .from('portefeuilles')
    .update({ solde: soldeApres, updated_at: now })
    .eq('id', portefeuille.id)
    .select('*')
    .single();
  if (upErr) throw upErr;
  return updated;
}

async function listTransactionsForUser(db, utilisateurId, { limit = 40 } = {}) {
  const pf = await getOrCreatePortefeuille(db, utilisateurId);
  const { data, error } = await db
    .from('transactions_portefeuille')
    .select('*')
    .eq('portefeuille_id', pf.id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map((t) => ({
    id: t.id,
    type: t.type,
    montant: Number(t.montant),
    solde_apres: Number(t.solde_apres),
    description: t.description,
    reference_type: t.reference_type,
    reference_id: t.reference_id,
    created_at: t.created_at,
  }));
}

async function getWalletDashboard(db, utilisateurId) {
  const pf = await getOrCreatePortefeuille(db, utilisateurId);
  const transactions = await listTransactionsForUser(db, utilisateurId, { limit: 25 });

  const { data: retraits } = await db
    .from('demandes_retrait')
    .select('id, montant, statut, methode, numero_compte, created_at, traite_at')
    .eq('utilisateur_id', utilisateurId)
    .order('created_at', { ascending: false })
    .limit(15);

  return {
    portefeuille_id: pf.id,
    solde_fcfa: Number(pf.solde ?? 0),
    solde_en_attente_fcfa: Number(pf.solde_en_attente ?? 0),
    devise: pf.devise || 'XAF',
    transactions,
    retraits: retraits || [],
  };
}

const MIN_RETRAIT_FCFA = Number(process.env.MIN_RETRAIT_FCFA) || 5000;

const AUTO_WITHDRAW_ROLES = new Set([
  'restaurateur',
  'commercant',
  'gestionnaire_logistique',
  'livreur',
]);

async function createWithdrawalRequest(db, utilisateurId, payload, { role } = {}) {
  const montant = Number(payload.montant);
  const methode = String(payload.methode || 'airtel_money').trim();
  const numeroCompte = String(payload.numero_compte || payload.numeroCompte || '').trim();
  const note = payload.note ? String(payload.note).trim() : null;
  const roleName = role ? String(role).trim() : null;
  const isPlatformAdmin = roleName === 'admin';
  const autoApprove = roleName ? AUTO_WITHDRAW_ROLES.has(roleName) : false;
  const minMontant = isPlatformAdmin ? 1 : MIN_RETRAIT_FCFA;

  if (!Number.isFinite(montant) || montant < minMontant) {
    throw createHttpError(
      400,
      isPlatformAdmin
        ? 'Montant de retrait invalide.'
        : `Montant minimum de retrait : ${MIN_RETRAIT_FCFA} FCFA.`,
    );
  }
  if (!numeroCompte || numeroCompte.length < 8) {
    throw createHttpError(400, 'Numéro Mobile Money invalide.');
  }

  const pf = await getOrCreatePortefeuille(db, utilisateurId);
  if (Number(pf.solde ?? 0) < montant) {
    throw createHttpError(400, 'Solde insuffisant.');
  }

  if (!autoApprove && !isPlatformAdmin) {
    const { data: pending } = await db
      .from('demandes_retrait')
      .select('id')
      .eq('utilisateur_id', utilisateurId)
      .eq('statut', 'en_attente');
    if ((pending || []).length > 0) {
      throw createHttpError(409, 'Vous avez déjà une demande de retrait en attente.');
    }
  }

  const now = new Date().toISOString();
  const { data: created, error } = await db
    .from('demandes_retrait')
    .insert({
      portefeuille_id: pf.id,
      utilisateur_id: utilisateurId,
      montant,
      methode,
      numero_compte: numeroCompte,
      note_demandeur: note,
      statut: autoApprove || isPlatformAdmin ? 'paye' : 'en_attente',
      traite_at: autoApprove || isPlatformAdmin ? now : null,
      note_admin: autoApprove || isPlatformAdmin ? 'Retrait traité automatiquement' : null,
    })
    .select('*')
    .single();
  if (error) throw error;

  if (autoApprove || isPlatformAdmin) {
    await debitWallet(db, utilisateurId, montant, {
      type: 'debit',
      referenceType: 'retrait',
      referenceId: created.id,
      description: `Retrait ${methode} → ${numeroCompte}`,
    });
  }

  return created;
}

async function listWithdrawalsAdmin(db, { statut } = {}) {
  let query = db
    .from('demandes_retrait')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  if (statut) query = query.eq('statut', statut);
  const { data, error } = await query;
  if (error) throw error;

  const userIds = [...new Set((data || []).map((r) => r.utilisateur_id))];
  const { data: users } = userIds.length
    ? await db.from('utilisateurs').select('id, nom, telephone, email').in('id', userIds)
    : { data: [] };
  const userMap = new Map((users || []).map((u) => [u.id, u]));

  return (data || []).map((r) => ({
    ...r,
    montant: Number(r.montant),
    utilisateur: userMap.get(r.utilisateur_id) || null,
  }));
}

async function processWithdrawalAdmin(db, retraitId, adminUserId, { action, note_admin: noteAdmin } = {}) {
  const { data: demande, error } = await db
    .from('demandes_retrait')
    .select('*')
    .eq('id', retraitId)
    .maybeSingle();
  if (error) throw error;
  if (!demande) throw createHttpError(404, 'Demande introuvable.');
  if (demande.statut !== 'en_attente') {
    throw createHttpError(409, 'Cette demande a déjà été traitée.');
  }

  const now = new Date().toISOString();

  if (action === 'rejeter' || action === 'reject') {
    const { data, error: upErr } = await db
      .from('demandes_retrait')
      .update({
        statut: 'rejete',
        note_admin: noteAdmin || null,
        traite_par: adminUserId,
        traite_at: now,
        updated_at: now,
      })
      .eq('id', retraitId)
      .select('*')
      .single();
    if (upErr) throw upErr;
    return data;
  }

  if (action === 'approuver' || action === 'approve' || action === 'payer' || action === 'pay') {
    await debitWallet(db, demande.utilisateur_id, Number(demande.montant), {
      type: 'debit',
      referenceType: 'retrait',
      referenceId: retraitId,
      description: `Retrait ${demande.methode} → ${demande.numero_compte}`,
    });

    const { data, error: upErr } = await db
      .from('demandes_retrait')
      .update({
        statut: 'paye',
        note_admin: noteAdmin || 'Paiement effectué (simulation / manuel)',
        traite_par: adminUserId,
        traite_at: now,
        updated_at: now,
      })
      .eq('id', retraitId)
      .select('*')
      .single();
    if (upErr) throw upErr;
    return data;
  }

  throw createHttpError(400, 'Action invalide (approuver, rejeter).');
}

async function getPlatformWalletAdmin(db) {
  const golivraUserId = await resolveGolivraPlatformUserId(db);
  const dashboard = await getWalletDashboard(db, golivraUserId);

  const { data: txs } = await db
    .from('transactions_portefeuille')
    .select('montant, type, created_at')
    .eq('portefeuille_id', dashboard.portefeuille_id);

  let commissionsLivraison = 0;
  let totalCredits = 0;
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();

  for (const t of txs || []) {
    const m = Number(t.montant);
    if (t.type === 'commission_golivra') {
      commissionsLivraison += m;
      if (t.created_at >= monthStart) totalCredits += m;
    }
  }

  const { data: pendingRetraits } = await db
    .from('demandes_retrait')
    .select('id, montant')
    .eq('statut', 'en_attente');
  const retraitsEnAttente = (pendingRetraits || []).reduce((a, r) => a + Number(r.montant), 0);

  return {
    ...dashboard,
    role: 'plateforme_golivra',
    commissions_livraison_total_fcfa: commissionsLivraison,
    commissions_livraison_mois_fcfa: totalCredits,
    retraits_en_attente_fcfa: retraitsEnAttente,
    nb_retraits_en_attente: (pendingRetraits || []).length,
    message:
      'Revenus GoLivra = part plateforme sur les frais de livraison uniquement (pas de commission sur les ventes).',
  };
}

async function resolveLogisticsGestionnaireId(db, entrepriseLogistiqueId) {
  if (!entrepriseLogistiqueId) return null;
  const { data } = await db
    .from('entreprises_logistiques')
    .select('gestionnaire_id')
    .eq('id', entrepriseLogistiqueId)
    .maybeSingle();
  return data?.gestionnaire_id || null;
}

async function resolveDeliveryFeeForLivraison(db, livraison) {
  if (livraison.sous_commande_id) {
    const { data: sc } = await db
      .from('sous_commandes')
      .select('frais_livraison')
      .eq('id', livraison.sous_commande_id)
      .maybeSingle();
    if (sc?.frais_livraison != null) return Number(sc.frais_livraison);
  }
  const snap = livraison.adresse_livraison_snapshot;
  if (snap && typeof snap === 'object' && snap.montant_livraison != null) {
    return Number(snap.montant_livraison);
  }
  return Number(livraison.commission_logistique ?? 0) + Number(livraison.montant_livreur ?? 0);
}

/** @deprecated — délègue au règlement post-livraison unifié. */
async function settleDeliveryFeesOnComplete(db, livraison) {
  if (!livraison?.sous_commande_id) {
    return { skipped: true, reason: 'sans_sous_commande' };
  }
  return settleSousCommandePayout(db, livraison.sous_commande_id, livraison);
}

async function getPortefeuilleSolde(db, utilisateurId) {
  const pf = await getOrCreatePortefeuille(db, utilisateurId);
  return Number(pf.solde ?? 0);
}

module.exports = {
  resolveGolivraPlatformUserId,
  getOrCreatePortefeuille,
  creditWallet,
  debitWallet,
  holdOrderPaymentInEscrow,
  creditVendorsOnOrderPaid,
  settleSousCommandePayout,
  settleDeliveryFeesOnComplete,
  resolveDeliveryCommissionPercent,
  getPortefeuilleSolde,
  getWalletDashboard,
  listTransactionsForUser,
  createWithdrawalRequest,
  listWithdrawalsAdmin,
  processWithdrawalAdmin,
  getPlatformWalletAdmin,
  MIN_RETRAIT_FCFA,
};
