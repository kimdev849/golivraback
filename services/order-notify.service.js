/**
 * Notifications in-app pour le parcours commande → livraison (types enum v3).
 */
const { notifyUserSafe, notifyAvailableCouriersForDelivery } = require('./notification.service');

async function getSousCommandeParties(db, sousCommandeId) {
  const { data: sc, error } = await db
    .from('sous_commandes')
    .select('id, commande_id, restaurant_id, boutique_id, statut')
    .eq('id', sousCommandeId)
    .maybeSingle();
  if (error) throw error;
  if (!sc) return null;

  const { data: commande, error: cErr } = await db
    .from('commandes')
    .select('id, numero, client_id')
    .eq('id', sc.commande_id)
    .maybeSingle();
  if (cErr) throw cErr;

  const vendorOwnerIds = new Set();
  let commerceNom = 'Commerce';
  if (sc.restaurant_id) {
    const { data: r } = await db.from('restaurants').select('proprietaire_id, nom').eq('id', sc.restaurant_id).maybeSingle();
    if (r?.proprietaire_id) vendorOwnerIds.add(r.proprietaire_id);
    if (r?.nom) commerceNom = r.nom;
  }
  if (sc.boutique_id) {
    const { data: b } = await db.from('boutiques').select('proprietaire_id, nom').eq('id', sc.boutique_id).maybeSingle();
    if (b?.proprietaire_id) vendorOwnerIds.add(b.proprietaire_id);
    if (b?.nom) commerceNom = b.nom;
  }

  return {
    sc,
    commande,
    clientId: commande?.client_id ?? null,
    vendorOwnerIds: [...vendorOwnerIds],
    commerceNom,
    commandeId: sc.commande_id,
    commandeNumero: commande?.numero ?? null,
  };
}

async function getLivraisonParties(db, livraisonId) {
  const { data: liv, error } = await db.from('livraisons').select('*').eq('id', livraisonId).maybeSingle();
  if (error) throw error;
  if (!liv) return null;

  if (!liv.sous_commande_id) {
    return { livraison: liv, parties: null };
  }

  const parties = await getSousCommandeParties(db, liv.sous_commande_id);
  let courierUserId = null;
  if (liv.livreur_id) {
    const { data: courier } = await db
      .from('livreurs')
      .select('utilisateur_id')
      .eq('id', liv.livreur_id)
      .maybeSingle();
    courierUserId = courier?.utilisateur_id ?? null;
  }

  return { livraison: liv, parties, courierUserId };
}

async function notifyClient(db, clientId, payload) {
  if (!clientId) return;
  await notifyUserSafe(db, { utilisateurId: clientId, ...payload });
}

async function notifyVendors(db, vendorOwnerIds, payload) {
  for (const ownerId of vendorOwnerIds || []) {
    await notifyUserSafe(db, { utilisateurId: ownerId, ...payload });
  }
}

