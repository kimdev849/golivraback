const { createHttpError } = require('../utils/http');
const { onSousCommandeReady } = require('./dispatch.service');
const { formatAddressText, getAddressForUser } = require('./address.service');

/** Paiement client : Mobile Money uniquement (Airtel / MTN). */
const CLIENT_METHODE_PAIEMENT = new Set(['airtel_money', 'mtn_money']);

const ALLOWED_METHODE_PAIEMENT = new Set([
  ...CLIENT_METHODE_PAIEMENT,
  'especes',
  'mobile_money_autre',
  'carte_bancaire',
  'portefeuille_golivra',
]);

const { getPricingConfig, resolveDeliveryFeeForEstablishment } = require('./pricing.service');

function snapshotAddress(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const quartier = String(input.quartier || '').trim();
    const ligne1 = String(input.ligne1 || '').trim();
    const texte = formatAddressText({
      quartier,
      ligne1,
      point_reperes: input.point_reperes || null,
      instructions: input.instructions || null,
      ville: input.ville || 'Brazzaville',
      pays: input.pays || 'Congo',
    });
    return {
      version: 2,
      texte,
      quartier: quartier || null,
      ligne1: ligne1 || null,
      point_reperes: input.point_reperes || null,
      instructions: input.instructions || null,
      ville: input.ville || 'Brazzaville',
      pays: input.pays || 'Congo',
    };
  }
  const texte = String(input || '').trim();
  return { texte, version: 1 };
}

async function resolveDeliveryAddress(db, clientId, payload) {
  const { adresseLivraison, adresseLivraisonId, adresse: adresseStruct } = payload;

  if (adresseLivraisonId) {
    const row = await getAddressForUser(db, clientId, adresseLivraisonId);
    const snap = snapshotAddress({
      quartier: row.quartier,
      ligne1: row.ligne1,
      instructions: row.instructions,
      point_reperes: row.point_reperes,
      ville: row.ville,
      pays: row.pays,
    });
    return { snap, id: row.id, text: snap.texte };
  }

  if (adresseStruct && typeof adresseStruct === 'object') {
    const snap = snapshotAddress(adresseStruct);
    if (!snap.texte || snap.texte.length < 8) {
      throw createHttpError(400, 'Complétez le quartier et la description de livraison.');
    }
    return { snap, id: null, text: snap.texte };
  }

  const text = String(adresseLivraison || '').trim();
  if (text.length < 8) {
    throw createHttpError(400, 'Indiquez une adresse de livraison complète (quartier + description).');
  }
  const snap = snapshotAddress(text);
  return { snap, id: null, text: snap.texte };
}

async function resolveEstablishmentRow(db, enterpriseId, establishmentType) {
  if (establishmentType === 'restaurant') {
    const { data, error } = await db.from('restaurants').select('*').eq('id', enterpriseId).maybeSingle();
    if (error) throw error;
    return data ? { kind: 'restaurant', row: data } : null;
  }
  if (establishmentType === 'boutique') {
    const { data, error } = await db.from('boutiques').select('*').eq('id', enterpriseId).maybeSingle();
    if (error) throw error;
    return data ? { kind: 'boutique', row: data } : null;
  }
  return null;
}

/** Tous les commerces utilisent exclusivement le réseau livreurs GoLivra. */
function resolveModeLivraison(_establishmentRow) {
  return 'golivra';
}

async function buildLinesForSegment(db, kind, entrepriseId, articles) {
  const lines = [];
  let sousTotal = 0;

  for (const article of articles) {
    const { itemId, quantite, optionsChoisies } = article;
    const q = Math.max(1, Math.floor(Number(quantite)));
    if (!itemId) throw createHttpError(400, 'Chaque article doit avoir itemId');

    if (kind === 'restaurant') {
      const { data: plat, error: pErr } = await db.from('plats').select('*').eq('id', itemId).maybeSingle();
      if (pErr) throw pErr;
      if (!plat || plat.restaurant_id !== entrepriseId) {
        throw createHttpError(400, 'Plat invalide pour ce restaurant');
      }
      if (!plat.est_disponible) throw createHttpError(400, `Plat indisponible : ${plat.nom}`);
      const pu = Number(plat.prix_promo ?? plat.prix);
      const lineTot = q * pu;
      sousTotal += lineTot;
      lines.push({
        plat_id: plat.id,
        article_id: null,
        nom_produit: plat.nom,
        description_produit: plat.description,
        options_choisies: optionsChoisies ?? null,
        quantite: q,
        prix_unitaire: pu,
        sous_total: lineTot,
      });
    } else {
      const { data: art, error: aErr } = await db.from('articles').select('*').eq('id', itemId).maybeSingle();
      if (aErr) throw aErr;
      if (!art || art.boutique_id !== entrepriseId) {
        throw createHttpError(400, 'Article invalide pour cette boutique');
      }
      if (!art.est_disponible) throw createHttpError(400, `Article indisponible : ${art.nom}`);
      if (art.stock !== null && art.stock !== undefined && q > Number(art.stock)) {
        throw createHttpError(400, 'Stock insuffisant');
      }
      const pu = Number(art.prix_promo ?? art.prix);
      const lineTot = q * pu;
      sousTotal += lineTot;
      lines.push({
        plat_id: null,
        article_id: art.id,
        nom_produit: art.nom,
        description_produit: art.description,
        options_choisies: optionsChoisies ?? null,
        quantite: q,
        prix_unitaire: pu,
        sous_total: lineTot,
      });
      if (art.stock !== null && art.stock !== undefined) {
        await db
          .from('articles')
          .update({ stock: Math.max(0, Number(art.stock) - q) })
          .eq('id', art.id);
      }
    }
  }

  return { lines, sousTotal };
}

