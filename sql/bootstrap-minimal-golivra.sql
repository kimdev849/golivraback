-- ============================================================================
-- GoLivra — Bootstrap minimal après reset complet
-- ============================================================================
--
-- Remet en place la structure minimale pour redémarrer la plateforme :
--   1. Extensions + type ENUM role_nom + table roles (les 6 rôles)
--   2. Types de commerces + catégories du catalogue : types de restaurants,
--      types de boutiques, catégories de plats, catégories de produits
--      (tous modifiables depuis l'admin → /admin/categories)
--   3. Référentiel géo minimal : Congo, Brazzaville / Pointe-Noire / Dolisie,
--      arrondissements de Brazzaville, zones de livraison A→E
--   4. Compte administrateur
--
-- E-mail admin : golivra@gmail.com
-- Mot de passe  : 12345678  (hash bcrypt vérifié ci-dessous)
--
-- Idempotent : peut être relancé sans risque.
-- ⚠️ À exécuter dans le SQL Editor Supabase.
-- ============================================================================

BEGIN;

-- ─────────────────────────────────────────────
-- 1. EXTENSIONS + TYPE role_nom + ROLES
-- ─────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Type ENUM role_nom (schéma v3) — créé seulement s'il n'existe pas
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'role_nom') THEN
    CREATE TYPE role_nom AS ENUM (
      'client',
      'restaurateur',
      'commercant',
      'admin',
      'livreur',
      'gestionnaire_logistique'
    );
  END IF;
END $$;

-- Table roles : si la table n'existe pas encore, on la crée avec id UUID.
-- Si elle existe (schéma legacy avec id INT), on laisse la structure en place.
CREATE TABLE IF NOT EXISTS roles (
  id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  nom         role_nom     NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Colonne description absente du schéma legacy → on l'ajoute si besoin
ALTER TABLE roles ADD COLUMN IF NOT EXISTS description TEXT;

-- Si la colonne nom est un VARCHAR trop court (schéma legacy VARCHAR(20)),
-- on l'élargit pour accueillir « gestionnaire_logistique » (22 caractères).
-- Sans effet si la colonne est de type ENUM role_nom (v3).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'roles' AND column_name = 'nom'
      AND data_type = 'character varying'
  ) THEN
    ALTER TABLE roles ALTER COLUMN nom TYPE VARCHAR(50);
  END IF;
END $$;

-- Insère les rôles manquants sans doublon, un par un. On garde une tolérance
-- par rôle (ENUM v3 qui n'accepterait pas une valeur, etc.) mais on vérifie
-- APRÈS la boucle que le rôle admin existe bien (vérification dure : sinon
-- toute la transaction s'annule et l'utilisateur retombe sur la même erreur).
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['client', 'restaurateur', 'commercant', 'vendeur', 'admin', 'livreur', 'gestionnaire_logistique']
  LOOP
    BEGIN
      EXECUTE format('INSERT INTO roles (nom) VALUES (%L) ON CONFLICT (nom) DO NOTHING', r);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Rôle % non inséré (structure legacy) : %', r, SQLERRM;
    END;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM roles WHERE nom = 'admin') THEN
    RAISE EXCEPTION 'Rôle admin introuvable après le seed — la table roles n''accepte pas l''insertion. Vérifiez son schéma (contrainte UNIQUE sur nom ?).';
  END IF;
END $$;

-- ─────────────────────────────────────────────
-- 2. TYPES DE COMMERCES + CATÉGORIES DU CATALOGUE
-- ─────────────────────────────────────────────

