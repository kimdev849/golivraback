-- ============================================================================
-- Pays · Villes · Arrondissements · Zones de livraison
-- Référentiel géographique complet pour les adresses de livraison.
-- Exécuter dans Supabase SQL Editor (idempotent).
--
-- Hiérarchie :
--   Pays (Congo)
--     → Villes (Brazzaville)
--       → Arrondissements (Bacongo, Makelekele…)
--         → Zones de livraison (A, B, C, D, E)
--
-- La table `arrondissements` et `zones` sont déjà créées par
-- amendments-delivery-zones.sql. Ce script ajoute ville_id à
-- arrondissements et seed les données manquantes.
-- ============================================================================

-- 1. PAYS -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pays (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom         VARCHAR(100) NOT NULL,
  code_iso2   VARCHAR(2)   NOT NULL,
  code_iso3   VARCHAR(3)   NOT NULL,
  indicatif   VARCHAR(6)            DEFAULT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT pays_code_iso2_unique UNIQUE (code_iso2),
  CONSTRAINT pays_code_iso3_unique UNIQUE (code_iso3)
);

-- 2. VILLES ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS villes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pays_id     UUID         NOT NULL REFERENCES pays(id) ON DELETE CASCADE,
  nom         VARCHAR(150) NOT NULL,
  sort_order  INTEGER      NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT villes_pays_nom_unique UNIQUE (pays_id, nom)
);

CREATE INDEX IF NOT EXISTS idx_villes_pays_id ON villes(pays_id);

-- 3. ARRONDISSEMENTS → lien avec villes + zones ------------------------------

ALTER TABLE arrondissements
  ADD COLUMN IF NOT EXISTS ville_id UUID REFERENCES villes(id) ON DELETE SET NULL;

-- Remplacer la contrainte globale UNIQUE (name) par UNIQUE (ville_id, name)
-- pour permettre les mêmes noms d'arrondissements dans différentes villes
-- (ex. "Centre-ville" existe à Brazzaville ET Pointe-Noire)
ALTER TABLE arrondissements DROP CONSTRAINT IF EXISTS arrondissements_name_unique;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'arrondissements_ville_nom_unique'
  ) THEN
    ALTER TABLE arrondissements
      ADD CONSTRAINT arrondissements_ville_nom_unique UNIQUE (ville_id, name);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_arrondissements_ville_id ON arrondissements(ville_id);

-- ============================================================================
-- SEED DATA : Congo + pays voisins
-- ============================================================================

-- ── PAYS ────────────────────────────────────────────────────────────────────

INSERT INTO pays (nom, code_iso2, code_iso3, indicatif) VALUES
  ('Congo',                        'CG', 'COG', '+242'),
  ('République Démocratique du Congo', 'CD', 'COD', '+243'),
  ('Gabon',                        'GA', 'GAB', '+241'),
  ('Cameroun',                     'CM', 'CMR', '+237'),
  ('République Centrafricaine',    'CF', 'CAF', '+236'),
  ('Angola',                       'AO', 'AGO', '+244')
ON CONFLICT (code_iso2) DO NOTHING;

-- ── VILLES + ARRONDISSEMENTS (bloc procédural) ──────────────────────────────

DO $$
DECLARE
  v_cg_id UUID;
  v_cd_id UUID;
  v_ga_id UUID;
  v_cm_id UUID;
  v_cf_id UUID;
  v_ao_id UUID;
  v_bzv_id UUID;