async function notifyOrderCreated(db, commandeId, clientId) {
  // Parle de « la boutique » ou « le restaurant » selon le type de commerce.
  const { data: scs } = await db
    .from('sous_commandes')
    .select('id, restaurant_id, boutique_id')
    .eq('commande_id', commandeId)
    .limit(1);
  const sc = (scs || [])[0];
  const isResto = Boolean(sc?.restaurant_id);
  const qui = isResto ? 'Le restaurant' : 'La boutique';
  let nom = null;
  if (sc?.restaurant_id) {
    const { data: r } = await db.from('restaurants').select('nom').eq('id', sc.restaurant_id).maybeSingle();
    nom = r?.nom ?? null;
  } else if (sc?.boutique_id) {
    const { data: b } = await db.from('boutiques').select('nom').eq('id', sc.boutique_id).maybeSingle();
    nom = b?.nom ?? null;
  }
  const corps = nom
    ? `Nous avons envoyé votre commande à ${nom}. ${qui} a 5 minutes pour la confirmer. Vous ne serez débité qu'après acceptation.`
    : `Nous avons envoyé votre commande. ${qui} a 5 minutes pour la confirmer. Vous ne serez débité qu'après acceptation.`;
  await notifyClient(db, clientId, {
    type: 'commande_nouvelle',
    titre: 'Commande envoyée',
    corps,
    data: { commande_id: commandeId, action: 'open_orders' },
  });

  // 🔔 NOUVEAU : prévenir AUSSI les commerces qu'une commande les attend.
  // Avant, seul le client était notifié à la création ; le vendeur ne
  // découvrait la commande qu'au rappel de 3 min (souvent trop tard dans le
  // délai de 5 min) → la commande expirait sans réponse. Maintenant chaque
  // commerce est prévenu immédiatement, en push (app fermée incluse).
  const { data: allScs } = await db
    .from('sous_commandes')
    .select('id, restaurant_id, boutique_id')
    .eq('commande_id', commandeId);
  const ownerIds = new Set();
  for (const sc of allScs || []) {
    if (sc.restaurant_id) {
      const { data: r } = await db.from('restaurants').select('proprietaire_id').eq('id', sc.restaurant_id).maybeSingle();
      if (r?.proprietaire_id) ownerIds.add(r.proprietaire_id);
    }
    if (sc.boutique_id) {
      const { data: b } = await db.from('boutiques').select('proprietaire_id').eq('id', sc.boutique_id).maybeSingle();
      if (b?.proprietaire_id) ownerIds.add(b.proprietaire_id);
    }
  }
  await notifyVendors(db, [...ownerIds], {
    type: 'commande_nouvelle',
    titre: 'Nouvelle commande',
    corps: 'Un client vient de commander. Vous avez 5 minutes pour accepter ou refuser.',
    data: { commande_id: commandeId, action: 'vendor_orders' },
  });
}

async function notifyPaymentConfirmed(db, commandeId, clientId) {
  await notifyClient(db, clientId, {
    type: 'paiement',
    titre: 'Paiement confirmé',
    corps: 'Votre commande est confirmée. Le commerce va la préparer.',
    data: { commande_id: commandeId, action: 'open_orders' },
  });

  const { data: sous } = await db
    .from('sous_commandes')
    .select('id, restaurant_id, boutique_id')
    .eq('commande_id', commandeId);
  const ownerIds = new Set();
  for (const sc of sous || []) {
    if (sc.restaurant_id) {
      const { data: r } = await db.from('restaurants').select('proprietaire_id').eq('id', sc.restaurant_id).maybeSingle();
      if (r?.proprietaire_id) ownerIds.add(r.proprietaire_id);
    }
    if (sc.boutique_id) {
      const { data: b } = await db.from('boutiques').select('proprietaire_id').eq('id', sc.boutique_id).maybeSingle();
      if (b?.proprietaire_id) ownerIds.add(b.proprietaire_id);
    }
  }
  await notifyVendors(db, [...ownerIds], {
    type: 'commande_nouvelle',
    titre: 'Nouvelle commande payée',
    corps: 'Un client vient de payer. Consultez vos commandes.',
    data: { commande_id: commandeId, action: 'vendor_orders' },
  });
}

async function notifyPromoApplied(db, clientId, { code, remise, commandeId }) {
  await notifyClient(db, clientId, {
    type: 'promotion',
    titre: 'Code promo appliqué',
    corps: `Réduction de ${remise} FCFA avec le code ${code}.`,
    data: { commande_id: commandeId, code, action: 'open_orders' },
  });
}

