-- ============================================================================
-- GoLivra — Nettoyage : retirer le logo de la boutique des photos produits
-- ============================================================================
--
-- Problème : certains produits / plats ont le LOGO de la boutique stocké comme
-- image principale (ou dans la galerie), parce qu'il a été réutilisé à la
-- création. Résultat : l'écran « Vos produits » affiche le logo KD au lieu de
-- la vraie photo du produit.
--
-- Ce script :
--   1. retire des galeries (images_urls) toute URL qui est le logo du commerce
--      (identique à logo_url, ou stockée dans le dossier « enterprises/ »)
--   2. si l'image principale (image_url) est le logo, la remplace par la
--      1ʳᵉ vraie photo restante de la galerie, sinon la met à NULL
--
-- SÉCURITÉ : transaction complète — si une erreur survient, tout est annulé.
-- ⚠️ À exécuter dans le SQL Editor Supabase. Faites une sauvegarde avant.
-- ============================================================================

BEGIN;

-- Normalise une URL d'image : sans les paramètres de resize (?width=…&format=webp)
-- qui diffèrent selon la provenance, pour comparer le vrai fichier.
DROP FUNCTION IF EXISTS golivra_storage_key(TEXT);
CREATE OR REPLACE FUNCTION golivra_storage_key(u TEXT)
RETURNS TEXT AS $$
  SELECT CASE
    WHEN u IS NULL THEN NULL
    ELSE split_part(u, '?', 1)
  END;
$$ LANGUAGE sql IMMUTABLE;

-- ---- 1. PLATS (restaurants) ---------------------------------------------
-- 1a. Retirer le logo de la galerie des plats
UPDATE plats p
SET images_urls = COALESCE(
        (SELECT jsonb_agg(elem)
           FROM jsonb_array_elements_text(p.images_urls) AS elem
          WHERE elem IS NOT NULL
            AND golivra_storage_key(elem) <> COALESCE(golivra_storage_key(r.logo_url), '')
            AND elem NOT LIKE '%/enterprises/%'),
        '[]'::jsonb)
  FROM restaurants r
 WHERE p.restaurant_id = r.id
   AND jsonb_array_length(p.images_urls) > 0;

-- 1b. Image principale = logo → promouvoir la 1ʳᵉ photo de la galerie
UPDATE plats p
   SET image_url = COALESCE(
         CASE WHEN golivra_storage_key(p.image_url) = golivra_storage_key(r.logo_url)
              THEN NULL ELSE p.image_url END,
         (SELECT elem
            FROM jsonb_array_elements_text(p.images_urls) AS elem
           WHERE elem IS NOT NULL
           LIMIT 1)
       )
  FROM restaurants r
 WHERE p.restaurant_id = r.id
   AND (golivra_storage_key(p.image_url) = golivra_storage_key(r.logo_url)
        OR p.image_url LIKE '%/enterprises/%');

-- 1c. Image principale résiduelle dans enterprises/ → NULL (plus de logo)
UPDATE plats p
   SET image_url = NULL
 WHERE p.image_url LIKE '%/enterprises/%';

-- ---- 2. ARTICLES (boutiques) --------------------------------------------
-- 2a. Retirer le logo de la galerie des articles
UPDATE articles a
SET images_urls = COALESCE(
        (SELECT jsonb_agg(elem)
           FROM jsonb_array_elements_text(a.images_urls) AS elem
          WHERE elem IS NOT NULL
            AND golivra_storage_key(elem) <> COALESCE(golivra_storage_key(b.logo_url), '')
            AND elem NOT LIKE '%/enterprises/%'),
        '[]'::jsonb)
  FROM boutiques b
 WHERE a.boutique_id = b.id
   AND jsonb_array_length(a.images_urls) > 0;

-- 2b. Image principale = logo → promouvoir la 1ʳᵉ photo de la galerie
UPDATE articles a
   SET image_url = COALESCE(
         CASE WHEN golivra_storage_key(a.image_url) = golivra_storage_key(b.logo_url)
              THEN NULL ELSE a.image_url END,
         (SELECT elem
            FROM jsonb_array_elements_text(a.images_urls) AS elem
           WHERE elem IS NOT NULL
           LIMIT 1)
       )
  FROM boutiques b
 WHERE a.boutique_id = b.id
   AND (golivra_storage_key(a.image_url) = golivra_storage_key(b.logo_url)
        OR a.image_url LIKE '%/enterprises/%');

-- 2c. Image principale résiduelle dans enterprises/ → NULL (plus de logo)
UPDATE articles a
   SET image_url = NULL
 WHERE a.image_url LIKE '%/enterprises/%';

-- ---- 3. Rapport ----------------------------------------------------------
SELECT 'plats' AS table_name,
       count(*) FILTER (WHERE image_url IS NOT NULL) AS avec_image,
       count(*) FILTER (WHERE image_url IS NULL)     AS sans_image
  FROM plats
UNION ALL
SELECT 'articles',
       count(*) FILTER (WHERE image_url IS NOT NULL),
       count(*) FILTER (WHERE image_url IS NULL)
  FROM articles;

-- Nettoyage de la fonction d'aide (elle n'a plus d'usage après le script)
DROP FUNCTION IF EXISTS golivra_storage_key(TEXT);

COMMIT;
