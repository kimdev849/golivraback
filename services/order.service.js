const { createHttpError } = require('../utils/http');
const { onSousCommandeReady } = require('./dispatch.service');
const { formatAddressText, getAddressForUser } = require('./address.service');

/** Paiement client : Mobile Money uniquement (Airtel / MTN). */
const CLIENT_METHODE_PAIEMENT = new Set(['airtel_money', 'mtn_money']);

/**
 * Nouveau parcours « paiement après acceptation » :
 *   - ACCEPTANCE_LIMIT_MIN : le commerce a 5 min pour accepter/refuser
 *     (rappel envoyé à 3 min par le job d'expiration) ;
 *   - PAYMENT_LIMIT_MIN : une fois les réponses réunies, le client a 5 min
 *     pour payer les segments acceptés, sinon la commande est annulée.
 */
const ACCEPTANCE_LIMIT_MIN = 5;
const PAYMENT_LIMIT_MIN = 5;

/** Statuts d'une sous-commande qui restent payables après acceptation. */
const PAYABLE_SC_STATUTS = new Set([
  'acceptee',
  'en_preparation',
  'prete',
  'collectee',
  'livree',
]);

const ALLOWED_METHODE_PAIEMENT = new Set([
  ...CLIENT_METHODE_PAIEMENT,
  'especes',
  'mobile_money_autre',
  'carte_bancaire',
  'portefeuille_golivra',
]);

const { getPricingConfig, resolveDeliveryFeeForEstablishment } = require('./pricing.service');
const { resolveDeliveryPriceForQuartier } = require('./zones.service');

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
    const snap = {
      version: 2,
      texte,
      quartier: quartier || null,
      ligne1: ligne1 || null,
      point_reperes: input.point_reperes || null,
      instructions: input.instructions || null,
      ville: input.ville || 'Brazzaville',
      pays: input.pays || 'Congo',
    };
    // Coordonnées GPS de l'adresse (si connues — jamais géocodées, juste les
    // coordonnées que le client a déjà enregistrées) : elles permettent au
    // client de suivre la distance du livreur jusqu'à son adresse.
    const lat = Number(input.latitude);
    const lng = Number(input.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      snap.latitude = Number(lat.toFixed(8));
      snap.longitude = Number(lng.toFixed(8));
    }
    return snap;
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
      latitude: row.latitude,
      longitude: row.longitude,
    });
    return { snap, id: row.id, text: snap.texte };
  }

  if (adresseStruct && typeof adresseStruct === 'object') {
    // Rejet des adresses de test absurdes (« @##fff », « 555@#$$kk » …),
    // miroir de `deliveryAddressError` côté mobile. L'adresse détaillée est
    // obligatoire (un quartier seul ne suffit pas).
    const ligne1 = String(adresseStruct.ligne1 || '').trim();
    if (!ligne1) {
      throw createHttpError(400, 'Indiquez une adresse détaillée de livraison.');
    }
    const { requireValid, validateAddress, validateLandmark } = require('../lib/validators');
    requireValid(ligne1, (v) => validateAddress(v, true), 'adresse.ligne1');
    // Point de repère / Instructions livreur (optionnels) : mêmes règles
    // anti-poubelle que côté mobile (« @#####^ », « !!! » refusés).
    const pointReperesRaw = String(adresseStruct.point_reperes || '').trim();
    if (pointReperesRaw) requireValid(pointReperesRaw, validateLandmark, 'adresse.point_reperes');
    const instructionsRaw = String(adresseStruct.instructions || '').trim();
    if (instructionsRaw) requireValid(instructionsRaw, validateLandmark, 'adresse.instructions');
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

/**
 * Temps de préparation (min) d'un commerce, cohérent avec l'app
 * (lib/pricing.ts enterprisePrepMinutes) : restaurant → delai_preparation_min
 * (défaut 20), boutique → delai_livraison_min (défaut 30). Borné 5–180.
 */
function establishmentPrepMinutes(row, kind) {
  const fallback = kind === 'restaurant' ? 20 : 30;
  const raw = kind === 'restaurant' ? row?.delai_preparation_min : row?.delai_livraison_min;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(n, 5), 180);
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

/** Quantité maximale par article dans une commande (anti-valeurs absurdes). */
const MAX_LINE_QUANTITE = 999;

/**
 * Valide strictement la quantité d'une ligne de commande : entier positif,
 * fini (pas de NaN / Infinity), borné. Le client ne doit pas pouvoir injecter
 * `NaN`, `Infinity`, des négatifs ou des décimaux : on refuse avec une 400 au
 * lieu de corriger silencieusement (sinon des totaux NaN entreraient en base).
 */
function parseLineQuantite(quantite) {
  const n = Number(quantite);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw createHttpError(400, 'Quantité invalide : entier positif attendu (minimum 1).');
  }
  if (n > MAX_LINE_QUANTITE) {
    throw createHttpError(400, `Quantité trop élevée (maximum ${MAX_LINE_QUANTITE} par article).`);
  }
  return n;
}

