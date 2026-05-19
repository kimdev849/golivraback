-- Livraisons hors commande (logistique pure) — extension table livraisons
-- À exécuter sur Supabase / PostgreSQL (schéma v3).
--
-- ⚠️ Si type_livraison n’existe pas encore : utilisez plutôt
--    amendments-livraison-directe-client.sql (fichier unique, migration complète).

-- A. Type de livraison
ALTER TABLE livraisons
  ADD COLUMN IF NOT EXISTS type_livraison VARCHAR(20) NOT NULL DEFAULT 'commande';

-- B. Sous-commande optionnelle pour livraisons externes
ALTER TABLE livraisons
  ALTER COLUMN sous_commande_id DROP NOT NULL;

-- C. Établissement source (obligatoire pour type externe)
ALTER TABLE livraisons
  ADD COLUMN IF NOT EXISTS restaurant_id UUID REFERENCES restaurants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS boutique_id UUID REFERENCES boutiques(id) ON DELETE SET NULL;

-- D. Champs client / montant (livraison externe)
ALTER TABLE livraisons
  ADD COLUMN IF NOT EXISTS client_nom TEXT,
  ADD COLUMN IF NOT EXISTS client_telephone TEXT,
  ADD COLUMN IF NOT EXISTS montant_total DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS note TEXT;

-- Contraintes métier
ALTER TABLE livraisons DROP CONSTRAINT IF EXISTS chk_livraison_type_commande;
ALTER TABLE livraisons
  ADD CONSTRAINT chk_livraison_type_commande CHECK (
    (type_livraison = 'commande' AND sous_commande_id IS NOT NULL)
    OR
    (type_livraison = 'externe' AND sous_commande_id IS NULL)
  );

ALTER TABLE livraisons DROP CONSTRAINT IF EXISTS chk_livraison_etablissement_externe;
ALTER TABLE livraisons
  ADD CONSTRAINT chk_livraison_etablissement_externe CHECK (
    type_livraison = 'commande'
    OR (
      type_livraison = 'externe'
      AND (
        (restaurant_id IS NOT NULL AND boutique_id IS NULL)
        OR (boutique_id IS NOT NULL AND restaurant_id IS NULL)
      )
    )
  );

ALTER TABLE livraisons DROP CONSTRAINT IF EXISTS chk_livraison_type_valeur;
ALTER TABLE livraisons
  ADD CONSTRAINT chk_livraison_type_valeur CHECK (type_livraison IN ('commande', 'externe'));

CREATE INDEX IF NOT EXISTS idx_livraisons_type_livraison ON livraisons(type_livraison);
CREATE INDEX IF NOT EXISTS idx_livraisons_restaurant_id ON livraisons(restaurant_id) WHERE restaurant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_livraisons_boutique_id ON livraisons(boutique_id) WHERE boutique_id IS NOT NULL;