/**
 * Une commande parente + une sous-commande par commerce (panier multi-segments).
 */
async function createOrderFromPayload(db, clientId, payload) {
  const { methodePaiement, noteClient, segments, entrepriseId, establishmentType, articles } = payload;

  const { snap: addrSnap, id: adresseLivraisonId } = await resolveDeliveryAddress(db, clientId, payload);

  const methode = CLIENT_METHODE_PAIEMENT.has(methodePaiement) ? methodePaiement : 'airtel_money';

  let segmentList = segments;
  if (!Array.isArray(segmentList) || segmentList.length === 0) {
    if (!entrepriseId || !establishmentType || !articles) {
      throw createHttpError(400, 'Fournissez segments[] ou entrepriseId + articles.');
    }
    segmentList = [{ entrepriseId, establishmentType, articles }];
  }

  const pricingConfig = await getPricingConfig(db);

  const prepared = [];
  let orderSubtotal = 0;
  let deliveryTotal = 0;

  for (const seg of segmentList) {
    const { entrepriseId: eid, establishmentType: etype, articles: segArticles } = seg;
    if (!eid || !etype || !Array.isArray(segArticles) || segArticles.length === 0) {
      throw createHttpError(400, 'Chaque segment doit avoir entrepriseId, establishmentType et articles.');
    }
    const resolved = await resolveEstablishmentRow(db, eid, etype);
    if (!resolved) throw createHttpError(404, `Commerce introuvable : ${eid}`);
    const { kind, row: ent } = resolved;
    if (ent.statut !== 'active') {
      throw createHttpError(403, `${ent.nom || 'Commerce'} : validation en cours.`);
    }
    if (ent.est_ouvert !== true) {
      throw createHttpError(403, `${ent.nom || 'Commerce'} : temporairement fermé.`);
    }

    const mode = resolveModeLivraison(ent);
    const { lines, sousTotal } = await buildLinesForSegment(db, kind, eid, segArticles);
    const frais =
      mode === 'golivra' ? await resolveDeliveryFeeForEstablishment(db, ent) : 0;
    const total = sousTotal + frais;

    orderSubtotal += sousTotal;
    deliveryTotal += frais;

    prepared.push({
      kind,
      eid,
      mode,
      lines,
      sousTotal,
      frais,
      total,
    });
  }

  const orderTotal = orderSubtotal + deliveryTotal;

  const { data: commande, error: cErr } = await db
    .from('commandes')
    .insert({
      client_id: clientId,
      adresse_livraison_id: adresseLivraisonId,
      adresse_livraison_snapshot: addrSnap,
      statut: 'en_attente',
      sous_total: orderSubtotal,
      frais_livraison_total: deliveryTotal,
      remise_totale: 0,
      total: orderTotal,
      methode_paiement: methode,
      note_client: noteClient || null,
    })
    .select('*')
    .single();
  if (cErr) throw cErr;

  const sousCommandes = [];
  for (const p of prepared) {
    const scPayload = {
      commande_id: commande.id,
      statut: 'en_attente',
      mode_livraison: p.mode,
      sous_total: p.sousTotal,
      frais_livraison: p.frais,
      remise: 0,
      total: p.total,
      commission_pct: 0,
      commission_ttc: 0,
      montant_etablissement: p.sousTotal,
    };
    if (p.kind === 'restaurant') scPayload.restaurant_id = p.eid;
    else scPayload.boutique_id = p.eid;

    const { data: sous, error: sErr } = await db.from('sous_commandes').insert(scPayload).select('*').single();
    if (sErr) throw sErr;

    const itemRows = p.lines.map((l) => ({
      sous_commande_id: sous.id,
      ...l,
    }));
    const { error: iErr } = await db.from('sous_commande_items').insert(itemRows);
    if (iErr) throw iErr;

    sousCommandes.push(sous);
  }

  await db.from('paiements').insert({
    commande_id: commande.id,
    utilisateur_id: clientId,
    montant: orderTotal,
    methode,
    statut: 'en_attente',
    metadata: {
      mode: String(process.env.PAYMENT_MODE || 'test'),
      frais_livraison_fcfa: deliveryTotal,
      ventes_sans_commission_golivra: true,
      split_livraison: {
        delivery_logistics_percent: pricingConfig.delivery_logistics_percent,
        delivery_platform_percent: pricingConfig.delivery_platform_percent,
      },
    },
  });

  return { commande, sousCommandes };
}