async function buildLinesForSegment(db, kind, entrepriseId, articles) {
  const lines = [];
  let sousTotal = 0;

  for (const article of articles) {
    const { itemId, quantite, optionsChoisies } = article;
    if (!itemId) throw createHttpError(400, 'Chaque article doit avoir itemId');
    const q = parseLineQuantite(quantite);

    if (kind === 'restaurant') {
      const { data: plat, error: pErr } = await db.from('plats').select('*').eq('id', itemId).maybeSingle();
      if (pErr) throw pErr;
      if (!plat || plat.restaurant_id !== entrepriseId) {
        throw createHttpError(400, 'Plat invalide pour ce restaurant');
      }
      if (!plat.est_disponible) throw createHttpError(400, `Plat indisponible : ${plat.nom}`);
      if (plat.stock !== null && plat.stock !== undefined && q > Number(plat.stock)) {
        throw createHttpError(400, 'Stock insuffisant');
      }
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
      if (plat.stock !== null && plat.stock !== undefined) {
        await db
          .from('plats')
          .update({ stock: Math.max(0, Number(plat.stock) - q) })
          .eq('id', plat.id);
      }
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
  const { methodePaiement, noteClient, segments, entrepriseId, establishmentType, articles, codePromo,
    clientTotal, clientSubtotal, clientDeliveryFee } =
    payload;

  const { snap: addrSnap, id: adresseLivraisonId } = await resolveDeliveryAddress(db, clientId, payload);

  let zonePricingMeta = null;
  const quartierLivraison = addrSnap?.quartier ? String(addrSnap.quartier).trim() : '';
  if (quartierLivraison) {
    try {
      const quote = await resolveDeliveryPriceForQuartier(db, quartierLivraison);
      zonePricingMeta = {
        quartier: quartierLivraison,
        price_fcfa: quote.price_fcfa,
        zone_id: quote.zone?.id ?? null,
        zone_name: quote.zone?.name ?? null,
        zone_label: quote.zone?.label ?? null,
      };
      addrSnap.zone_pricing = zonePricingMeta;
    } catch {
      /* tables zones absentes : repli sur tarif établissement */
    }
  }

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
    // NOTE: on ne vérifie PLUS ent.est_ouvert ici car c'est un snapshot
    // calculé au moment de la sauvegarde des horaires. Si le commerce a
    // sauvegardé ses horaires à 8h (fermé), est_ouvert=false même à 10h.
    // La source de vérité est assertEtablissementOuvert ci-dessous qui
    // vérifie les vrais horaires en live avec nowInBrazzaville().

    // Horaires d'ouverture (strict) + délai de préparation : la commande n'est
    // possible que si le commerce est ouvert ET que la préparation peut se
    // terminer avant la fermeture (ex. fermeture 23h, préparation 25 min →
    // dernière commande possible 22h35).
    const { assertEtablissementOuvert } = require('./horaires.service');
    const prepMinutes = establishmentPrepMinutes(ent, kind);
    await assertEtablissementOuvert(db, { kind, id: eid, nom: ent.nom || null, prepMinutes });

    const mode = resolveModeLivraison(ent);
    const { lines, sousTotal } = await buildLinesForSegment(db, kind, eid, segArticles);
    let frais = 0;
    if (mode === 'golivra') {
      // Priorité : frais par segment (cohérence panier → suivi → paiement).
      // Fallback : frais total global → zone pricing → tarif établissement.
      const segFee = typeof seg.deliveryFee === 'number' && seg.deliveryFee >= 0 && Number.isFinite(seg.deliveryFee)
        ? Math.round(seg.deliveryFee)
        : null;
      if (segFee != null) {
        frais = segFee;
      } else if (typeof clientDeliveryFee === 'number' && clientDeliveryFee >= 0 && Number.isFinite(clientDeliveryFee)) {
        frais = Math.round(clientDeliveryFee);
      } else if (zonePricingMeta?.price_fcfa != null) {
        frais = Math.round(Number(zonePricingMeta.price_fcfa));
      } else {
        frais = await resolveDeliveryFeeForEstablishment(db, ent);
      }
    }
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

  let remiseTotale = 0;
  let codePromoUtilise = null;
  let codePromoId = null;

  if (codePromo) {
    const { validatePromoCode } = require('./promo.service');
    const validated = await validatePromoCode(db, clientId, codePromo, {
      orderSubtotal,
      deliveryTotal,
      segments: segmentList.map((s) => ({
        entrepriseId: s.entrepriseId,
        establishmentType: s.establishmentType,
      })),
    });
    remiseTotale = validated.remise;
    codePromoUtilise = validated.code;
    codePromoId = validated.code_promo_id;
  }

  const orderTotal = Math.max(0, orderSubtotal + deliveryTotal - remiseTotale);

  const since = new Date(Date.now() - 90_000).toISOString();
  const { data: recentOrders, error: recentErr } = await db
    .from('commandes')
    .select('id, total, statut, created_at')
    .eq('client_id', clientId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(3);
  if (recentErr) throw recentErr;
  const duplicate = (recentOrders || []).find(
    (c) =>
      Number(c.total) === orderTotal &&
      ['en_attente', 'partiellement_acceptee', 'acceptee', 'en_preparation', 'prete'].includes(c.statut),
  );
  if (duplicate) {
    const { data: full, error: fullErr } = await db.from('commandes').select('*').eq('id', duplicate.id).single();
    if (fullErr) throw fullErr;
    const { data: scs, error: scErr } = await db.from('sous_commandes').select('*').eq('commande_id', duplicate.id);
    if (scErr) throw scErr;
    return { commande: full, sousCommandes: scs || [], dejaExistante: true };
  }

  // Le commerce a 5 minutes pour accepter la commande : passé ce délai, un
  // job expire la commande. Aucun paiement n'est pris avant l'acceptation.
  const acceptationLimite = new Date(Date.now() + ACCEPTANCE_LIMIT_MIN * 60 * 1000).toISOString();

  const { data: commande, error: cErr } = await db
    .from('commandes')
    .insert({
      client_id: clientId,
      adresse_livraison_id: adresseLivraisonId,
      adresse_livraison_snapshot: addrSnap,
      statut: 'en_attente',
      acceptation_limite_at: acceptationLimite,
      sous_total: orderSubtotal,
      frais_livraison_total: deliveryTotal,
      remise_totale: remiseTotale,
      code_promo_utilise: codePromoUtilise,
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

  if (codePromoId && remiseTotale > 0) {
    const { recordPromoUsage } = require('./promo.service');
    await recordPromoUsage(db, {
      codePromoId,
      utilisateurId: clientId,
      commandeId: commande.id,
      montantRemise: remiseTotale,
    });
    const { notifyPromoApplied } = require('./order-notify.service');
    await notifyPromoApplied(db, clientId, {
      code: codePromoUtilise,
      remise: remiseTotale,
      commandeId: commande.id,
    });
  }

  const { error: payInsertErr } = await db.from('paiements').insert({
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
  if (payInsertErr) throw payInsertErr;

  return { commande, sousCommandes };
}

async function syncCommandeStatutFromSousCommandes(db, commandeId) {
  const { data: scs, error } = await db.from('sous_commandes').select('statut').eq('commande_id', commandeId);
  if (error) throw error;
  const list = scs || [];
  if (list.length === 0) return;

  const statuts = list.map((s) => s.statut);
  let next = 'en_attente';

  // Toutes les sous-commandes ont expiré (non acceptées dans le délai) : la
  // commande est remboursée, c'est ce statut que voit le client.
  if (statuts.every((s) => s === 'remboursee')) next = 'remboursee';
  else if (statuts.every((s) => s === 'livree')) next = 'livree';
  // Toutes les sous-commandes sont à l'état terminal annulé (refusées, annulées
  // ou expirées/remboursées) → la commande est annulée (cas mixte inclus).
  else if (statuts.every((s) => s === 'annulee' || s === 'refusee' || s === 'remboursee')) next = 'annulee';
  else if (statuts.some((s) => s === 'livree')) next = 'partiellement_livree';
  // prete = commande prête pour le livreur (pas encore de livreur assigné)
  // collectee = livreur a récupéré le colis → en livraison vers le client
  else if (statuts.some((s) => s === 'collectee')) next = 'en_livraison';
  else if (statuts.some((s) => s === 'prete')) next = 'prete';
  else if (statuts.some((s) => s === 'en_preparation')) next = 'en_preparation';
  else if (statuts.every((s) => s === 'acceptee')) next = 'acceptee';
  else if (statuts.some((s) => s === 'acceptee')) next = 'partiellement_acceptee';

  const now = new Date().toISOString();
  const patch = { statut: next, updated_at: now };
  if (next === 'livree') patch.livree_at = now;
  if (next === 'remboursee') patch.expiree_at = now;

  // Délai de paiement du client : la commande est « prête à être payée » dès
  // que toutes les sous-commandes ont répondu (plus aucune en_attente) et
  // qu'au moins une est acceptée. On arme paiement_limite_at une seule fois,
  // tant que le paiement n'est pas encore validé (effacé par le webhook).
  let paiementLimiteArme = false;
  if (
    (next === 'acceptee' || next === 'partiellement_acceptee') &&
    !statuts.includes('en_attente') &&
    statuts.some((s) => PAYABLE_SC_STATUTS.has(s))
  ) {
    const { data: p } = await db
      .from('paiements')
      .select('statut')
      .eq('commande_id', commandeId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const { data: cur } = await db
      .from('commandes')
      .select('paiement_limite_at')
      .eq('id', commandeId)
      .maybeSingle();
    if (p?.statut !== 'valide' && cur && !cur.paiement_limite_at) {
      patch.paiement_limite_at = new Date(
        Date.now() + PAYMENT_LIMIT_MIN * 60 * 1000,
      ).toISOString();
      paiementLimiteArme = true;
    }
  }

  await db.from('commandes').update(patch).eq('id', commandeId);

  // La commande vient de devenir payable : notification « Paiement requis »
  // au client + dépôt Mobile Money initié automatiquement (test inclus).
  // Le client n'a plus qu'à valider la demande sur son téléphone.
  if (paiementLimiteArme) {
    await onCommandeDevenuePayable(db, commandeId).catch((err) =>
      console.warn('[order] paiement auto', commandeId, err?.message || err),
    );
  }
}

/**
 * La commande est payable (toutes les réponses réunies, au moins un commerce
 * accepté) : on prévient le client (« Paiement requis — 5 min ») et on
 * déclenche automatiquement le dépôt Mobile Money vers son numéro enregistré.
 */
async function onCommandeDevenuePayable(db, commandeId) {
  const { data: commande } = await db
    .from('commandes')
    .select('id, client_id, total')
    .eq('id', commandeId)
    .maybeSingle();
  if (!commande) return;

  const newPaymentService = require('../payments/services/payment.service');
  let montant = 0;
  try {
    montant = await newPaymentService.computePayableAmount(db, commande);
  } catch {
    montant = 0;
  }

  const { notifyPaymentRequired } = require('./order-notify.service');
  await notifyPaymentRequired(db, commandeId, commande.client_id, montant).catch((err) =>
    console.warn('[notify] paiement requis', err?.message || err),
  );

  const auto = await newPaymentService.autoInitiatePaymentIfReady(db, commandeId).catch((err) => {
    console.warn('[payment] auto-initiation', commandeId, err?.message || err);
    return null;
  });

  // Mode test / simulation : le paiement passe directement à « valide » (aucun
  // webhook). On notifie la confirmation ici ; en live le dépôt reste
  // « en_attente » et c'est le webhook PawaPay qui confirme puis notifie.
  if (auto?.result?.paiement?.statut === 'valide') {
    const { notifyPaymentConfirmed } = require('./order-notify.service');
    await notifyPaymentConfirmed(db, commandeId, commande.client_id).catch((err) =>
      console.warn('[notify] paiement confirmé (auto)', err?.message || err),
    );
  }
}

async function updateSousCommandeStatut(db, sousCommandeId, statut, extra = {}) {
  const { data: sc, error: scErr } = await db
    .from('sous_commandes')
    .select('*')
    .eq('id', sousCommandeId)
    .maybeSingle();
  if (scErr) throw scErr;
  if (!sc) throw createHttpError(404, 'Commande introuvable');

  // Nouveau parcours « paiement après acceptation » :
  //  - L'acceptation ET la préparation ne requièrent PAS de paiement validé.
  //    Le restaurant peut accepter et préparer la commande pendant que le
  //    client reçoit la demande de paiement Mobile Money.
  //  - La transition vers « prete » (prête pour livraison) exige le paiement
  //    validé : on ne confie pas une commande à un livreur tant que le client
  //    n'a pas payé.
  if (statut === 'prete') {
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
  if (statut === 'remboursee') {
    patch.expiree_at = now;
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
  if (error || !updated) throw createHttpError(404, 'Commande introuvable');

  if (statut === 'prete' && (sc.mode_livraison || 'golivra') === 'golivra') {
    await onSousCommandeReady(db, sousCommandeId);
  }

  // La notification de statut passe AVANT la synchro : le client apprend
  // d'abord que sa commande est acceptée, puis reçoit « Paiement requis »
  // quand la commande devient payable (déclenché dans la synchro).
  const notifyStatuses = new Set(['acceptee', 'refusee', 'en_preparation', 'prete']);
  if (notifyStatuses.has(statut)) {
    const { notifySousCommandeStatusChange } = require('./order-notify.service');
    await notifySousCommandeStatusChange(db, sousCommandeId, statut).catch((err) => {
      console.warn('[notify] sous-commande statut', statut, err?.message || err);
    });
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
  ACCEPTANCE_LIMIT_MIN,
  PAYMENT_LIMIT_MIN,
  PAYABLE_SC_STATUTS,
  snapshotAddress,
  establishmentPrepMinutes,
  resolveEstablishmentRow,
  resolveModeLivraison,
  createOrderFromPayload,
  updateSousCommandeStatut,
  syncCommandeStatutFromSousCommandes,
  onCommandeDevenuePayable,
  mapSousStatutToVendor,
};
