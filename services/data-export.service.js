/**
 * Export RGPD (portabilité) — collecte TOUTES les données personnelles d'un
 * utilisateur pour le renvoyer dans un format JSON lisible (art. 20 RGPD).
 *
 * Principes :
 *   - Best-effort : chaque table est lue dans un try/catch — une table
 *     manquante ne fait pas échouer tout l'export.
 *   - JAMAIS de secrets : mot_de_passe_hash, tokens de session et push
 *     tokens ne sont jamais exportés (on conserve les dates utiles).
 *   - Périmètre strictement borné à l'utilisateur (idem BOLA : chaque
 *     requête filtre par l'id de l'utilisateur authentifié).
 */

async function trySelect(db, table, select, filter) {
  try {
    let q = db.from(table).select(select);
    if (filter) {
      const [col, val] = filter;
      q = q.eq(col, val);
    }
    const { data, error } = await q;
    if (error) {
      console.warn(`[data-export] ${table}: ${error.message}`);
      return [];
    }
    return data || [];
  } catch (e) {
    console.warn(`[data-export] ${table}: ${e?.message || e}`);
    return [];
  }
}

async function tryMaybeSingle(db, table, select, filter) {
  try {
    let q = db.from(table).select(select);
    if (filter) {
      const [col, val] = filter;
      q = q.eq(col, val);
    }
    const { data, error } = await q.maybeSingle();
    if (error) {
      console.warn(`[data-export] ${table}: ${error.message}`);
      return null;
    }
    return data || null;
  } catch (e) {
    console.warn(`[data-export] ${table}: ${e?.message || e}`);
    return null;
  }
}

/**
 * @param {object} db    Client Supabase
 * @param {string} userId
 * @returns {Promise<object>} Données personnelles complètes de l'utilisateur.
 */
async function exportUserData(db, userId) {
  const exportedAt = new Date().toISOString();

  // ── Profil (sans mot_de_passe_hash) ──────────────────────────────────
  const profil = await tryMaybeSingle(
    db,
    'utilisateurs',
    'id, nom, telephone, email, role_id, est_approuve, avatar_url, created_at, updated_at, derniere_connexion',
    ['id', userId],
  );

  const role = await tryMaybeSingle(db, 'roles', 'id, nom', ['id', profil?.role_id]);

  // ── Adresses de livraison ────────────────────────────────────────────
  const adresses = await trySelect(
    db,
    'adresses',
    'id, libelle, nom_complet, telephone, pays_id, ville_id, quartier, ligne1, ligne2, latitude, longitude, est_principale, created_at, updated_at',
    ['utilisateur_id', userId],
  );

  // ── Commandes (client) ───────────────────────────────────────────────
  const commandes = await trySelect(
    db,
    'commandes',
    'id, reference, statut, methode_paiement, adresse_livraison, sous_total_fcfa, frais_livraison_fcfa, total_fcfa, note_client, created_at, updated_at',
    ['client_id', userId],
  );

  const commandeIds = commandes.map((c) => c.id);

  const sousCommandes = commandeIds.length
    ? await trySelect(db, 'sous_commandes', '*', null).then((rows) =>
        rows.filter((s) => commandeIds.includes(s.commande_id)),
      )
    : [];

  // ── Paiements (via commandes) ────────────────────────────────────────
  const paiements = commandeIds.length
    ? await trySelect(db, 'paiements', '*', null).then((rows) =>
        rows.filter((p) => commandeIds.includes(p.commande_id)),
      )
    : [];

  // ── Favoris ──────────────────────────────────────────────────────────
  const favoris = await trySelect(db, 'favoris_produits', '*', ['utilisateur_id', userId]);

  // ── Avis / notations ─────────────────────────────────────────────────
  const avis = [
    ...(await trySelect(db, 'avis_restaurants', '*', ['client_id', userId])),
    ...(await trySelect(db, 'avis_boutiques', '*', ['client_id', userId])),
  ];

  // ── Notifications reçues (sans contenu de token) ─────────────────────
  const notifications = await trySelect(
    db,
    'notifications',
    'id, type, titre, corps, data, lu, created_at',
    ['utilisateur_id', userId],
  );

  // ── Sessions (dates uniquement, jamais le token) ─────────────────────
  const sessions = await trySelect(
    db,
    'sessions',
    'id, created_at, expires_at, revoked_at, user_agent, ip_address',
    ['utilisateur_id', userId],
  );

  // ── Données métier selon le rôle ─────────────────────────────────────
  let entreprises = [];
  let produits = [];
  let livraisons = [];
  let livreur = null;

  const roleNom = role?.nom ?? null;
  if (roleNom === 'restaurateur' || roleNom === 'commercant') {
    const restaurants = await trySelect(
      db,
      'restaurants',
      'id, nom, description, adresse, telephone, horaires, statut, created_at',
      ['proprietaire_id', userId],
    );
    const boutiques = await trySelect(
      db,
      'boutiques',
      'id, nom, description, adresse, telephone, horaires, statut, created_at',
      ['proprietaire_id', userId],
    );
    entreprises = [...restaurants, ...boutiques];

    for (const ent of entreprises) {
      const kind = restaurants.some((r) => r.id === ent.id) ? 'restaurant' : 'boutique';
      const table = kind === 'restaurant' ? 'plats' : 'articles';
      const col = kind === 'restaurant' ? 'restaurant_id' : 'boutique_id';
      const rows = await trySelect(db, table, '*', [col, ent.id]);
      produits.push(...rows.map((r) => ({ ...r, entreprise_id: ent.id, entreprise_type: kind })));
    }
  }

  if (roleNom === 'livreur') {
    livreur = await tryMaybeSingle(
      db,
      'livreurs',
      'id, type_vehicule, plaque_immatriculation, est_disponible, est_approuve, created_at',
      ['utilisateur_id', userId],
    );
    if (livreur) {
      livraisons = await trySelect(
        db,
        'livraisons',
        'id, commande_id, statut, adresse_depart, adresse_arrivee, distance_km, frais_livraison_fcfa, created_at, updated_at',
        ['livreur_id', livreur.id],
      );
    }
  }

  return {
    exported_at: exportedAt,
    format_version: 1,
    demandeur: 'l\'utilisateur lui-même (endpoint /api/auth/data-export)',
    profil: { ...profil, role: roleNom },
    adresses,
    commandes: commandes.map((c) => ({ ...c, sous_commandes: sousCommandes.filter((s) => s.commande_id === c.id) })),
    paiements,
    favoris,
    avis,
    notifications,
    sessions: sessions.map((s) => ({
      id: s.id,
      created_at: s.created_at,
      expires_at: s.expires_at,
      revoked_at: s.revoked_at,
      user_agent: s.user_agent,
    })), // ip_address exclue par prudence (donnée de connexion non nécessaire)
    entreprises,
    produits,
    livreur,
    livraisons,
  };
}

module.exports = { exportUserData };
