-- ================================================================
-- GOLIVRA — RESET RADICAL DE LA PLATEFORME
-- ================================================================
-- ⚠️  IRRÉVERSIBLE — à exécuter UNIQUEMENT sur la base cible
-- (Supabase → SQL Editor) APRÈS avoir fait une sauvegarde.
--
-- Ce script remet la base À ZÉRO, sans exception :
--   ✅ Supprime TOUS les comptes : clients, vendeurs (restaurants &
--      boutiques), livreurs, et TOUTES leurs données : entreprises,
--      produits, menus, commandes, paiements, portefeuilles, escrows,
--      retraits, avis, favoris, notifications, tokens push, stats…
--   ✅ Supprime AUSSI les données de plateforme : catégories,
--      campagnes marketing, codes promo, paramètres, observabilité,
--      journaux admin, zones de livraison…
--
-- Fonctionnement : il découvre automatiquement TOUTES les tables du
-- schéma `public` et les vide (TRUNCATE RESTART IDENTITY CASCADE),
-- sauf la liste courte ci-dessous. Aucune table n'est oubliée.
--
-- CONSERVÉ (indispensable au fonctionnement, pas des « données ») :
--   • les comptes ADMIN + leurs sessions (ils restent connectés)
--   • les profils staff web (login du site admin)
--   • la table `roles` (référence des rôles — FK de utilisateurs)
--   • le référentiel géographique `pays` / `villes` / `arrondissements`
--     (sans lui, l'inscription et la localisation sont cassées ;
--      le compte admin y est lui-même rattaché)
--
-- Garde de sécurité : le script REFUSE de tourner s'il ne trouve
-- aucun compte admin, et s'annule COMPLÈTEMENT (rollback) si au moins
-- une table n'a pas pu être vidée (les NOTICE listent les tables en cause).
-- ================================================================

BEGIN;

-- ── 0) Garde-fou : au moins un compte admin doit exister ────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM utilisateurs u
    JOIN roles r ON r.id = u.role_id
    WHERE r.nom = 'admin'
  ) THEN
    RAISE EXCEPTION
      'Aucun compte admin trouvé — opération annulée. Créez un admin avant de lancer ce reset.';
  END IF;
END $$;

-- ── 1) Vidage de TOUTES les tables du schéma public ─────────────
-- (sauf la liste conservée ; RESTART IDENTITY remet les compteurs à
--  zéro ; CASCADE nettoie aussi les tables liées. Aucune table
--  conservée ne référence une table vidée — zones mis à part, géré
--  plus bas — donc rien d'indispensable ne peut être tronqué.)
DO $$
DECLARE
  t      text;
  kept   text[] := ARRAY[
    'roles', 'utilisateurs', 'sessions', 'profils_staff_web',
    'pays', 'villes', 'arrondissements', 'zones'
  ];
  failed int := 0;
BEGIN
  FOR t IN
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name <> ALL (kept)
    ORDER BY table_name
  LOOP
    BEGIN
      EXECUTE format('TRUNCATE TABLE %I RESTART IDENTITY CASCADE', t);
    EXCEPTION WHEN OTHERS THEN
      failed := failed + 1;
      RAISE NOTICE 'Échec du vidage de la table « % » : %', t, SQLERRM;
    END;
  END LOOP;

  IF failed > 0 THEN
    RAISE EXCEPTION
      'Reset annulé : % table(s) n''ont pas pu être vidées. Voir les NOTICE ci-dessus.', failed;
  END IF;
END $$;

-- ── 2) Zones de livraison ────────────────────────────────────────
-- La FK `arrondissements_zone_id_fkey` peut être en NO ACTION (pas
-- SET NULL) en base réelle : on détache d'abord les arrondissements,
-- puis on vide les zones (leur historique a déjà été vidé à l'étape 1).
UPDATE arrondissements SET zone_id = NULL WHERE zone_id IS NOT NULL;
DELETE FROM zones;

-- ── 3) Sessions des comptes non-admin (les sessions admin restent) ──
-- (explicite et volontaire : les admins restent connectés après le reset)
DELETE FROM sessions s
WHERE s.utilisateur_id NOT IN (
  SELECT u.id
  FROM utilisateurs u
  JOIN roles r ON r.id = u.role_id
  WHERE r.nom = 'admin'
);

-- ── 4) Suppression de TOUS les comptes non-admin ────────────────
-- (toutes les tables liées ont été vidées à l'étape 1 ; les tables
--  conservées qui pointent vers utilisateurs sont en ON DELETE CASCADE)
DELETE FROM utilisateurs
WHERE id NOT IN (
  SELECT u.id
  FROM utilisateurs u
  JOIN roles r ON r.id = u.role_id
  WHERE r.nom = 'admin'
);

-- ── 5) Vérification : il ne reste que les admins ────────────────
SELECT count(*) AS utilisateurs_restants FROM utilisateurs;

SELECT u.nom, u.telephone, r.nom AS role
FROM utilisateurs u
JOIN roles r ON r.id = u.role_id
ORDER BY r.nom, u.nom;

COMMIT;
