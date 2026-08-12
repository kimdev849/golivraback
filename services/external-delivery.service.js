const { createHttpError } = require('../utils/http');
const { formatAddressText } = require('./address.service');
const { resolveDeliveryFeeForEstablishment, getPricingConfig, splitDeliveryFee } = require('./pricing.service');
const { resolveDeliveryPriceForQuartier } = require('./zones.service');
const pawapay = require('../payments/services/pawapay.service');

function snapshotFromText(text) {
  const t = String(text || '').trim();
  return t ? { texte: t, version: 1 } : null;
}

function deliverySnapshotFromPayload(body) {
  const structured = body.adresse && typeof body.adresse === 'object' && !Array.isArray(body.adresse);
  if (structured) {
    const quartier = String(body.adresse.quartier || '').trim();
    const ligne1 = String(body.adresse.ligne1 || '').trim();
    if (!quartier || ligne1.length < 4) {
      throw createHttpError(400, 'Quartier et adresse détaillée obligatoires.');
    }
    // Rejet des adresses de test absurdes (« @##fff », « 555@#$$kk » …).
    const { requireValid, validateAddress } = require('../lib/validators');
    requireValid(ligne1, (v) => validateAddress(v, true), 'adresse.ligne1');
    const texte = formatAddressText({
      quartier,
      ligne1,
      point_reperes: body.adresse.point_reperes,
      instructions: body.adresse.instructions,
      ville: body.adresse.ville || 'Brazzaville',
      pays: body.adresse.pays || 'Congo',
    });
    return {
      version: 2,
      texte,
      quartier,
      ligne1,
      point_reperes: body.adresse.point_reperes || null,
      instructions: body.adresse.instructions || null,
      ville: body.adresse.ville || 'Brazzaville',
      pays: body.adresse.pays || 'Congo',
    };
  }
  const text = String(body.adresseText || body.adresse || '').trim();
  if (text.length < 8) {
    throw createHttpError(400, 'Adresse de livraison incomplète (quartier + description).');
  }
  return snapshotFromText(text);
}

function collecteSnapshotFromEstablishment(est) {
  const parts = [
    est.nom,
    est.adresse_quartier,
    est.adresse_ligne1,
    est.adresse_ville || 'Brazzaville',
  ].filter(Boolean);
  const texte = parts.join(' · ');
  if (!texte) return null;
  return {
    version: 2,
    texte,
    quartier: est.adresse_quartier || null,
    ligne1: est.adresse_ligne1 || null,
    ville: est.adresse_ville || 'Brazzaville',
    pays: 'Congo',
  };
}

async function getOwnedEstablishmentIds(db, userId) {
  const [rRes, bRes] = await Promise.all([
    db.from('restaurants').select('id').eq('proprietaire_id', userId),
    db.from('boutiques').select('id').eq('proprietaire_id', userId),
  ]);
  if (rRes.error) throw rRes.error;
  if (bRes.error) throw bRes.error;
  return {
    restaurantIds: (rRes.data || []).map((r) => r.id),
    boutiqueIds: (bRes.data || []).map((b) => b.id),
  };
}

async function assertVendorOwnsEstablishment(db, userId, establishmentId, establishmentType) {
  const { restaurantIds, boutiqueIds } = await getOwnedEstablishmentIds(db, userId);
  if (establishmentType === 'restaurant') {
    if (!restaurantIds.includes(establishmentId)) {
      throw createHttpError(403, 'Établissement non autorisé.');
    }
    return;
  }
  if (establishmentType === 'boutique') {
    if (!boutiqueIds.includes(establishmentId)) {
      throw createHttpError(403, 'Établissement non autorisé.');
    }
    return;
  }
  throw createHttpError(400, 'establishmentType invalide (restaurant | boutique).');
}

