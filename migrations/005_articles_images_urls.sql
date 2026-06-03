-- Galerie photos pour les articles (boutiques) - max 8 par article, ISO avec plats.
-- La 1ere entree doit correspondre a image_url (photo principale).
-- Idempotent: sans effet si la colonne existe deja.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS images_urls TEXT[];

COMMENT ON COLUMN articles.images_urls IS 'Galerie complementaire (max 8 URLs). La 1ere entree doit etre identique a image_url.';