-- 2a. Types de restaurant (choisis à l'inscription d'un restaurant)
CREATE TABLE IF NOT EXISTS categories_restaurants (
  id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  nom         VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  icone_url   TEXT,
  ordre       SMALLINT     NOT NULL DEFAULT 0,
  est_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

INSERT INTO categories_restaurants (nom, ordre) VALUES
  ('Restaurant africain',     1),
  ('Fast Food',               2),
  ('Grillades & Brochettes',  3),
  ('Pizza & Pasta',           4),
  ('Boulangerie & Pâtisserie',5),
  ('Jus & Boissons',          6),
  ('Cuisine asiatique',       7),
  ('Végétarien',              8),
  ('Autre',                  99)
ON CONFLICT (nom) DO NOTHING;

-- 2b. Types de boutique (choisis à l'inscription d'une boutique)
CREATE TABLE IF NOT EXISTS categories_boutiques (
  id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  nom         VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  icone_url   TEXT,
  ordre       SMALLINT     NOT NULL DEFAULT 0,
  est_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

INSERT INTO categories_boutiques (nom, ordre) VALUES
  ('Épicerie & Alimentation', 1),
  ('Pharmacie',               2),
  ('Supermarché',             3),
  ('Mode & Vêtements',        4),
  ('Électronique',            5),
  ('Beauté & Soins',          6),
  ('Maison & Déco',           7),
  ('Librairie & Papeterie',   8),
  ('Sport',                   9),
  ('Autre',                  99)
ON CONFLICT (nom) DO NOTHING;

-- 2c. Catégories de plats (menus des restaurants)
CREATE TABLE IF NOT EXISTS categories_menus (
  id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  nom         VARCHAR(100) NOT NULL,
  description TEXT,
  image_url   TEXT,
  ordre       SMALLINT     NOT NULL DEFAULT 0,
  est_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_menus_nom ON categories_menus (LOWER(nom));

INSERT INTO categories_menus (nom, ordre) VALUES
  ('Pizzas & Pâtes',          1),
  ('Burgers & Fast-food',     2),
  ('Grillades & Brochettes',  3),
  ('Poulet',                  4),
  ('Poissons & Fruits de mer',5),
  ('Plats africains',         6),
  ('Sandwichs',               7),
  ('Desserts & Pâtisseries',  8),
  ('Boissons & Jus',          9),
  ('Soupes',                 10),
  ('Autres',                 99)
ON CONFLICT (LOWER(nom)) DO NOTHING;

-- 2d. Catégories de produits (catalogue des boutiques)
CREATE TABLE IF NOT EXISTS categories_produits (
  id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  nom         VARCHAR(100) NOT NULL,
  description TEXT,
  image_url   TEXT,
  ordre       SMALLINT     NOT NULL DEFAULT 0,
  est_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_produits_nom ON categories_produits (LOWER(nom));

INSERT INTO categories_produits (nom, ordre) VALUES
  ('Vêtements',                  1),
  ('Véhicules',                  2),
  ('Appareils électroniques',    3),
  ('Maison',                     4),
  ('Rénovation intérieure',      5),
  ('Sports',                     6),
  ('Jeux et jouets',             7),
  ('Beauté et soins',            8),
  ('Alimentation',               9),
  ('Boissons',                  10),
  ('Fournitures de bureau',     11),
  ('Jardin et extérieur',       12),
  ('Instruments de musique',    13),
  ('Articles gratuits',         14),
  ('Autres',                    99)
ON CONFLICT (LOWER(nom)) DO NOTHING;

-- ─────────────────────────────────────────────
-- 3. RÉFÉRENTIEL GÉO : PAYS / VILLES / ARRONDISSEMENTS / ZONES
-- ─────────────────────────────────────────────

-- PAYS
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

INSERT INTO pays (nom, code_iso2, code_iso3, indicatif) VALUES
  ('Congo', 'CG', 'COG', '+242')
ON CONFLICT (code_iso2) DO NOTHING;

-- VILLES
CREATE TABLE IF NOT EXISTS villes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pays_id     UUID         NOT NULL REFERENCES pays(id) ON DELETE CASCADE,
  nom         VARCHAR(150) NOT NULL,
  sort_order  INTEGER      NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT villes_pays_nom_unique UNIQUE (pays_id, nom)
);

CREATE INDEX IF NOT EXISTS idx_villes_pays_id ON villes(pays_id);

DO $$
DECLARE v_cg_id UUID;
BEGIN
  SELECT id INTO v_cg_id FROM pays WHERE code_iso2 = 'CG';
  IF v_cg_id IS NULL THEN
    RAISE EXCEPTION 'Pays Congo introuvable — vérifiez l''insertion dans pays';
  END IF;

  INSERT INTO villes (pays_id, nom, sort_order) VALUES
    (v_cg_id, 'Brazzaville',  1),
    (v_cg_id, 'Pointe-Noire', 2),
    (v_cg_id, 'Dolisie',      3)
  ON CONFLICT (pays_id, nom) DO NOTHING;
END $$;

-- ZONES de livraison A → E
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

INSERT INTO zones (name, label, price_base, is_active, sort_order) VALUES
  ('A', 'Zone A', 0, TRUE, 1),
  ('B', 'Zone B', 0, TRUE, 2),
  ('C', 'Zone C', 0, TRUE, 3),
  ('D', 'Zone D', 0, TRUE, 4),
  ('E', 'Zone E', 0, TRUE, 5)
ON CONFLICT (name) DO NOTHING;

-- ARRONDISSEMENTS (quartiers de Brazzaville — alignés sur l'app mobile)
CREATE TABLE IF NOT EXISTS arrondissements (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name         VARCHAR(100) NOT NULL,
  zone_id      UUID         REFERENCES zones(id) ON DELETE SET NULL,
  ville_id     UUID         REFERENCES villes(id) ON DELETE SET NULL,
  sort_order   INTEGER      NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Colonnes manquantes selon la version de la table (si elle pré-existait)
ALTER TABLE arrondissements ADD COLUMN IF NOT EXISTS zone_id  UUID REFERENCES zones(id) ON DELETE SET NULL;
ALTER TABLE arrondissements ADD COLUMN IF NOT EXISTS ville_id UUID REFERENCES villes(id) ON DELETE SET NULL;

-- Si une ancienne installation imposait zone_id NOT NULL, on la libère
-- (les arrondissements peuvent exister sans zone, affectation manuelle admin).
ALTER TABLE arrondissements ALTER COLUMN zone_id DROP NOT NULL;

-- Si l'ancienne contrainte UNIQUE globale existe, on la retire pour permettre
-- le même nom d'arrondissement dans plusieurs villes.
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
CREATE INDEX IF NOT EXISTS idx_arrondissements_zone_id  ON arrondissements(zone_id);

DO $$
DECLARE v_cg_id UUID; v_bzv_id UUID;
BEGIN
  SELECT id INTO v_cg_id  FROM pays   WHERE code_iso2 = 'CG';
  SELECT id INTO v_bzv_id FROM villes WHERE pays_id = v_cg_id AND nom = 'Brazzaville';
  IF v_bzv_id IS NULL THEN
    RAISE EXCEPTION 'Ville Brazzaville introuvable';
  END IF;

  INSERT INTO arrondissements (name, sort_order, ville_id, zone_id)
  SELECT a.name, a.sort_order, v_bzv_id, NULL
  FROM (VALUES
    ('Centre-ville', 1), ('Bacongo', 2), ('Poto-Poto', 3),
    ('Makelekele', 4), ('Moungali', 5), ('Ouenzé', 6),
    ('Talangaï', 7), ('Mfilou', 8), ('Madibou', 9),
    ('Djiri', 10), ('Autre', 99)
  ) AS a(name, sort_order)
  WHERE NOT EXISTS (
    SELECT 1 FROM arrondissements WHERE name = a.name AND ville_id = v_bzv_id
  );
END $$;

-- ─────────────────────────────────────────────
-- 4. COMPTE ADMINISTRATEUR
-- ─────────────────────────────────────────────

-- Colonnes attendues par le backend (ajoutées si absentes du schéma legacy).
-- Garde : si la table utilisateurs n'existe pas du tout, on la crée d'abord
-- avec le socle minimal, en adaptant le type de role_id à celui de roles.id
-- (UUID pour le schéma v3, INT pour le schéma legacy).
DO $$
DECLARE
  v_roles_id_type TEXT;
BEGIN
  IF to_regclass('public.utilisateurs') IS NULL THEN
    SELECT format_type(a.atttypid, a.atttypmod)::text
      INTO v_roles_id_type
      FROM pg_attribute a
      WHERE a.attrelid = 'public.roles'::regclass
        AND a.attname = 'id'
      LIMIT 1;

    -- Construit la colonne role_id avec le même type que roles.id
    -- (uuid, integer, bigint…) pour ne jamais casser la FK.
    EXECUTE format($sql$
        CREATE TABLE utilisateurs (
          id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
          telephone         VARCHAR(20),
          nom               VARCHAR(100) NOT NULL,
          email             VARCHAR(255),
          mot_de_passe_hash TEXT,
          role_id           %s          REFERENCES roles(id),
          est_actif         BOOLEAN      NOT NULL DEFAULT TRUE,
          est_verifie       BOOLEAN      NOT NULL DEFAULT FALSE,
          est_approuve      BOOLEAN      NOT NULL DEFAULT FALSE,
          est_supprime      BOOLEAN      NOT NULL DEFAULT FALSE,
          created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
          updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )$sql$,
        COALESCE(v_roles_id_type, 'uuid'));
  END IF;
END $$;

ALTER TABLE utilisateurs
  ADD COLUMN IF NOT EXISTS prenom            VARCHAR(100),
  ADD COLUMN IF NOT EXISTS email             VARCHAR(255),
  ADD COLUMN IF NOT EXISTS mot_de_passe_hash TEXT,
  ADD COLUMN IF NOT EXISTS est_actif         BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS est_verifie       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS est_approuve      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS est_supprime      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
DECLARE
  v_role_id roles.id%TYPE;
  v_user_id UUID;
  v_hash TEXT := '$2b$10$A954svh314RVbhTC71u1ruN3jCq9OnzJoMsz7p65QE5OlVALUo0PG';
BEGIN
  SELECT id INTO v_role_id FROM roles WHERE nom = 'admin' LIMIT 1;
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'Rôle admin introuvable — le seed des rôles a échoué';
  END IF;

  SELECT id INTO v_user_id FROM utilisateurs WHERE lower(trim(email)) = 'golivra@gmail.com' LIMIT 1;

  IF v_user_id IS NOT NULL THEN
    UPDATE utilisateurs SET
      nom              = 'GoLivra Admin',
      mot_de_passe_hash = v_hash,
      role_id          = v_role_id,
      est_actif        = TRUE,
      est_approuve     = TRUE,
      est_verifie      = TRUE,
      updated_at       = NOW()
    WHERE id = v_user_id;
    RAISE NOTICE 'Admin mis à jour : golivra@gmail.com';
  ELSE
    INSERT INTO utilisateurs (
      nom, email, telephone, mot_de_passe_hash, role_id,
      est_actif, est_approuve, est_verifie
    ) VALUES (
      'GoLivra Admin',
      'golivra@gmail.com',
      '+242990000001',
      v_hash,
      v_role_id,
      TRUE, TRUE, TRUE
    );
    RAISE NOTICE 'Admin créé : golivra@gmail.com / mot de passe 12345678';
  END IF;
END $$;

-- ─────────────────────────────────────────────
-- 5. RAPPORT
-- ─────────────────────────────────────────────

DO $$
DECLARE
  v_cnt BIGINT;
BEGIN
  IF to_regclass('public.roles') IS NOT NULL
     AND to_regclass('public.utilisateurs') IS NOT NULL THEN
    SELECT count(*) INTO v_cnt FROM roles;
    RAISE NOTICE 'roles=%', v_cnt;

    SELECT count(*) INTO v_cnt FROM utilisateurs u
      JOIN roles r ON r.id = u.role_id WHERE r.nom = 'admin';
    RAISE NOTICE 'admins=%', v_cnt;

    SELECT count(*) INTO v_cnt FROM pays;
    RAISE NOTICE 'pays=%', v_cnt;
    SELECT count(*) INTO v_cnt FROM villes;
    RAISE NOTICE 'villes=%', v_cnt;
    SELECT count(*) INTO v_cnt FROM arrondissements;
    RAISE NOTICE 'arrondissements=%', v_cnt;
    SELECT count(*) INTO v_cnt FROM zones;
    RAISE NOTICE 'zones=%', v_cnt;

    IF to_regclass('public.categories_boutiques') IS NOT NULL THEN
      SELECT count(*) INTO v_cnt FROM categories_boutiques;
      RAISE NOTICE 'types_boutiques=%', v_cnt;
    END IF;
    IF to_regclass('public.categories_restaurants') IS NOT NULL THEN
      SELECT count(*) INTO v_cnt FROM categories_restaurants;
      RAISE NOTICE 'types_restaurants=%', v_cnt;
    END IF;
    IF to_regclass('public.categories_produits') IS NOT NULL THEN
      SELECT count(*) INTO v_cnt FROM categories_produits;
      RAISE NOTICE 'cats_produits=%', v_cnt;
    END IF;
    IF to_regclass('public.categories_menus') IS NOT NULL THEN
      SELECT count(*) INTO v_cnt FROM categories_menus;
      RAISE NOTICE 'cats_menus=%', v_cnt;
    END IF;
  END IF;
END $$;

COMMIT;