async function loadEstablishmentPickup(db, establishmentId, establishmentType) {
  const cols = 'id, nom, telephone, adresse_ligne1, adresse_quartier, adresse_ville, frais_livraison';
  if (establishmentType === 'restaurant') {
    const { data, error } = await db.from('restaurants').select(cols).eq('id', establishmentId).maybeSingle();
    if (error) throw error;
    if (!data) throw createHttpError(404, 'Restaurant introuvable.');
    return { kind: 'restaurant', row: data };
  }
  const { data, error } = await db.from('boutiques').select(cols).eq('id', establishmentId).maybeSingle();
  if (error) throw error;
  if (!data) throw createHttpError(404, 'Boutique introuvable.');
  return { kind: 'boutique', row: data };
}

function mapDirectDeliveryRow(liv, establishmentNom) {
  const livSnap = liv.adresse_livraison_snapshot;
  let adresse = '';
  if (livSnap && typeof livSnap === 'object' && livSnap.texte) adresse = String(livSnap.texte);
  else if (typeof livSnap === 'string') adresse = livSnap;

  const payeurSnap = livSnap && typeof livSnap === 'object' ? livSnap : {};

  return {
    id: liv.id,
    source: 'externe',
    type_livraison: 'externe',
    statut: liv.statut,
    client_nom: liv.client_nom,
    client_telephone: liv.client_telephone,
    adresse,
    montant_total: liv.montant_total != null ? Number(liv.montant_total) : null,
    montant_livraison: payeurSnap.montant_livraison ?? liv.montant_livreur ?? null,
    payeur_type: payeurSnap.payeur_type ?? null,
    note: liv.note ?? null,
    establishment_nom: establishmentNom,
    paiement_statut: payeurSnap.paiement_statut ?? null,
    paiement_deposit_id: payeurSnap.paiement_deposit_id ?? null,
    methode_paiement: payeurSnap.methode_paiement ?? liv.methode_paiement ?? null,
    paye_at: payeurSnap.paye_at ?? null,
    livreur_id: liv.livreur_id,
    created_at: liv.created_at,
    attribuee_at: liv.attribuee_at,
    livree_at: liv.livree_at,
  };
}

/**
 * Livraison directe créée par un commerce — le commerce paie les frais
 * (Mobile Money) AVANT que la course ne soit ouverte aux livreurs.
 *  - prix calculé selon la ZONE / l'arrondissement de livraison choisi ;
 *  - dépôt PawaPay initié sur le téléphone du commerce ;
 *  - mode test/simulation → paiement validé immédiatement ; live → confirmé
 *    par le webhook PawaPay (l'app suit le statut via /payment-status).
 */