async function notifySousCommandeStatusChange(db, sousCommandeId, statut) {
  const ctx = await getSousCommandeParties(db, sousCommandeId);
  if (!ctx?.commande) return;

  const base = {
    commande_id: ctx.commandeId,
    sous_commande_id: sousCommandeId,
    commerce_nom: ctx.commerceNom,
  };

  if (statut === 'acceptee') {
    await notifyClient(db, ctx.clientId, {
      type: 'commande_acceptee',
      titre: 'Bonne nouvelle ! 🎉',
      corps: `${ctx.commerceNom} a accepté votre commande. Confirmez le paiement pour lancer la préparation.`,
      data: { ...base, action: 'open_orders' },
    });
    return;
  }

  if (statut === 'refusee') {
    const qui = ctx.sc?.restaurant_id ? 'Le restaurant' : 'La boutique';
    await notifyClient(db, ctx.clientId, {
      type: 'commande_refusee',
      titre: 'Commande refusée',
      corps: `${ctx.commerceNom || qui} ne peut pas préparer votre commande cette fois-ci. Vous n'avez rien payé.`,
      data: { ...base, action: 'open_orders' },
    });
    return;
  }

  if (statut === 'en_preparation') {
    await notifyClient(db, ctx.clientId, {
      type: 'commande_acceptee',
      titre: 'En préparation',
      corps: `${ctx.commerceNom} prépare votre commande.`,
      data: { ...base, action: 'open_orders' },
    });
    return;
  }

  if (statut === 'prete') {
    await notifyClient(db, ctx.clientId, {
      type: 'commande_prete',
      titre: 'Commande prête',
      corps: `${ctx.commerceNom} a terminé la préparation. Un livreur va être assigné.`,
      data: { ...base, action: 'open_orders' },
    });
    await notifyVendors(db, ctx.vendorOwnerIds, {
      type: 'commande_prete',
      titre: 'Commande prête à livrer',
      corps: 'La commande attend un livreur GoLivra.',
      data: { ...base, action: 'vendor_orders' },
    });
  }
}

/**
 * Commande expirée / annulée : le commerce n'a pas accepté dans le délai de
 * 5 minutes (ou le client a annulé sa commande). Si un paiement avait déjà été
 * validé (cas legacy), le remboursement est en cours ; sinon il n'y a rien à
 * rembourser — le client est invité à choisir une autre boutique.
 */
async function notifyOrderExpired(
  db,
  commandeId,
  { remboursementEnCours = true, raisonClient = null } = {},
) {
  const { data: commande } = await db
    .from('commandes')
    .select('id, numero, client_id')
    .eq('id', commandeId)
    .maybeSingle();
  if (!commande) return;

  // Vendeurs concernés : la commande liée à leur commerce a expiré / été annulée.
  // Utilisé aussi pour parler de « la boutique » ou « le restaurant » au client.
  const { data: sous } = await db
    .from('sous_commandes')
    .select('id, restaurant_id, boutique_id')
    .eq('commande_id', commandeId);
  const premier = (sous || [])[0];
  const de = premier?.restaurant_id ? 'du restaurant' : 'de la boutique';

  const corpsClient = raisonClient
    ? raisonClient
    : remboursementEnCours
      ? `Nous sommes désolés, ${de} n'a pas répondu à temps. Votre commande a donc été annulée et le paiement est en cours de remboursement.`
      : `Nous sommes désolés, ${de} n'a pas répondu à temps. Votre commande a donc été annulée — aucun paiement n'a été effectué.`;
  await notifyClient(db, commande.client_id, {
    type: 'commande_expiree',
    titre: raisonClient ? 'Commande annulée' : 'Commande non confirmée',
    corps: corpsClient,
    data: { commande_id: commandeId, action: 'open_orders' },
  });
  const ownerIds = new Set();
  for (const sc of sous || []) {
    if (sc.restaurant_id) {
      const { data: r } = await db.from('restaurants').select('proprietaire_id').eq('id', sc.restaurant_id).maybeSingle();
      if (r?.proprietaire_id) ownerIds.add(r.proprietaire_id);
    }
    if (sc.boutique_id) {
      const { data: b } = await db.from('boutiques').select('proprietaire_id').eq('id', sc.boutique_id).maybeSingle();
      if (b?.proprietaire_id) ownerIds.add(b.proprietaire_id);
    }
  }
  await notifyVendors(db, [...ownerIds], {
    type: 'commande_expiree',
    titre: raisonClient ? 'Commande annulée par le client' : 'Commande expirée',
    corps: raisonClient
      ? 'Le client a annulé la commande.'
      : "Le délai d'acceptation (5 min) est dépassé : la commande a été annulée et le client remboursé le cas échéant.",
    data: { commande_id: commandeId, action: 'vendor_orders' },
  });
}

