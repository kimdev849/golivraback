-- Correction pour la galerie d'images des articles et plats
-- Ce script ajoute les colonnes manquantes détectées dans le backend mais absentes de la base de données.

-- 1. Table ARTICLES
ALTER TABLE articles ADD COLUMN IF NOT EXISTS images_urls TEXT[];
ALTER TABLE articles ADD COLUMN IF NOT EXISTS dimensions JSONB;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS type_produit VARCHAR(50);
ALTER TABLE articles ADD COLUMN IF NOT EXISTS etat_produit VARCHAR(50);
ALTER TABLE articles ADD COLUMN IF NOT EXISTS marque VARCHAR(100);
ALTER TABLE articles ADD COLUMN IF NOT EXISTS poids_kg DECIMAL(10,2);

-- 2. Table PLATS (pour la cohérence)
ALTER TABLE plats ADD COLUMN IF NOT EXISTS images_urls TEXT[];

-- Commentaires pour Supabase / Documentation
COMMENT ON COLUMN articles.images_urls IS 'Galerie d''images (tableau d''URLs). La première URL doit être identique à image_url.';
COMMENT ON COLUMN articles.dimensions IS 'Dimensions physiques {l, w, h} en cm';
COMMENT ON COLUMN articles.poids_kg IS 'Poids de l''article en kilogrammes';
COMMENT ON COLUMN plats.images_urls IS 'Galerie d''images (tableau d''URLs). La première URL doit être identique à image_url.';

-- Note: Le backend utilise normalizeImagesUrls() qui supporte à la fois TEXT[] (PostgreSQL) et JSONB.
-- Nous utilisons TEXT[] ici car c'est le type le plus naturel pour une liste d'URLs.