async function createExternalDelivery(db, userId, payload) {
  const {
    establishmentId,
    establishmentType,
    clientNom,
    clientTelephone,
    note,
    methodePaiement,
    telephonePaiement,
  } = payload;

  if (!establishmentId || !establishmentType) {
    throw createHttpError(400, 'establishmentId et establishmentType sont requis.');
  }
  if (!clientNom || !String(clientNom).trim()) {
    throw createHttpError(400, 'Le nom du client est requis.');
  }
  if (!clientTelephone || !String(clientTelephone).trim()) {
    throw createHttpError(400, 'Le téléphone du client est requis.');
  }
  // Validation stricte du numéro (E.164 Congo) : un numéro invalide ou trop
  // long ne doit pas permettre de créer une livraison.
  const { requireValid, validatePhoneCg } = require('../lib/validators');
  const clientTelephoneClean = requireValid(
    String(clientTelephone).trim(),
    validatePhoneCg,
    'clientTelephone',
  );
  if (methodePaiement !== 'mtn_money' && methodePaiement !== 'airtel_money') {
    throw createHttpError(400, 'Choisissez une méthode de paiement (Airtel Money ou MTN MoMo).');
  }

  await assertVendorOwnsEstablishment(db, userId, establishmentId, establishmentType);
  const { row: est } = await loadEstablishmentPickup(db, establishmentId, establishmentType);

  const livraisonSnap = deliverySnapshotFromPayload(payload);
  if (!livraisonSnap?.texte) {
    throw createHttpError(400, 'Adresse de livraison invalide.');
  }

  // Prix selon la ZONE / l'arrondissement de livraison (fallback : frais du commerce).
  let fraisLivraison = null;
  try {
    const zonePrice = await resolveDeliveryPriceForQuartier(db, livraisonSnap.quartier || null);
    if (zonePrice?.price_fcfa != null && zonePrice.price_fcfa > 0) {
      fraisLivraison = Math.round(zonePrice.price_fcfa);
    }
  } catch {
    fraisLivraison = null;
  }
  if (fraisLivraison == null || fraisLivraison <= 0) {
    fraisLivraison = await resolveDeliveryFeeForEstablishment(db, est);
  }

  const config = await getPricingConfig(db);
  const deliverySplit = splitDeliveryFee(fraisLivraison, config);

  // ── Paiement Mobile Money (PawaPay) sur le téléphone du commerce ──────────
  const numeroCompte = String(telephonePaiement || est.telephone || '').trim();
  if (!numeroCompte) {
    throw createHttpError(400, 'Téléphone de paiement du commerce introuvable.');
  }
  const depositId = newDepositId();
  const deposit = await pawapay.initiateDeposit({
    depositId,
    montantFcfa: fraisLivraison,
    currency: 'XAF',
    methode: methodePaiement,
    numeroCompte,
    pays: 'CG',
  });
  if (!deposit.ok) {
    throw createHttpError(502, 'Paiement indisponible pour le moment. Réessayez.');
  }
  // Test / simulation → validé immédiatement ; live → confirmé par webhook.
  const paiementStatut = deposit.simulated ? 'valide' : 'en_attente';

  livraisonSnap.payeur_type = 'commerce';
  livraisonSnap.createur_type = 'commerce';
  livraisonSnap.createur_utilisateur_id = userId;
  livraisonSnap.montant_livraison = fraisLivraison;
  livraisonSnap.methode_paiement = methodePaiement;
  livraisonSnap.telephone_paiement = numeroCompte;
  livraisonSnap.paiement_deposit_id = depositId;
  livraisonSnap.paiement_statut = paiementStatut;
  if (paiementStatut === 'valide') livraisonSnap.paye_at = new Date().toISOString();

  const insertRow = {
    type_livraison: 'externe',
    sous_commande_id: null,
    restaurant_id: establishmentType === 'restaurant' ? establishmentId : null,
    boutique_id: establishmentType === 'boutique' ? establishmentId : null,
    client_nom: String(clientNom).trim(),
    client_telephone: clientTelephoneClean,
    montant_total: fraisLivraison,
    note: note ? String(note).trim() : null,
    statut: 'en_attente',
    adresse_collecte_snapshot: collecteSnapshotFromEstablishment(est),
    adresse_livraison_snapshot: livraisonSnap,
    latitude_collecte: null,
    longitude_collecte: null,
    latitude_livraison: null,
    longitude_livraison: null,
    montant_livreur: 0,
    commission_logistique: deliverySplit.logistics,
    livreur_id: null,
    entreprise_logistique_id: null,
  };

  const { data: created, error } = await db.from('livraisons').insert(insertRow).select('*').single();
  if (error) throw error;

  const { data: refreshed } = await db
    .from('livraisons')
    .select('*')
    .eq('id', created.id)
    .maybeSingle();
  const livraison = mapDirectDeliveryRow(refreshed || created, est.nom);

  // La course n'est ouverte aux livreurs qu'une fois le paiement confirmé.
  if (paiementStatut === 'valide') {
    await confirmExternalDeliveryPayment(db, created.id).catch(() => {});
  }

  const { notifyAllAdmins } = require('./admin-notify.service');
  await notifyAllAdmins(db, {
    type: 'livraison_externe',
    titre: 'Nouvelle livraison externe',
    corps: `Le commerce « ${est.nom} » a créé une livraison pour ${String(clientNom).trim()}.`,
    data: { livraison_id: created.id, action: 'open_delivery' },
  }).catch(() => undefined);

  return {
    livraison,
    paiement: {
      depositId,
      simulation: deposit.simulated === true,
      statut: paiementStatut,
      montant_fcfa: fraisLivraison,
      methode: methodePaiement,
    },
  };
}