/**
 * Paiement requis : la commande est acceptée et le client a 5 min pour payer.
 * Envoyée automatiquement dès que toutes les réponses sont réunies (le dépôt
 * Mobile Money est initié automatiquement en parallèle par le backend).
 */
async function notifyPaymentRequired(db, commandeId, clientId, montantFcfa) {
  if (!clientId) return;
  await notifyClient(db, clientId, {
    type: 'paiement',
    titre: 'Paiement requis',
    corps: `Votre commande a été acceptée. Confirmez le paiement de ${Number(montantFcfa || 0).toLocaleString('fr-FR')} FCFA — vous avez 5 minutes.`, 
    data: { commande_id: commandeId, action: 'open_order_tracking' },
  });
}

/** Rappel à la boutique : il reste moins de 3 minutes pour accepter/refuser. */
async function notifyAcceptanceReminder(db, commandeId) {
  const { data: commande } = await db
    .from('commandes')
    .select('id, numero, client_id')
    .eq('id', commandeId)
    .maybeSingle();
  if (!commande) return;

  // Le rappel ne concerne que les commerces qui n'ont PAS encore répondu.
  const { data: sous } = await db
    .from('sous_commandes')
    .select('id, restaurant_id, boutique_id')
    .eq('commande_id', commandeId)
    .eq('statut', 'en_attente');
  const ownerIds = new Set();
  for (const sc of sous || []) {
    if (sc.restaurant_id) {
      const { data: r } = await db.from('restaurants').select('proprietaire_id').eq('id', sc.restaurant_id).maybeSingle();
      if (r?.proprietaire_id) ownerIds.add(r.proprietaire_id);
    }
    if (sc.boutique_id) {
      const { data: b } = await db.from('boutiques').select('proprietaire_id').eq('id', sc.boutique_id).maybeSingle();
      if (b?.proprietaire_id) ownerIds.add(b.proprietaire_id);
    }
  }
  if (ownerIds.size === 0) return;
  await notifyVendors(db, [...ownerIds], {
    type: 'commande_nouvelle',
    titre: 'Réponse attendue',
    corps: "Il vous reste moins de 3 minutes pour accepter la commande, sinon elle sera automatiquement annulée.",
    data: { commande_id: commandeId, action: 'vendor_orders' },
  });
}

/** Délai de paiement expiré : le client n'a pas payé dans les 5 minutes. */
async function notifyPaymentDeadlineExpired(db, commandeId) {
  const { data: commande } = await db
    .from('commandes')
    .select('id, numero, client_id')
    .eq('id', commandeId)
    .maybeSingle();
  if (!commande) return;

  await notifyClient(db, commande.client_id, {
    type: 'commande_expiree',
    titre: 'Paiement non effectué',
    corps: "Vous n'avez pas confirmé le paiement dans les 5 minutes, votre commande a donc été annulée. Vous pouvez en passer une nouvelle quand vous le souhaitez.",
    data: { commande_id: commandeId, action: 'open_order_tracking' },
  });

  const { data: sous } = await db
    .from('sous_commandes')
    .select('id, restaurant_id, boutique_id')
    .eq('commande_id', commandeId);
  const ownerIds = new Set();
  for (const sc of sous || []) {
    if (sc.restaurant_id) {
      const { data: r } = await db.from('restaurants').select('proprietaire_id').eq('id', sc.restaurant_id).maybeSingle();
      if (r?.proprietaire_id) ownerIds.add(r.proprietaire_id);
    }
    if (sc.boutique_id) {
      const { data: b } = await db.from('boutiques').select('proprietaire_id').eq('id', sc.boutique_id).maybeSingle();
      if (b?.proprietaire_id) ownerIds.add(b.proprietaire_id);
    }
  }
  await notifyVendors(db, [...ownerIds], {
    type: 'commande_expiree',
    titre: 'Paiement client expiré',
    corps: "Le client n'a pas effectué le paiement dans le délai imparti. La commande a été annulée.",
    data: { commande_id: commandeId, action: 'vendor_orders' },
  });
}

