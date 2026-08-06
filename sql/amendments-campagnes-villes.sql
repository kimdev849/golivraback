-- ============================================================================
-- Campagnes marketing · Association avec les villes
-- Hiérarchie : Campagne → Villes (via campagne_villes)
-- Exécuter dans Supabase SQL Editor (idempotent).
-- ============================================================================

-- 1. CAMPAGNES MARKETING -----------------------------------------------------

CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom          VARCHAR(200) NOT NULL,
  description  TEXT,
  type         VARCHAR(50)  NOT NULL DEFAULT 'standard',
  image_url    TEXT,
  date_debut   TIMESTAMPTZ,
  date_fin     TIMESTAMPTZ,
  est_actif    BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 2. LIAISON CAMPAGNE → VILLES ----------------------------------------------

CREATE TABLE IF NOT EXISTS campagne_villes (
  campagne_id  UUID NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  ville_id     UUID NOT NULL REFERENCES villes(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campagne_id, ville_id)
);

CREATE INDEX IF NOT EXISTS idx_campagne_villes_ville_id ON campagne_villes(ville_id);

-- ============================================================================
-- SEED : exemple de campagne (désactivé par défaut)
-- La section campagne n'apparaît sur l'accueil QUE si une campagne est
-- réellement en cours (est_actif = true et dans sa période de diffusion).
-- ============================================================================

-- Campagne de démonstration créée inactive : elle ne s'affiche pas sur l'accueil.
-- Pour l'activer, passez est_actif à TRUE dans l'admin (Campagnes).
INSERT INTO marketing_campaigns (id, nom, description, type, est_actif)
VALUES ('00000000-0000-0000-0000-00000000c001', 'Bienvenue sur GoLivra', 'Campagne de lancement pour les nouveaux utilisateurs', 'standard', FALSE)
ON CONFLICT (id) DO UPDATE SET est_actif = FALSE, updated_at = NOW();

-- Désactive toute ancienne campagne de démonstration déjà créée active (idempotent).
-- Ciblée par la description de démo pour ne pas toucher une campagne réelle homonyme.
UPDATE marketing_campaigns
SET est_actif = FALSE, updated_at = NOW()
WHERE nom = 'Bienvenue sur GoLivra'
  AND description = 'Campagne de lancement pour les nouveaux utilisateurs'
  AND est_actif = TRUE;
