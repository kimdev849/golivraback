/**
 * Statistiques commerce (restaurant / boutique) pour l’admin — données issues des sous-commandes en base.
 * CA produits = sous_total (hors livraison). Aucune commission GoLivra sur les ventes.
 */

function startOfPeriod(days) {
  if (days == null) return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d.toISOString();
}

function aggregateForPeriod(rows, items, sinceIso, isPaid) {
  const filtered = sinceIso ? rows.filter((r) => r.created_at >= sinceIso) : rows;

  // Décomptes (total / livrées / annulées / en cours) : toutes les commandes de
  // la période.
  let commandes = 0;
  let livrees = 0;
  let annulees = 0;
  let enCours = 0;
  for (const sc of filtered) {
    commandes += 1;
    const st = sc.statut || '';
    if (st === 'livree') livrees += 1;
    else if (st === 'annulee' || st === 'refusee') annulees += 1;
    else enCours += 1;
  }

  // CA = UNIQUEMENT les commandes PAYÉES et non annulées/refusées (l'argent
  // n'est réellement gagné qu'au paiement).
  const paidRows = filtered.filter((r) => isPaid(r) && r.statut !== 'annulee' && r.statut !== 'refusee');
  const scIds = new Set(paidRows.map((r) => r.id));

  let caProduits = 0;
  let fraisLivraison = 0;
  let totalClient = 0;
  for (const sc of paidRows) {
    // CA produits = part du vendeur (sous_total), jamais les frais de livraison.
    caProduits += Number(sc.sous_total ?? 0);
    fraisLivraison += Number(sc.frais_livraison ?? 0);
    totalClient += Number(sc.total ?? 0);
  }

  const productMap = new Map();
  for (const it of items) {
    if (!scIds.has(it.sous_commande_id)) continue;
    const nom = String(it.nom_produit || 'Article').trim() || 'Article';
    const q = Number(it.quantite ?? 1);
    const ca = Number(it.sous_total ?? 0);
    const prev = productMap.get(nom) || { nom, quantite: 0, ca_fcfa: 0 };
    prev.quantite += q;
    prev.ca_fcfa += ca;
    productMap.set(nom, prev);
  }

  const top_produits = [...productMap.values()]
    .sort((a, b) => b.ca_fcfa - a.ca_fcfa || b.quantite - a.quantite)
    .slice(0, 10);

  return {
    commandes,
    commandes_livrees: livrees,
    commandes_annulees: annulees,
    commandes_en_cours: enCours,
    ca_produits_fcfa: caProduits,
    frais_livraison_fcfa: fraisLivraison,
    total_paye_client_fcfa: totalClient,
    panier_moyen_fcfa: paidRows.length > 0 ? Math.round(caProduits / paidRows.length) : 0,
    top_produits,
  };
}

async function getCommerceStatsForEnterprise(db, enterpriseId, kind) {
  const fk = kind === 'restaurant' ? 'restaurant_id' : 'boutique_id';

  const { data: sousCommandes, error } = await db
    .from('sous_commandes')
    .select('id, commande_id, statut, sous_total, frais_livraison, total, remise, created_at')
    .eq(fk, enterpriseId)
    .order('created_at', { ascending: false });
  if (error) throw error;

  const rows = sousCommandes || [];
  const scIds = rows.map((r) => r.id);

  // Seules les commandes PAYÉES comptent dans le CA (le client paie après
  // acceptation ; tant qu'il n'a pas payé, rien n'est gagné).
  const commandeIds = [...new Set(rows.map((r) => r.commande_id).filter(Boolean))];
  const paidCommandeIds = new Set();
  if (commandeIds.length > 0) {
    const { data: paiements, error: payErr } = await db
      .from('paiements')
      .select('commande_id, statut')
      .in('commande_id', commandeIds);
    if (payErr) throw payErr;
    for (const p of paiements || []) {
      if (p.statut === 'valide') paidCommandeIds.add(p.commande_id);
    }
  }
  const isPaid = (r) => r.commande_id != null && paidCommandeIds.has(r.commande_id);
  let items = [];
  if (scIds.length > 0) {
    const { data: itemRows, error: itemErr } = await db
      .from('sous_commande_items')
      .select('sous_commande_id, nom_produit, quantite, sous_total')
      .in('sous_commande_id', scIds);
    if (itemErr) throw itemErr;
    items = itemRows || [];
  }

  const periodes = {
    j7: aggregateForPeriod(rows, items, startOfPeriod(7), isPaid),
    j30: aggregateForPeriod(rows, items, startOfPeriod(30), isPaid),
    j90: aggregateForPeriod(rows, items, startOfPeriod(90), isPaid),
    total: aggregateForPeriod(rows, items, null, isPaid),
  };

  // ----- Engagement (vues / clics) - non périodique, cumulatif sur la durée de vie du produit -----
  const productsTable = kind === 'restaurant' ? 'plats' : 'articles';
  let engagement = {
    total_vues: 0,
    total_clics: 0,
    taux_conversion_pct: 0,
    top_vus: [],
    top_cliques: [],
  };
  try {
    const { data: prods } = await db
      .from(productsTable)
      .select('id, nom, nb_vues, nb_clics, nb_ventes, image_url')
      .eq(fk, enterpriseId);
    const list = prods || [];
    const totalVues = list.reduce((s, p) => s + Number(p.nb_vues ?? 0), 0);
    const totalClics = list.reduce((s, p) => s + Number(p.nb_clics ?? 0), 0);
    const totalVentes = list.reduce((s, p) => s + Number(p.nb_ventes ?? 0), 0);
    const top_vus = [...list]
      .sort((a, b) => Number(b.nb_vues ?? 0) - Number(a.nb_vues ?? 0))
      .slice(0, 10)
      .map((p) => ({
        id: p.id,
        nom: p.nom,
        image_url: p.image_url ?? null,
        nb_vues: Number(p.nb_vues ?? 0),
        nb_clics: Number(p.nb_clics ?? 0),
        nb_ventes: Number(p.nb_ventes ?? 0),
      }));
    const top_cliques = [...list]
      .sort((a, b) => Number(b.nb_clics ?? 0) - Number(a.nb_clics ?? 0))
      .slice(0, 10)
      .map((p) => ({
        id: p.id,
        nom: p.nom,
        image_url: p.image_url ?? null,
        nb_vues: Number(p.nb_vues ?? 0),
        nb_clics: Number(p.nb_clics ?? 0),
        nb_ventes: Number(p.nb_ventes ?? 0),
      }));
    engagement = {
      total_vues: totalVues,
      total_clics: totalClics,
      total_ventes: totalVentes,
      taux_conversion_pct: totalVues > 0 ? Math.round((totalClics / totalVues) * 1000) / 10 : 0,
      taux_achat_pct: totalClics > 0 ? Math.round((totalVentes / totalClics) * 1000) / 10 : 0,
      top_vus,
      top_cliques,
    };
  } catch (e) {
    // colonnes nb_vues/nb_clics pas encore migrées : on renvoie des zéros
    engagement.note = 'Migration engagement non appliquée';
  }

  return {
    source: 'sous_commandes',
    commission_ventes_golivra_fcfa: 0,
    note: 'CA produits = montant marchand (sous_total). Commission GoLivra uniquement sur frais de livraison.',
    periodes,
    engagement,
    mis_a_jour_le: new Date().toISOString(),
  };
}

module.exports = { getCommerceStatsForEnterprise };