BEGIN
  SELECT id INTO v_cg_id FROM pays WHERE code_iso2 = 'CG';
  SELECT id INTO v_cd_id FROM pays WHERE code_iso2 = 'CD';
  SELECT id INTO v_ga_id FROM pays WHERE code_iso2 = 'GA';
  SELECT id INTO v_cm_id FROM pays WHERE code_iso2 = 'CM';
  SELECT id INTO v_cf_id FROM pays WHERE code_iso2 = 'CF';
  SELECT id INTO v_ao_id FROM pays WHERE code_iso2 = 'AO';

  -- ── Congo ──────────────────────────────────────────────────────────────
  INSERT INTO villes (pays_id, nom, sort_order) VALUES
    (v_cg_id, 'Brazzaville',   1),
    (v_cg_id, 'Pointe-Noire',  2),
    (v_cg_id, 'Dolisie',       3),
    (v_cg_id, 'Nkayi',         4),
    (v_cg_id, 'Owando',        5),
    (v_cg_id, 'Ouesso',        6),
    (v_cg_id, 'Madingou',      7),
    (v_cg_id, 'Sibiti',        8),
    (v_cg_id, 'Kinkala',       9),
    (v_cg_id, 'Impfondo',     10),
    (v_cg_id, 'Ewo',          11),
    (v_cg_id, 'Mossaka',      12)
  ON CONFLICT (pays_id, nom) DO NOTHING;

  -- ── RDC ────────────────────────────────────────────────────────────────
  INSERT INTO villes (pays_id, nom, sort_order) VALUES
    (v_cd_id, 'Kinshasa',      1),
    (v_cd_id, 'Lubumbashi',    2),
    (v_cd_id, 'Mbuji-Mayi',    3),
    (v_cd_id, 'Kananga',       4),
    (v_cd_id, 'Kisangani',     5),
    (v_cd_id, 'Goma',          6),
    (v_cd_id, 'Bukavu',        7),
    (v_cd_id, 'Matadi',        8),
    (v_cd_id, 'Boma',          9),
    (v_cd_id, 'Mwene-Ditu',   10),
    (v_cd_id, 'Kikwit',       11),
    (v_cd_id, 'Uvira',        12)
  ON CONFLICT (pays_id, nom) DO NOTHING;

  -- ── Gabon ──────────────────────────────────────────────────────────────
  INSERT INTO villes (pays_id, nom, sort_order) VALUES
    (v_ga_id, 'Libreville',    1),
    (v_ga_id, 'Port-Gentil',   2),
    (v_ga_id, 'Franceville',   3),
    (v_ga_id, 'Oyem',          4),
    (v_ga_id, 'Moanda',        5),
    (v_ga_id, 'Mouila',        6),
    (v_ga_id, 'Lambaréné',     7),
    (v_ga_id, 'Tchibanga',     8),
    (v_ga_id, 'Koulamoutou',   9),
    (v_ga_id, 'Makokou',      10)
  ON CONFLICT (pays_id, nom) DO NOTHING;

  -- ── Cameroun ───────────────────────────────────────────────────────────
  INSERT INTO villes (pays_id, nom, sort_order) VALUES
    (v_cm_id, 'Yaoundé',       1),
    (v_cm_id, 'Douala',        2),
    (v_cm_id, 'Garoua',        3),
    (v_cm_id, 'Bamenda',       4),
    (v_cm_id, 'Maroua',        5),
    (v_cm_id, 'Nkongsamba',    6),
    (v_cm_id, 'Bafoussam',     7),
    (v_cm_id, 'Ngaoundéré',    8),
    (v_cm_id, 'Bertoua',       9),
    (v_cm_id, 'Loum',         10),
    (v_cm_id, 'Kumba',        11),
    (v_cm_id, 'Edéa',         12)
  ON CONFLICT (pays_id, nom) DO NOTHING;

  -- ── Centrafrique ───────────────────────────────────────────────────────
  INSERT INTO villes (pays_id, nom, sort_order) VALUES
    (v_cf_id, 'Bangui',        1),
    (v_cf_id, 'Bimbo',         2),
    (v_cf_id, 'Berbérati',     3),
    (v_cf_id, 'Bossangoa',     4),
    (v_cf_id, 'Bambari',       5),
    (v_cf_id, 'Bouar',         6),
    (v_cf_id, 'Bangassou',     7),
    (v_cf_id, 'Mbaïki',        8),
    (v_cf_id, 'Kaga-Bandoro',  9),
    (v_cf_id, 'Sibut',        10)
  ON CONFLICT (pays_id, nom) DO NOTHING;

  -- ── Angola ─────────────────────────────────────────────────────────────
  INSERT INTO villes (pays_id, nom, sort_order) VALUES
    (v_ao_id, 'Luanda',        1),
    (v_ao_id, 'Cabinda',       2),
    (v_ao_id, 'Huambo',        3),
    (v_ao_id, 'Lubango',       4),
    (v_ao_id, 'Benguela',      5),
    (v_ao_id, 'Malanje',       6),
    (v_ao_id, 'Saurimo',       7),
    (v_ao_id, 'Uíge',          8),
    (v_ao_id, 'Mbanza Congo',  9),
    (v_ao_id, 'Caxito',       10),
    (v_ao_id, 'Lobito',       11),
    (v_ao_id, 'Namibe',       12)
  ON CONFLICT (pays_id, nom) DO NOTHING;

  -- ── Lier les arrondissements existants à Brazzaville ──────────────────
  SELECT id INTO v_bzv_id FROM villes WHERE pays_id = v_cg_id AND nom = 'Brazzaville';

  UPDATE arrondissements
  SET ville_id = v_bzv_id
  WHERE nom IN ('Centre-ville', 'Bacongo', 'Poto-Poto', 'Makelekele', 'Moungali',
                 'Ouenzé', 'Talangaï', 'Mfilou', 'Madibou', 'Djiri', 'Autre')
    AND ville_id IS NULL;

  -- ── ARRONDISSEMENTS : Pointe-Noire (ville_id) ──────────────────────────
  INSERT INTO arrondissements (name, sort_order, ville_id, zone_id)
  SELECT a.name, a.sort_order, v.id, NULL
  FROM (SELECT id FROM villes WHERE pays_id = v_cg_id AND nom = 'Pointe-Noire') v
  CROSS JOIN (VALUES
    ('Centre-ville', 1), ('Mpaka', 2), ('Mvoumvou', 3), ('Tié-Tié', 4),
    ('Ngoyo', 5), ('Loandjili', 6), ('Siafoumou', 7), ('Autre', 99)
  ) AS a(name, sort_order)
  WHERE NOT EXISTS (
    SELECT 1 FROM arrondissements WHERE name = a.name AND ville_id = v.id
  );

  -- ── ARRONDISSEMENTS : Kinshasa (ville_id) ─────────────────────────────
  INSERT INTO arrondissements (name, sort_order, ville_id, zone_id)
  SELECT a.name, a.sort_order, v.id, NULL
  FROM (SELECT id FROM villes WHERE pays_id = v_cd_id AND nom = 'Kinshasa') v
  CROSS JOIN (VALUES
    ('Gombe', 1), ('Kalamu', 2), ('Kasa-Vubu', 3), ('Lingwala', 4),
    ('Kitambo', 5), ('Barumbu', 6), ('Limete', 7), ('Masina', 8),
    ('Matete', 9), ('Ndjili', 10), ('Kisenso', 11), ('Lemba', 12),
    ('Ngaliema', 13), ('Selembao', 14), ('Bumbu', 15), ('Mont-Ngafula', 16),
    ('Makala', 17), ('Autre', 99)
  ) AS a(name, sort_order)
  WHERE NOT EXISTS (
    SELECT 1 FROM arrondissements WHERE name = a.name AND ville_id = v.id
  );

  -- ── ARRONDISSEMENTS : Libreville (ville_id) ───────────────────────────
  INSERT INTO arrondissements (name, sort_order, ville_id, zone_id)
  SELECT a.name, a.sort_order, v.id, NULL
  FROM (SELECT id FROM villes WHERE pays_id = v_ga_id AND nom = 'Libreville') v
  CROSS JOIN (VALUES
    ('Centre-ville', 1), ('Nkembo', 2), ('Mont-Bouët', 3), ('Lalala', 4),
    ('Gros-Bouquet', 5), ('Batavéa', 6), ('Sainte-Marie', 7), ('Autre', 99)
  ) AS a(name, sort_order)
  WHERE NOT EXISTS (
    SELECT 1 FROM arrondissements WHERE name = a.name AND ville_id = v.id
  );

END $$;

-- ============================================================================
-- LIEN AVEC LA TABLE `adresses` EXISTANTE
-- ============================================================================

ALTER TABLE adresses
  ADD COLUMN IF NOT EXISTS pays_id         UUID REFERENCES pays(id)          ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ville_id        UUID REFERENCES villes(id)        ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS arrondissement_id UUID REFERENCES arrondissements(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_adresses_pays_id          ON adresses(pays_id);
CREATE INDEX IF NOT EXISTS idx_adresses_ville_id         ON adresses(ville_id);
CREATE INDEX IF NOT EXISTS idx_adresses_arrondissement_id ON adresses(arrondissement_id);