async function syncCommandeStatutFromSousCommandes(db, commandeId) {
  const { data: scs, error } = await db.from('sous_commandes').select('statut').eq('commande_id', commandeId);
  if (error) throw error;
  const list = scs || [];
  if (list.length === 0) return;

  const statuts = list.map((s) => s.statut);
  let next = 'en_attente';

  if (statuts.every((s) => s === 'livree')) next = 'livree';
  else if (statuts.every((s) => s === 'annulee' || s === 'refusee')) next = 'annulee';
  else if (statuts.some((s) => s === 'livree')) next = 'partiellement_livree';
  else if (statuts.some((s) => s === 'collectee' || s === 'prete')) next = 'en_livraison';
  else if (statuts.some((s) => s === 'en_preparation')) next = 'en_preparation';
  else if (statuts.every((s) => s === 'acceptee')) next = 'acceptee';
  else if (statuts.some((s) => s === 'acceptee')) next = 'partiellement_acceptee';

  const patch = { statut: next, updated_at: new Date().toISOString() };
  if (next === 'livree') patch.livree_at = new Date().toISOString();

  await db.from('commandes').update(patch).eq('id', commandeId);
}

async function updateSousCommandeStatut(db, sousCommandeId, statut, extra = {}) {
  const { data: sc, error: scErr } = await db
    .from('sous_commandes')
    .select('*')
    .eq('id', sousCommandeId)
    .maybeSingle();
  if (scErr) throw scErr;
  if (!sc) throw createHttpError(404, 'Sous-commande introuvable');

  if (statut === 'acceptee' || statut === 'en_preparation' || statut === 'prete') {
    const { assertCommandePayee } = require('./payment.service');
    await assertCommandePayee(db, sc.commande_id);
  }

  const now = new Date().toISOString();
  const patch = { statut, updated_at: now, ...extra };

  if (statut === 'acceptee') {
    patch.acceptee_at = now;
  }
  if (statut === 'refusee') {
    patch.refusee_at = now;
    if (extra.raison_refus) patch.raison_refus = extra.raison_refus;
  }
  if (statut === 'prete') {
    patch.prete_at = now;
  }
  if (statut === 'collectee') {
    patch.collectee_at = now;
  }
  if (statut === 'livree') {
    patch.livree_at = now;
  }

  const { data: updated, error } = await db
    .from('sous_commandes')
    .update(patch)
    .eq('id', sousCommandeId)
    .select('*')
    .single();
  if (error || !updated) throw createHttpError(404, 'Sous-commande introuvable');

  if (statut === 'prete' && (sc.mode_livraison || 'golivra') === 'golivra') {
    await onSousCommandeReady(db, sousCommandeId);
  }

  await syncCommandeStatutFromSousCommandes(db, sc.commande_id);
  return updated;
}

function mapSousStatutToVendor(statut) {
  switch (statut) {
    case 'en_attente':
      return 'en_attente';
    case 'acceptee':
      return 'a_preparer';
    case 'en_preparation':
      return 'en_preparation';
    case 'prete':
      return 'prete';
    case 'collectee':
      return 'en_livraison';
    case 'livree':
      return 'livree';
    case 'annulee':
    case 'refusee':
    case 'remboursee':
      return 'annulee';
    default:
      return 'en_attente';
  }
}

module.exports = {
  CLIENT_METHODE_PAIEMENT,
  snapshotAddress,
  resolveEstablishmentRow,
  resolveModeLivraison,
  createOrderFromPayload,
  updateSousCommandeStatut,
  syncCommandeStatutFromSousCommandes,
  mapSousStatutToVendor,
};
