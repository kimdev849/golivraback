-- Galerie produit / plat (URLs supplémentaires, max 8)
-- À exécuter sur Supabase avant prod si les colonnes manquent.

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS images_urls JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE plats
  ADD COLUMN IF NOT EXISTS images_urls JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN articles.images_urls IS 'URLs HTTPS des photos (principale + galerie), ordre d''affichage';
COMMENT ON COLUMN plats.images_urls IS 'URLs HTTPS des photos (principale + galerie), ordre d''affichage';
