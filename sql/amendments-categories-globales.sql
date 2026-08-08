-- =============================================================================
-- GoLivra — Catégories globales (catalogue marketplace)
-- -----------------------------------------------------------------------------
-- Objectif : GoLivra organise le catalogue. Les catégories ne sont plus créées
-- par chaque commerce : elles sont GLOBALES et gérées par GoLivra (admin).
--   • categories_produits  → produits des boutiques
--   • categories_menus     → plats des restaurants
--
-- Idempotent : peut être exécuté plusieurs fois sans effet de bord.
-- Exécution : `cd golivraback && npm run migrate:categories`
--            (ou copier ce fichier dans Supabase → SQL Editor → Run).
-- =============================================================================

-- Extension UUID (présente sur Supabase ; sûre si déjà active).
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────
-- 1. Tables globales
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categories_produits (
  id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  nom         VARCHAR(100) NOT NULL,
  description TEXT,
  image_url   TEXT,
  ordre       SMALLINT     NOT NULL DEFAULT 0,
  est_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS categories_menus (
  id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  nom         VARCHAR(100) NOT NULL,
  description TEXT,
  image_url   TEXT,
  ordre       SMALLINT     NOT NULL DEFAULT 0,
  est_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Unicité (insensible à la casse) pour un seed idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_produits_nom ON categories_produits (LOWER(nom));
CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_menus_nom    ON categories_menus    (LOWER(nom));

-- ─────────────────────────────────────────────
-- 2. Seed — Catégories produits (boutiques)
-- ─────────────────────────────────────────────
INSERT INTO categories_produits (nom, ordre) VALUES
  ('Vêtements', 1),
  ('Véhicules', 2),
  ('Appareils électroniques', 3),
  ('Maison', 4),
  ('Rénovation intérieure', 5),
  ('Sports', 6),
  ('Jeux et jouets', 7),
  ('Beauté et soins', 8),
  ('Alimentation', 9),
  ('Boissons', 10),
  ('Fournitures de bureau', 11),
  ('Jardin et extérieur', 12),
  ('Instruments de musique', 13),
  ('Articles gratuits', 14),
  ('Autres', 99)
ON CONFLICT (LOWER(nom)) DO NOTHING;

-- ─────────────────────────────────────────────
-- 3. Seed — Catégories menus (restaurants)
-- ─────────────────────────────────────────────
INSERT INTO categories_menus (nom, ordre) VALUES
  ('Pizzas & Pâtes', 1),
  ('Burgers & Fast-food', 2),
  ('Grillades & Brochettes', 3),
  ('Poulet', 4),
  ('Poissons & Fruits de mer', 5),
  ('Plats africains', 6),
  ('Sandwichs', 7),
  ('Desserts & Pâtisseries', 8),
  ('Boissons & Jus', 9),
  ('Soupes', 10),
  ('Autres', 99)
ON CONFLICT (LOWER(nom)) DO NOTHING;

-- ─────────────────────────────────────────────
-- 4. Migration des données + bascule des FK
--    Robuste quel que soit l'état de la base :
--    • base ANCIENNE : categories_articles / categories_plats existent
--      → les catégories par-commerce sont rapatriées par nom, puis les FK
--        sont rebranchées sur les tables globales.
--    • base NOUVELLE (schéma v3 à jour) : les anciennes tables n'existent pas
--      → on ne fait que garantir les nouvelles FK (si absentes).
-- ─────────────────────────────────────────────
DO $$
DECLARE
  con record;
  has_articles        BOOLEAN;
  has_plats           BOOLEAN;
  has_articles_table  BOOLEAN;
  has_plats_table     BOOLEAN;
BEGIN
  has_articles       := to_regclass('public.articles') IS NOT NULL;
  has_plats          := to_regclass('public.plats') IS NOT NULL;
  has_articles_table := to_regclass('public.categories_articles') IS NOT NULL;
  has_plats_table    := to_regclass('public.categories_plats') IS NOT NULL;

  -- 4a/4b. Rapatriement par nom (best-effort) — uniquement si les anciennes
  --        tables existent encore.
  IF has_articles AND has_articles_table THEN
    UPDATE articles a
    SET categorie_id = cp.id
    FROM categories_articles ca
    JOIN categories_produits cp ON LOWER(cp.nom) = LOWER(ca.nom)
    WHERE ca.id = a.categorie_id;
  END IF;

  IF has_plats AND has_plats_table THEN
    UPDATE plats p
    SET categorie_id = cm.id
    FROM categories_plats cp
    JOIN categories_menus cm ON LOWER(cm.nom) = LOWER(cp.nom)
    WHERE cp.id = p.categorie_id;
  END IF;

  -- 4c. Purge des références orphelines (sinon la nouvelle FK échouerait).
  IF has_articles THEN
    UPDATE articles SET categorie_id = NULL
    WHERE categorie_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM categories_produits WHERE id = articles.categorie_id);
  END IF;

  IF has_plats THEN
    UPDATE plats SET categorie_id = NULL
    WHERE categorie_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM categories_menus WHERE id = plats.categorie_id);
  END IF;

  -- 5. Supprime TOUTE ancienne FK sur articles.categorie_id / plats.categorie_id
  --    qui pointe vers les anciennes tables par-commerce (quel que soit son nom).
  --    On passe par pg_class (pas de cast regclass) pour rester valide même si
  --    une table n'existe pas encore.
  FOR con IN
    SELECT c.conname, rel.relname AS tbl
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_class ref ON ref.oid = c.confrelid
    WHERE c.contype = 'f'
      AND rel.relname IN ('articles', 'plats')
      AND ref.relname IN ('categories_articles', 'categories_plats')
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', con.tbl, con.conname);
  END LOOP;

  -- 6. Garantit les nouvelles FK vers les tables globales (si absentes).
  IF has_articles AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_categorie_id_fkey' AND conrelid = 'articles'::regclass
  ) THEN
    ALTER TABLE articles ADD CONSTRAINT articles_categorie_id_fkey
      FOREIGN KEY (categorie_id) REFERENCES categories_produits(id) ON DELETE SET NULL;
  END IF;

  IF has_plats AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'plats_categorie_id_fkey' AND conrelid = 'plats'::regclass
  ) THEN
    ALTER TABLE plats ADD CONSTRAINT plats_categorie_id_fkey
      FOREIGN KEY (categorie_id) REFERENCES categories_menus(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Les anciennes tables categories_articles / categories_plats (par commerce)
-- sont conservées pour compatibilité, mais ne sont plus utilisées par le code.
