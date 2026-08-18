-- =============================================================================
-- rls-deny-by-default.sql — Verrouiller les tables sensibles contre la clé anon
-- =============================================================================
--
-- Pourquoi :
--   Le mobile embarquait une clé Supabase ANON (EXPO_PUBLIC_SUPABASE_ANON_KEY)
--   pour s'abonner en temps réel aux changements de la table `commandes`.
--   Sans RLS activé sur cette table, N'IMPORTE QUI possédant cette clé publique
--   (extraite du binaire de l'app) pouvait recevoir TOUTES les commandes de tous
--   les marchands (INSERT / UPDATE / DELETE), avec toutes leurs données.
--
-- Ce que fait ce script :
--   1. Active RLS (deny-by-default : AUCUNE policy créée → tout accès anon /
--      authenticated refusé) sur les tables sensibles.
--   2. Révoque les privilèges anon / authenticated sur ces tables (défense en
--      profondeur : même une future erreur de policy ne laisse rien passer).
--   3. Retire ces tables de la publication `supabase_realtime` : les
--      abonnements postgres_changes ne reçoivent plus rien.
--
-- Impact sur l'existant :
--   - Le backend Node (clé service_role) contourne RLS → AUCUN changement.
--   - Le mobile : le temps réel Supabase est coupé → le polling existant
--     (rafraîchissement via l'API authentifiée) prend le relais.
--   - Aucune donnée n'est supprimée ni modifiée.
--
-- Exécution : Supabase → SQL Editor → coller + Run. Idempotent.
-- =============================================================================

-- ── 1. Activer RLS (deny-by-default) sur chaque table sensible ──────────────
-- Chaque table est isolée dans un bloc try/catch : une table absente sur une
-- base donnée n'empêche pas le verrouillage des autres.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'roles', 'utilisateurs', 'sessions', 'otp_codes', 'otp',
    'adresses_utilisateur',
    'entreprises', 'entreprises_livraison', 'horaires_entreprise',
    'categories', 'categories_restaurants', 'categories_boutiques',
    'categories_produits', 'categories_menus', 'entreprises_categories',
    'produits', 'menus', 'commandes_menus', 'articles',
    'paniers', 'panier_articles',
    'commandes', 'sous_commandes', 'commande_articles',
    'livraisons', 'positions_livreurs', 'livreurs',
    'paiements', 'paiements_pawapay', 'remboursements', 'retraits',
    'portefeuilles', 'transactions', 'escrow',
    'notifications', 'favoris', 'avis', 'promotions', 'commandes_promotions',
    'logs_admin', 'parametres', 'parametres_systeme',
    'campagnes', 'codes_promo', 'zones_livraison', 'pays', 'villes', 'quartiers',
    'tokens_push', 'app_status', 'annonces', 'observabilite_incidents',
    'usage_events', 'usage_tracking', 'endpoint_health'
  ];
BEGIN
  FOREACH t IN ARRAY tables
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      -- Deny-by-default : aucune policy n'est créée → tout accès non
      -- service_role est refusé (y compris anon et authenticated).
      RAISE NOTICE 'RLS activé sur %', t;
    EXCEPTION WHEN undefined_table THEN
      RAISE NOTICE 'Table absente, ignorée : %', t;
    END;
  END LOOP;
END $$;

-- ── 2. Révoquer les privilèges anon / authenticated (défense en profondeur) ──
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'roles', 'utilisateurs', 'sessions', 'otp_codes', 'otp',
    'adresses_utilisateur',
    'entreprises', 'entreprises_livraison', 'horaires_entreprise',
    'categories', 'categories_restaurants', 'categories_boutiques',
    'categories_produits', 'categories_menus', 'entreprises_categories',
    'produits', 'menus', 'commandes_menus', 'articles',
    'paniers', 'panier_articles',
    'commandes', 'sous_commandes', 'commande_articles',
    'livraisons', 'positions_livreurs', 'livreurs',
    'paiements', 'paiements_pawapay', 'remboursements', 'retraits',
    'portefeuilles', 'transactions', 'escrow',
    'notifications', 'favoris', 'avis', 'promotions', 'commandes_promotions',
    'logs_admin', 'parametres', 'parametres_systeme',
    'campagnes', 'codes_promo', 'zones_livraison', 'pays', 'villes', 'quartiers',
    'tokens_push', 'app_status', 'annonces', 'observabilite_incidents',
    'usage_events', 'usage_tracking', 'endpoint_health'
  ];
BEGIN
  FOREACH t IN ARRAY tables
  LOOP
    BEGIN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon, authenticated', t);
      RAISE NOTICE 'Privilèges anon/authenticated révoqués sur %', t;
    EXCEPTION WHEN undefined_table THEN
      RAISE NOTICE 'Table absente, ignorée : %', t;
    END;
  END LOOP;
END $$;

-- ── 3. Retirer les tables sensibles de la publication Realtime ──────────────
-- postgres_changes (le mécanisme du temps réel) ne diffuse QUE les tables de
-- la publication `supabase_realtime`. En les en retirant, aucun abonnement
-- (même avec une clé valide) ne reçoit d'événement sur ces tables.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'commandes', 'sous_commandes', 'commande_articles', 'livraisons',
    'paiements', 'remboursements', 'portefeuilles', 'transactions',
    'utilisateurs', 'sessions', 'otp_codes', 'otp', 'notifications',
    'paniers', 'panier_articles', 'favoris', 'avis'
  ];
BEGIN
  FOREACH t IN ARRAY tables
  LOOP
    BEGIN
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE %I', t);
      RAISE NOTICE 'Table retirée de supabase_realtime : %', t;
    EXCEPTION
      WHEN undefined_table THEN
        RAISE NOTICE 'Table absente (publication), ignorée : %', t;
      WHEN undefined_object THEN
        RAISE NOTICE 'Table absente (publication), ignorée : %', t;
      WHEN others THEN
        RAISE NOTICE 'Déjà retirée ou non publiée, ignorée : %', t;
    END;
  END LOOP;
END $$;

-- ── Vérification rapide ─────────────────────────────────────────────────────
-- SELECT tablename, rowsecurity FROM pg_tables
--   WHERE schemaname = 'public' AND rowsecurity = true ORDER BY tablename;
--
-- ── Comment vérifier que la fuite est colmatée ──────────────────────────────
-- 1. Dans Supabase : Database → Replication → la table `commandes` ne doit plus
--    apparaître (ou être décochée) dans la publication Realtime.
-- 2. Depuis l'app : l'écran Commandes du vendeur se rafraîchit via le polling
--    (20 s) — plus aucun événement Realtime n'arrive, c'est le comportement
--    attendu et sécurisé.
-- =============================================================================