function newDepositId() {
  return `dp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function findEstablishmentOwnerId(db, liv) {
  const table = liv.restaurant_id ? 'restaurants' : 'boutiques';
  const id = liv.restaurant_id || liv.boutique_id;
  if (!id) return null;
  const { data } = await db.from(table).select('proprietaire_id').eq('id', id).maybeSingle();
  return data?.proprietaire_id || null;
}

/**
 * Confirme le paiement d'une livraison externe puis ouvre la course aux
 * livreurs disponibles et prévient le commerce.
 * Appelé en mode test (simulation) à la création, et par le webhook PawaPay en live.
 */
async function confirmExternalDeliveryPayment(db, deliveryId, { depositId } = {}) {
  const { data: liv, error } = await db
    .from('livraisons')
    .select('*')
    .eq('id', deliveryId)
    .maybeSingle();
  if (error) throw error;
  if (!liv) throw createHttpError(404, 'Livraison introuvable.');

  const snap =
    liv.adresse_livraison_snapshot && typeof liv.adresse_livraison_snapshot === 'object'
      ? { ...liv.adresse_livraison_snapshot }
      : {};
  if (snap.paiement_statut === 'valide') return liv;
  snap.paiement_statut = 'valide';
  snap.paye_at = snap.paye_at || new Date().toISOString();
  if (depositId) snap.paiement_deposit_id = snap.paiement_deposit_id || depositId;

  const { error: upErr } = await db
    .from('livraisons')
    .update({ adresse_livraison_snapshot: snap, updated_at: new Date().toISOString() })
    .eq('id', deliveryId);
  if (upErr) throw upErr;

  // Course ouverte aux livreurs disponibles.
  const { notifyAvailableCouriersForDelivery } = require('./notification.service');
  await notifyAvailableCouriersForDelivery(db, deliveryId).catch(() => {});

  // Le commerce est prévenu : paiement confirmé → un livreur va venir.
  const ownerId = await findEstablishmentOwnerId(db, liv);
  if (ownerId) {
    const { notifyUserSafe } = require('./notification.service');
    await notifyUserSafe(db, {
      utilisateurId: ownerId,
      type: 'livraison_statut',
      titre: 'Paiement confirmé 🎉',
      corps: 'Votre livraison est payée : un livreur est contacté pour la récupérer.',
      data: { livraison_id: deliveryId, action: 'open_delivery' },
    }).catch(() => {});
  }

  return liv;
}

/** Marque le paiement d'une livraison externe comme échoué (webhook PawaPay). */
async function markExternalDeliveryPaymentFailed(db, deliveryId, reason) {
  const { data: liv, error } = await db
    .from('livraisons')
    .select('*')
    .eq('id', deliveryId)
    .maybeSingle();
  if (error) throw error;
  if (!liv) return null;
  const snap =
    liv.adresse_livraison_snapshot && typeof liv.adresse_livraison_snapshot === 'object'
      ? { ...liv.adresse_livraison_snapshot }
      : {};
  snap.paiement_statut = 'echoue';
  snap.paiement_echec_motif = reason || null;
  const { error: upErr } = await db
    .from('livraisons')
    .update({ adresse_livraison_snapshot: snap, updated_at: new Date().toISOString() })
    .eq('id', deliveryId);
  if (upErr) throw upErr;
  return liv;
}

/** Retrouve une livraison externe par son identifiant de dépôt PawaPay. */
async function findLivraisonByDepositId(db, depositId) {
  if (!depositId) return null;
  const { data, error } = await db
    .from('livraisons')
    .select('*')
    .eq('type_livraison', 'externe')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  for (const liv of data || []) {
    const snap =
      liv.adresse_livraison_snapshot && typeof liv.adresse_livraison_snapshot === 'object'
        ? liv.adresse_livraison_snapshot
        : {};
    if (snap.paiement_deposit_id === depositId) return liv;
  }
  return null;
}

/** Statut de paiement d'une livraison externe (pour le suivi côté app). */
async function getExternalDeliveryPaymentStatus(db, deliveryId) {
  const { data: liv, error } = await db
    .from('livraisons')
    .select('*')
    .eq('id', deliveryId)
    .maybeSingle();
  if (error) throw error;
  if (!liv) throw createHttpError(404, 'Livraison introuvable.');
  const snap =
    liv.adresse_livraison_snapshot && typeof liv.adresse_livraison_snapshot === 'object'
      ? liv.adresse_livraison_snapshot
      : {};
  return {
    livraison_id: liv.id,
    statut: snap.paiement_statut || 'en_attente',
    methode: snap.methode_paiement || null,
    montant_fcfa: liv.montant_total != null ? Number(liv.montant_total) : null,
    paye_at: snap.paye_at || null,
  };
}

async function listVendorExternalDeliveries(db, userId, { activeOnly = true } = {}) {
  const { restaurantIds, boutiqueIds } = await getOwnedEstablishmentIds(db, userId);
  if (restaurantIds.length === 0 && boutiqueIds.length === 0) return [];

  let query = db
    .from('livraisons')
    .select('*')
    .eq('type_livraison', 'externe')
    .order('created_at', { ascending: false })
    .limit(100);

  if (restaurantIds.length > 0 && boutiqueIds.length > 0) {
    query = query.or(
      `restaurant_id.in.(${restaurantIds.join(',')}),boutique_id.in.(${boutiqueIds.join(',')})`,
    );
  } else if (restaurantIds.length > 0) {
    query = query.in('restaurant_id', restaurantIds);
  } else {
    query = query.in('boutique_id', boutiqueIds);
  }

  if (activeOnly) {
    query = query.in('statut', ['en_attente', 'attribuee', 'en_collecte', 'collectee', 'en_route']);
  }

  const { data: livraisons, error } = await query;
  if (error) throw error;

  const rows = livraisons || [];
  const out = [];

  for (const liv of rows) {
    let establishmentNom = '';
    if (liv.restaurant_id) {
      const { data: r } = await db.from('restaurants').select('nom').eq('id', liv.restaurant_id).maybeSingle();
      establishmentNom = r?.nom || '';
    } else if (liv.boutique_id) {
      const { data: b } = await db.from('boutiques').select('nom').eq('id', liv.boutique_id).maybeSingle();
      establishmentNom = b?.nom || '';
    }

    let livreur = null;
    if (liv.livreur_id) {
      const { data: livreurRow } = await db
        .from('livreurs')
        .select('utilisateur_id')
        .eq('id', liv.livreur_id)
        .maybeSingle();
      if (livreurRow?.utilisateur_id) {
        const { data: u } = await db
          .from('utilisateurs')
          .select('nom, telephone')
          .eq('id', livreurRow.utilisateur_id)
          .maybeSingle();
        if (u) livreur = { nom: u.nom || 'Livreur', tel: u.telephone || '' };
      }
    }

    out.push({
      ...mapDirectDeliveryRow(liv, establishmentNom),
      livreur: livreur || undefined,
    });
  }

  return out;
}

module.exports = {
  createExternalDelivery,
  listVendorExternalDeliveries,
  confirmExternalDeliveryPayment,
  markExternalDeliveryPaymentFailed,
  findLivraisonByDepositId,
  getExternalDeliveryPaymentStatus,
  getOwnedEstablishmentIds,
  deliverySnapshotFromPayload,
  collecteSnapshotFromEstablishment,
  mapDirectDeliveryRow,
};
