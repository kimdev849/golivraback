const { createHttpError } = require('../utils/http');
const { formatAddressText } = require('./address.service');
const { resolveDeliveryFeeForEstablishment, getPricingConfig, splitDeliveryFee } = require('./pricing.service');

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
  const cols = 'id, nom, adresse_ligne1, adresse_quartier, adresse_ville, frais_livraison';
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
    livreur_id: liv.livreur_id,
    created_at: liv.created_at,
    attribuee_at: liv.attribuee_at,
    livree_at: liv.livree_at,
  };
}

/**
 * Livraison directe créée par un commerce — le commerce est payeur de la livraison.
 */
async function createExternalDelivery(db, userId, payload) {
  const {
    establishmentId,
    establishmentType,
    clientNom,
    clientTelephone,
    note,
    methodePaiement,
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

  await assertVendorOwnsEstablishment(db, userId, establishmentId, establishmentType);
  const { row: est } = await loadEstablishmentPickup(db, establishmentId, establishmentType);

  const livraisonSnap = deliverySnapshotFromPayload(payload);
  if (!livraisonSnap?.texte) {
    throw createHttpError(400, 'Adresse de livraison invalide.');
  }

  const fraisLivraison = await resolveDeliveryFeeForEstablishment(db, est);
  const config = await getPricingConfig(db);
  const deliverySplit = splitDeliveryFee(fraisLivraison, config);
  livraisonSnap.payeur_type = 'commerce';
  livraisonSnap.createur_type = 'commerce';
  livraisonSnap.createur_utilisateur_id = userId;
  livraisonSnap.montant_livraison = fraisLivraison;
  livraisonSnap.methode_paiement = methodePaiement || null;

  const insertRow = {
    type_livraison: 'externe',
    sous_commande_id: null,
    restaurant_id: establishmentType === 'restaurant' ? establishmentId : null,
    boutique_id: establishmentType === 'boutique' ? establishmentId : null,
    client_nom: String(clientNom).trim(),
    client_telephone: String(clientTelephone).trim(),
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

  const { notifyAvailableCouriersForDelivery } = require('./notification.service');
  await notifyAvailableCouriersForDelivery(db, created.id).catch(() => {});

  const { data: refreshed } = await db.from('livraisons').select('*').eq('id', created.id).maybeSingle();

  return mapDirectDeliveryRow(refreshed || created, est.nom);
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
  getOwnedEstablishmentIds,
  deliverySnapshotFromPayload,
  collecteSnapshotFromEstablishment,
  mapDirectDeliveryRow,
};
