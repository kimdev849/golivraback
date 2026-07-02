-- ============================================================================
-- Pays / Villes pour les adresses utilisateur + commerces
-- Ajoute les colonnes FK pays_id / ville_id aux tables existantes.
-- Exécuter dans Supabase SQL Editor (idempotent).
--
-- Pré-requis : les tables pays, villes, arrondissements existent déjà
-- (via amendments-pays-villes-quartiers.sql).
-- ============================================================================

-- 1. ADRESSES_UTILISATEUR (table mobile) ------------------------------------

ALTER TABLE adresses_utilisateur
  ADD COLUMN IF NOT EXISTS pays_id UUID REFERENCES pays(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ville_id UUID REFERENCES villes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_adresses_utilisateur_pays_id  ON adresses_utilisateur(pays_id);
CREATE INDEX IF NOT EXISTS idx_adresses_utilisateur_ville_id ON adresses_utilisateur(ville_id);

-- 2. RESTAURANTS -------------------------------------------------------------

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS pays_id UUID REFERENCES pays(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ville_id UUID REFERENCES villes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_restaurants_pays_id  ON restaurants(pays_id);
CREATE INDEX IF NOT EXISTS idx_restaurants_ville_id ON restaurants(ville_id);

-- 3. BOUTIQUES ---------------------------------------------------------------

ALTER TABLE boutiques
  ADD COLUMN IF NOT EXISTS pays_id UUID REFERENCES pays(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ville_id UUID REFERENCES villes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_boutiques_pays_id  ON boutiques(pays_id);
CREATE INDEX IF NOT EXISTS idx_boutiques_ville_id ON boutiques(ville_id);

-- 4. ENTREPRISES LOGISTIQUES -------------------------------------------------

ALTER TABLE entreprises_logistiques
  ADD COLUMN IF NOT EXISTS pays_id UUID REFERENCES pays(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ville_id UUID REFERENCES villes(id) ON DELETE SET NULL;

-- 5. BACKFILL : assigner Congo / Brazzaville aux enregistrements NULL ---------

DO $$
DECLARE
  v_cg_id  UUID;
  v_bzv_id UUID;
BEGIN
  SELECT id INTO v_cg_id  FROM pays WHERE code_iso2 = 'CG';
  SELECT id INTO v_bzv_id FROM villes WHERE nom = 'Brazzaville' AND pays_id = v_cg_id;

  -- adresses_utilisateur : si NULL, mettre Brazzaville / Congo
  UPDATE adresses_utilisateur
  SET pays_id = COALESCE(pays_id, v_cg_id),
      ville_id = COALESCE(ville_id, v_bzv_id)
  WHERE pays_id IS NULL OR ville_id IS NULL;

  -- restaurants
  UPDATE restaurants
  SET pays_id = COALESCE(pays_id, v_cg_id),
      ville_id = COALESCE(ville_id, v_bzv_id)
  WHERE pays_id IS NULL OR ville_id IS NULL;

  -- boutiques
  UPDATE boutiques
  SET pays_id = COALESCE(pays_id, v_cg_id),
      ville_id = COALESCE(ville_id, v_bzv_id)
  WHERE pays_id IS NULL OR ville_id IS NULL;

  -- entreprises logistiques
  UPDATE entreprises_logistiques
  SET pays_id = COALESCE(pays_id, v_cg_id),
      ville_id = COALESCE(ville_id, v_bzv_id)
  WHERE pays_id IS NULL OR ville_id IS NULL;
END $$;

-- 6. Ajouter NOT NULL après backfill (optionnel, décommentez si prêt)
-- ALTER TABLE adresses_utilisateur
--   ALTER COLUMN pays_id SET NOT NULL,
--   ALTER COLUMN ville_id SET NOT NULL;
-- ALTER TABLE restaurants
--   ALTER COLUMN pays_id SET NOT NULL,
--   ALTER COLUMN ville_id SET NOT NULL;
-- ALTER TABLE boutiques
--   ALTER COLUMN pays_id SET NOT NULL,
--   ALTER COLUMN ville_id SET NOT NULL;
