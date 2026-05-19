-- Extension catalogue articles (boutiques) — à exécuter sur Supabase si absent
ALTER TABLE articles ADD COLUMN IF NOT EXISTS images_urls TEXT[];
ALTER TABLE articles ADD COLUMN IF NOT EXISTS type_produit VARCHAR(20);
ALTER TABLE articles ADD COLUMN IF NOT EXISTS etat_produit VARCHAR(20);
ALTER TABLE articles ADD COLUMN IF NOT EXISTS marque VARCHAR(100);
ALTER TABLE articles ADD COLUMN IF NOT EXISTS poids_kg DECIMAL(8, 3);
ALTER TABLE articles ADD COLUMN IF NOT EXISTS dimensions JSONB;
