-- ============================================================================
-- GOLIVRA — NETTOYAGE DES DONNÉES DE TEST (commandes « Smoke Test »)
-- ============================================================================
-- À exécuter dans Supabase → SQL Editor → Run.
--
-- ⚠️  Ce script supprime UNIQUEMENT :
--   • les commandes créées pendant les tests techniques (client « Smoke Test »
--     ou « Smoke2 », adresse « Smoke test - Bacongo… ») et TOUTES leurs données
--     liées (sous-commandes, articles, livraisons, paiements, commissions,
--     avis, codes promo),
--   • les comptes jetables associés, mais UNIQUEMENT s'ils ne possèdent aucun
--     commerce et n'ont plus aucune commande.
--
-- ✅ SÉCURISÉ : aucune vraie commande, aucun vrai commerce, aucun vrai compte
--    client ne peut être supprimé par ce script (garde-fous ci-dessous).
--    Idempotent : rejouable sans risque (ne supprime que ce qui correspond).
--
-- 🔍 APERÇU : la première requête (SELECT) liste ce qui VA être supprimé —
--    vérifiez les lignes retournées avant la suppression.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────
-- 0. APERÇU — ce qui va être supprimé (à vérifier)
-- ─────────────────────────────────────────────────────────────
SELECT c.numero,
       c.statut,
       COALESCE(u.nom, '(client supprimé)') AS client,
       c.total,
       c.created_at
FROM commandes c
LEFT JOIN utilisateurs u ON u.id = c.client_id
WHERE (u.nom IN ('Smoke Test', 'Smoke2'))
   OR (c.adresse_livraison_snapshot::text ILIKE '%Smoke test%');


-- ─────────────────────────────────────────────────────────────
-- 1. SUPPRESSION (transaction atomique)
-- ─────────────────────────────────────────────────────────────
BEGIN;

-- Sous-commandes concernées (via la commande de test)
-- 1.1 Avis liés aux sous-commandes de test
DELETE FROM avis_restaurants
WHERE sous_commande_id IN (
  SELECT sc.id FROM sous_commandes sc
  JOIN commandes c ON c.id = sc.commande_id
  LEFT JOIN utilisateurs u ON u.id = c.client_id
  WHERE (u.nom IN ('Smoke Test', 'Smoke2'))
     OR (c.adresse_livraison_snapshot::text ILIKE '%Smoke test%')
);

DELETE FROM avis_boutiques
WHERE sous_commande_id IN (
  SELECT sc.id FROM sous_commandes sc
  JOIN commandes c ON c.id = sc.commande_id
  LEFT JOIN utilisateurs u ON u.id = c.client_id
  WHERE (u.nom IN ('Smoke Test', 'Smoke2'))
     OR (c.adresse_livraison_snapshot::text ILIKE '%Smoke test%')
);

DELETE FROM avis_plats
WHERE sous_commande_id IN (
  SELECT sc.id FROM sous_commandes sc
  JOIN commandes c ON c.id = sc.commande_id
  LEFT JOIN utilisateurs u ON u.id = c.client_id
  WHERE (u.nom IN ('Smoke Test', 'Smoke2'))
     OR (c.adresse_livraison_snapshot::text ILIKE '%Smoke test%')
);

DELETE FROM avis_articles
WHERE sous_commande_id IN (
  SELECT sc.id FROM sous_commandes sc
  JOIN commandes c ON c.id = sc.commande_id
  LEFT JOIN utilisateurs u ON u.id = c.client_id
  WHERE (u.nom IN ('Smoke Test', 'Smoke2'))
     OR (c.adresse_livraison_snapshot::text ILIKE '%Smoke test%')
);

-- 1.2 Commissions des sous-commandes de test
DELETE FROM commissions
WHERE sous_commande_id IN (
  SELECT sc.id FROM sous_commandes sc
  JOIN commandes c ON c.id = sc.commande_id
  LEFT JOIN utilisateurs u ON u.id = c.client_id
  WHERE (u.nom IN ('Smoke Test', 'Smoke2'))
     OR (c.adresse_livraison_snapshot::text ILIKE '%Smoke test%')
);

-- 1.3 Livraisons des sous-commandes de test
DELETE FROM livraisons
WHERE sous_commande_id IN (
  SELECT sc.id FROM sous_commandes sc
  JOIN commandes c ON c.id = sc.commande_id
  LEFT JOIN utilisateurs u ON u.id = c.client_id
  WHERE (u.nom IN ('Smoke Test', 'Smoke2'))
     OR (c.adresse_livraison_snapshot::text ILIKE '%Smoke test%')
);

-- 1.4 Codes promo utilisés sur les commandes de test
DELETE FROM utilisations_code_promo
WHERE commande_id IN (
  SELECT c.id FROM commandes c
  LEFT JOIN utilisateurs u ON u.id = c.client_id
  WHERE (u.nom IN ('Smoke Test', 'Smoke2'))
     OR (c.adresse_livraison_snapshot::text ILIKE '%Smoke test%')
);

-- 1.5 Paiements des commandes de test
DELETE FROM paiements
WHERE commande_id IN (
  SELECT c.id FROM commandes c
  LEFT JOIN utilisateurs u ON u.id = c.client_id
  WHERE (u.nom IN ('Smoke Test', 'Smoke2'))
     OR (c.adresse_livraison_snapshot::text ILIKE '%Smoke test%')
);

-- 1.6 Sous-commandes de test (les lignes articles partent en CASCADE)
DELETE FROM sous_commandes
WHERE id IN (
  SELECT sc.id FROM sous_commandes sc
  JOIN commandes c ON c.id = sc.commande_id
  LEFT JOIN utilisateurs u ON u.id = c.client_id
  WHERE (u.nom IN ('Smoke Test', 'Smoke2'))
     OR (c.adresse_livraison_snapshot::text ILIKE '%Smoke test%')
);

-- 1.7 Commandes de test elles-mêmes
DELETE FROM commandes
WHERE id IN (
  SELECT c.id FROM commandes c
  LEFT JOIN utilisateurs u ON u.id = c.client_id
  WHERE (u.nom IN ('Smoke Test', 'Smoke2'))
     OR (c.adresse_livraison_snapshot::text ILIKE '%Smoke test%')
);

-- 1.8 Comptes jetables de test — SEULEMENT s'ils n'ont plus rien :
--     aucun commerce possédé ET plus aucune commande restante.
--     (Les tables sessions / adresses / paniers / favoris / notifications
--      partent en CASCADE sur la suppression de l'utilisateur.)
DELETE FROM utilisateurs
WHERE nom IN ('Smoke Test', 'Smoke2')
  AND NOT EXISTS (
    SELECT 1 FROM restaurants r WHERE r.proprietaire_id = utilisateurs.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM boutiques b WHERE b.proprietaire_id = utilisateurs.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM commandes c WHERE c.client_id = utilisateurs.id
  );

COMMIT;

-- ─────────────────────────────────────────────────────────────
-- 2. VÉRIFICATION — doit retourner 0 ligne
-- ─────────────────────────────────────────────────────────────
SELECT c.numero, c.statut, u.nom AS client
FROM commandes c
LEFT JOIN utilisateurs u ON u.id = c.client_id
WHERE (u.nom IN ('Smoke Test', 'Smoke2'))
   OR (c.adresse_livraison_snapshot::text ILIKE '%Smoke test%');
