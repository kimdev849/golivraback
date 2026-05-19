const { createHttpError } = require('../utils/http');

/** Crée la livraison quand la sous-commande passe « prete » ; attribution par le système GoLivra. */
async function ensureLivraisonOnSousCommandeReady(db, sousCommandeId) {
  const { data: sc, error: scErr } = await db
    .from('sous_commandes')
    .select('*')
    .eq('id', sousCommandeId)
    .maybeSingle();
  if (scErr) throw scErr;
  if (!sc) return null;

  if ((sc.mode_livraison || 'golivra') !== 'golivra') {
    return null;
  }

  const { data: existing, error: exErr } = await db
    .from('livraisons')
    .select('*')
    .eq('sous_commande_id', sousCommandeId)
    .maybeSingle();
  if (exErr) throw exErr;
  if (existing) return existing;

  const { data: commande, error: cErr } = await db
    .from('commandes')
    .select('id, adresse_livraison_snapshot')
    .eq('id', sc.commande_id)
    .maybeSingle();
  if (cErr) throw cErr;

  const { collecte, livraison } = await buildAddressSnapshots(db, sc, commande);

  const { data: created, error: insErr } = await db
    .from('livraisons')
    .insert({
      sous_commande_id: sousCommandeId,
      statut: 'en_attente',
      adresse_collecte_snapshot: collecte,
      adresse_livraison_snapshot: livraison,
      livreur_id: null,
      entreprise_logistique_id: null,
    })
    .select('*')
    .single();
  if (insErr) throw insErr;

  return created;
}

async function buildAddressSnapshots(db, sc, commande) {
  let collecteText = '';
  if (sc.restaurant_id) {
    const { data: r } = await db
      .from('restaurants')
      .select('nom, adresse_ligne1, adresse_ville')
      .eq('id', sc.restaurant_id)
      .maybeSingle();
    collecteText = [r?.nom, r?.adresse_ligne1, r?.adresse_ville].filter(Boolean).join(', ');
  }
  if (sc.boutique_id) {
    const { data: b } = await db
      .from('boutiques')
      .select('nom, adresse_ligne1, adresse_ville')
      .eq('id', sc.boutique_id)
      .maybeSingle();
    collecteText = [b?.nom, b?.adresse_ligne1, b?.adresse_ville].filter(Boolean).join(', ');
  }

  const snap = commande?.adresse_livraison_snapshot;
  let livraisonText = '';
  if (snap && typeof snap === 'object' && snap.texte) livraisonText = String(snap.texte);
  else if (typeof snap === 'string') livraisonText = snap;

  return {
    collecte: collecteText ? { texte: collecteText } : null,
    livraison: livraisonText ? { texte: livraisonText } : null,
  };
}

async function listAvailableCouriers(db) {
  const { data: livreurs, error } = await db
    .from('livreurs')
    .select(
      'id, type_vehicule, entreprise_logistique_id, nb_livraisons_total, utilisateur_id, est_disponible, est_approuve',
    )
    .eq('est_disponible', true)
    .eq('est_approuve', true);
  if (error) throw error;

  const userIds = [...new Set((livreurs || []).map((l) => l.utilisateur_id))];
  const { data: users } = userIds.length
    ? await db.from('utilisateurs').select('id, est_actif').in('id', userIds)
    : { data: [] };
  const activeUserIds = new Set((users || []).filter((u) => u.est_actif !== false).map((u) => u.id));

  return (livreurs || [])
    .filter((l) => activeUserIds.has(l.utilisateur_id))
    .sort((a, b) => Number(a.nb_livraisons_total ?? 0) - Number(b.nb_livraisons_total ?? 0));
}

/**
 * Attribution automatique GoLivra : premier livreur disponible (charge la plus faible).
 * Les restaurants/boutiques ne choisissent pas le livreur ; l'entreprise logistique non plus.
 */
async function autoAssignLivreur(db, livraisonId) {
  const { data: livraison, error } = await db.from('livraisons').select('*').eq('id', livraisonId).maybeSingle();
  if (error) throw error;
  if (!livraison) throw createHttpError(404, 'Livraison introuvable.');
  if (livraison.livreur_id) return livraison;
  if (livraison.statut === 'livree' || livraison.statut === 'annulee') return livraison;

  const couriers = await listAvailableCouriers(db);
  if (!couriers.length) return livraison;

  const picked = couriers[0];
  return assignLivreurToLivraison(db, livraisonId, picked.id, { source: 'systeme' });
}

/** Attribution manuelle réservée à l'admin GoLivra (override). */
async function assignLivreurManually(db, livraisonId, livreurId, source = 'admin') {
  const { data: liv } = await db.from('livreurs').select('id').eq('id', livreurId).maybeSingle();
  if (!liv) throw createHttpError(404, 'Livreur introuvable.');
  return assignLivreurToLivraison(db, livraisonId, livreurId, { source });
}

async function assignLivreurToLivraison(db, livraisonId, livreurId, { source } = {}) {
  const { data: livreur, error: lErr } = await db
    .from('livreurs')
    .select('id, entreprise_logistique_id')
    .eq('id', livreurId)
    .maybeSingle();
  if (lErr) throw lErr;
  if (!livreur) throw createHttpError(404, 'Livreur introuvable.');

  const { data: livraison, error: dErr } = await db
    .from('livraisons')
    .select('*')
    .eq('id', livraisonId)
    .maybeSingle();
  if (dErr) throw dErr;
  if (!livraison) throw createHttpError(404, 'Livraison introuvable.');
  if (livraison.statut === 'livree' || livraison.statut === 'annulee') {
    throw createHttpError(400, 'Cette livraison ne peut plus être modifiée.');
  }

  const now = new Date().toISOString();
  const { data, error } = await db
    .from('livraisons')
    .update({
      livreur_id: livreurId,
      entreprise_logistique_id: livreur.entreprise_logistique_id || null,
      statut: 'attribuee',
      attribuee_at: now,
      note_livreur: source === 'systeme' ? null : livraison.note_livreur,
    })
    .eq('id', livraisonId)
    .select('*')
    .single();
  if (error || !data) throw createHttpError(404, 'Livraison introuvable.');

  return data;
}

/** Après passage en « prete » : créer la mission puis tenter l'attribution automatique. */
async function onSousCommandeReady(db, sousCommandeId) {
  const livraison = await ensureLivraisonOnSousCommandeReady(db, sousCommandeId);
  if (!livraison) return null;
  return autoAssignLivreur(db, livraison.id);
}

module.exports = {
  ensureLivraisonOnSousCommandeReady,
  autoAssignLivreur,
  assignLivreurManually,
  assignLivreurToLivraison,
  onSousCommandeReady,
  listAvailableCouriers,
};