async function notifyDeliveryAccepted(db, livraisonId) {
  const ctx = await getLivraisonParties(db, livraisonId);
  if (!ctx?.parties) return;

  const base = {
    commande_id: ctx.parties.commandeId,
    livraison_id: livraisonId,
    sous_commande_id: ctx.livraison.sous_commande_id,
  };

  await notifyClient(db, ctx.parties.clientId, {
    type: 'livraison_statut',
    titre: 'Livreur assigné',
    corps: 'Un livreur GoLivra a pris en charge votre livraison.',
    data: { ...base, action: 'open_orders' },
  });

  await notifyVendors(db, ctx.parties.vendorOwnerIds, {
    type: 'livraison_statut',
    titre: 'Livreur en route',
    corps: 'Un livreur a accepté la course pour cette commande.',
    data: { ...base, action: 'vendor_orders' },
  });
}

async function notifyDeliveryStep(db, livraisonId, step) {
  const ctx = await getLivraisonParties(db, livraisonId);
  if (!ctx?.parties) return;

  const base = {
    commande_id: ctx.parties.commandeId,
    livraison_id: livraisonId,
    sous_commande_id: ctx.livraison.sous_commande_id,
  };

  if (step === 'en_collecte') {
    await notifyClient(db, ctx.parties.clientId, {
      type: 'livraison_statut',
      titre: 'Collecte en cours',
      corps: 'Le livreur récupère votre commande chez le commerce.',
      data: { ...base, action: 'open_orders' },
    });
    await notifyVendors(db, ctx.parties.vendorOwnerIds, {
      type: 'livraison_statut',
      titre: 'Livreur au commerce',
      corps: 'Le livreur est en train de récupérer la commande.',
      data: { ...base, action: 'vendor_orders' },
    });
    return;
  }

  if (step === 'en_route') {
    await notifyClient(db, ctx.parties.clientId, {
      type: 'livraison_statut',
      titre: 'En route vers vous',
      corps: 'Votre commande est en route. Préparez-vous à la recevoir.',
      data: { ...base, action: 'open_orders' },
    });
    await notifyVendors(db, ctx.parties.vendorOwnerIds, {
      type: 'livraison_statut',
      titre: 'Livraison en route',
      corps: 'Le livreur se dirige vers le client.',
      data: { ...base, action: 'vendor_orders' },
    });
  }
}

async function notifyDeliveryCompleted(db, livraisonId) {
  const ctx = await getLivraisonParties(db, livraisonId);
  if (!ctx?.parties) return;

  const base = {
    commande_id: ctx.parties.commandeId,
    livraison_id: livraisonId,
    sous_commande_id: ctx.livraison.sous_commande_id,
  };

  await notifyClient(db, ctx.parties.clientId, {
    type: 'commande_livree',
    titre: 'Commande livrée',
    corps: `Votre commande chez ${ctx.parties.commerceNom} a été livrée. Vous pouvez la noter.`,
    data: { ...base, action: 'open_orders', peut_noter: true },
  });

  await notifyVendors(db, ctx.parties.vendorOwnerIds, {
    type: 'commande_livree',
    titre: 'Livraison terminée',
    corps: 'La commande a été livrée au client.',
    data: { ...base, action: 'vendor_orders' },
  });

  if (ctx.courierUserId) {
    await notifyUserSafe(db, {
      utilisateurId: ctx.courierUserId,
      type: 'livraison_statut',
      titre: 'Course terminée',
      corps: 'Bonne livraison ! Consultez vos missions.',
      data: { livraison_id: livraisonId, action: 'courier_missions' },
    });
  }
}

module.exports = {
  getSousCommandeParties,
  getLivraisonParties,
  notifyOrderCreated,
  notifyPaymentConfirmed,
  notifyPaymentRequired,
  notifyPromoApplied,
  notifySousCommandeStatusChange,
  notifyOrderExpired,
  notifyAcceptanceReminder,
  notifyPaymentDeadlineExpired,
  notifyDeliveryAccepted,
  notifyDeliveryStep,
  notifyDeliveryCompleted,
  notifyAvailableCouriersForDelivery,
};
