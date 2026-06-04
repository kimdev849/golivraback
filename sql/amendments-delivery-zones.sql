-- Tarification livraison par zones (Brazzaville) — admin configurable
-- Exécuter dans Supabase SQL Editor (idempotent).
--
-- Règle seed : zones A→E créées vides (prix 0, à définir dans l’admin).
-- Aucun arrondissement n’est rattaché à une zone ici — tout se fait dans /admin/zones.
-- Pour ajouter une zone F+ plus tard :
--   INSERT INTO zones (name, label, price_base, is_active, sort_order)
--   VALUES ('F', 'Zone F', 0, FALSE, 6) ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS zones (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name         VARCHAR(10)  NOT NULL,
  label        VARCHAR(80)  NOT NULL,
  price_base   DECIMAL(12, 2) NOT NULL DEFAULT 0 CHECK (price_base >= 0),
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order   INTEGER      NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT zones_name_unique UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS arrondissements (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name         VARCHAR(100) NOT NULL,
  zone_id      UUID         REFERENCES zones(id) ON DELETE SET NULL,
  sort_order   INTEGER      NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT arrondissements_name_unique UNIQUE (name)
);

-- Installations déjà créées avec zone_id NOT NULL (ancien script)
ALTER TABLE arrondissements
  ALTER COLUMN zone_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_arrondissements_zone_id ON arrondissements(zone_id);

CREATE TABLE IF NOT EXISTS zone_price_history (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  zone_id      UUID         NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  old_price    DECIMAL(12, 2) NOT NULL,
  new_price    DECIMAL(12, 2) NOT NULL,
  changed_by   UUID         REFERENCES utilisateurs(id) ON DELETE SET NULL,
  changed_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zone_price_history_zone ON zone_price_history(zone_id, changed_at DESC);

-- Zones A → E (prix et libellés détaillés : admin uniquement)
INSERT INTO zones (name, label, price_base, is_active, sort_order) VALUES
  ('A', 'Zone A', 0, TRUE, 1),
  ('B', 'Zone B', 0, TRUE, 2),
  ('C', 'Zone C', 0, TRUE, 3),
  ('D', 'Zone D', 0, TRUE, 4),
  ('E', 'Zone E', 0, TRUE, 5)
ON CONFLICT (name) DO NOTHING;

-- Référentiel arrondissements (sans zone_id — affectation manuelle admin)
INSERT INTO arrondissements (name, zone_id, sort_order) VALUES
  ('Centre-ville', NULL, 1),
  ('Bacongo',      NULL, 2),
  ('Poto-Poto',    NULL, 3),
  ('Makelekele',   NULL, 4),
  ('Moungali',     NULL, 5),
  ('Ouenzé',       NULL, 6),
  ('Talangaï',     NULL, 7),
  ('Mfilou',       NULL, 8),
  ('Madibou',      NULL, 9),
  ('Djiri',        NULL, 10),
  ('Autre',        NULL, 99)
ON CONFLICT (name) DO NOTHING;

-- Si vous aviez exécuté l’ancienne version du script (affectations auto A/B/C),
-- décommentez la ligne suivante pour tout remettre à configurer depuis l’admin :
-- UPDATE arrondissements SET zone_id = NULL, updated_at = NOW();
