-- =============================================================================
-- verify-rls.sql — Vérifier l'état RLS / Realtime AVANT et APRÈS application
-- =============================================================================
-- Lecture seule : aucun changement. À exécuter dans Supabase → SQL Editor.
--
-- AVANT : confirme que les tables sensibles n'ont PAS de RLS (le trou).
-- APRÈS  : confirme que tout est verrouillé (rls = true, aucune policy anon).
-- =============================================================================

-- 1. Tables sensibles et leur état RLS (rowsecurity = false = VULNÉRABLE)
SELECT tablename, rowsecurity AS rls_active
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'roles','utilisateurs','sessions','otp_codes','otp','adresses_utilisateur',
    'entreprises','entreprises_livraison','horaires_entreprise','categories',
    'categories_restaurants','categories_boutiques','categories_produits',
    'categories_menus','entreprises_categories','produits','menus',
    'commandes_menus','articles','paniers','panier_articles','commandes',
    'sous_commandes','commande_articles','livraisons','positions_livreurs',
    'livreurs','paiements','paiements_pawapay','remboursements','retraits',
    'portefeuilles','transactions','escrow','notifications','favoris','avis',
    'promotions','commandes_promotions','logs_admin','parametres',
    'parametres_systeme','campagnes','codes_promo','zones_livraison','pays',
    'villes','quartiers','tokens_push','app_status','annonces',
    'observabilite_incidents','usage_events','usage_tracking','endpoint_health'
  )
ORDER BY tablename;

-- 2. Policies RLS existantes sur ces tables (attendu APRÈS : aucune pour anon)
SELECT tablename, policyname, roles
FROM pg_policies
WHERE schemaname = 'public';

-- 3. Tables encore dans la publication Realtime (attendu APRÈS : les tables
--    sensibles n'y figurent plus)
SELECT schemaname, tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
ORDER BY tablename;

-- 4. Privilèges anon sur une table sensible (attendu APRÈS : aucun)
SELECT grantee, privilege_type, table_name
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name = 'commandes'
  AND grantee IN ('anon', 'authenticated')
ORDER BY grantee, privilege_type;
