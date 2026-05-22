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
  await notifyClient(db, clientId, {
    type: 'commande_nouvelle',
    titre: 'Commande créée',
    corps: 'Finalisez le paiement Mobile Money pour confirmer votre commande.',
    data: { commande_id: commandeId, action: 'open_orders' },
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
      titre: 'Commande acceptée',
      corps: `${ctx.commerceNom} a accepté votre commande.`,
      data: { ...base, action: 'open_orders' },
    });
    return;
  }

  if (statut === 'refusee') {
    await notifyClient(db, ctx.clientId, {
      type: 'commande_refusee',
      titre: 'Commande refusée',
      corps: `${ctx.commerceNom} n'a pas pu traiter votre commande.`,
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
  notifyPromoApplied,
  notifySousCommandeStatusChange,
  notifyDeliveryAccepted,
  notifyDeliveryStep,
  notifyDeliveryCompleted,
  notifyAvailableCouriersForDelivery,
};
