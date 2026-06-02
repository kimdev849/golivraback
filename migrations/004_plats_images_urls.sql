-- Galerie photos pour les plats (max 8 par plat, ISO avec la table articles).
-- La 1ère entrée doit correspondre à image_url (photo principale).
ALTER TABLE plats ADD COLUMN IF NOT EXISTS images_urls TEXT[];

COMMENT ON COLUMN plats.images_urls IS 'Galerie complementaire (max 8 URLs). La 1ere entree doit etre identique a image_url.';
