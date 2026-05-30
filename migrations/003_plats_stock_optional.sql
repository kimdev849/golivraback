-- Stock facultatif pour les plats (NULL = quantité non suivie, comme les articles boutique).
ALTER TABLE plats ADD COLUMN IF NOT EXISTS stock INTEGER;

COMMENT ON COLUMN plats.stock IS 'NULL = pas de suivi de stock ; entier >= 0 = quantité limitée (optionnel)';
