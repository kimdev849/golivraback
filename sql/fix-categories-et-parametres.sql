-- =============================================================================
-- GoLivra — FIX : catégories globales + paramètres système
-- -----------------------------------------------------------------------------
-- Corrige l'erreur « Impossible de charger les catégories » (HTTP 500) quand la
-- base a été remise à zéro : crée les 4 référentiels de catégories (produits,
-- menus, boutiques, restaurants) et la table des paramètres système, avec les
-- valeurs par défaut.
--
-- ✅ IDEMPOTENT : peut être exécuté plusieurs fois sans effet de bord.
-- ✅ SANS DANGER : ne touche NI aux comptes, NI aux commerces, NI aux commandes.
-- ✅ Compatible base déjà seedée : tables absentes → créées ; présentes → seed
--    ignoré (ON CONFLICT DO NOTHING) ; FK orphelines → nettoyées + rebranchées.
--
-- Exécution : Supabase → SQL Editor → coller → Run.
--             Puis Supabase → Project Settings → API → « Reload schema ».
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────
-- 1. CATÉGORIES DE PRODUITS (boutiques)
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

CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_produits_nom ON categories_produits (LOWER(nom));

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
-- 2. CATÉGORIES DE PLATS (menus / restaurants)
-- ─────────────────────────────────────────────
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
-- 3. TYPES DE RESTAURANTS (choisis à l'inscription)
-- ─────────────────────────────────────────────
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

-- ─────────────────────────────────────────────
-- 4. TYPES DE BOUTIQUES (choisis à l'inscription)
-- ─────────────────────────────────────────────
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

-- ─────────────────────────────────────────────
-- 5. PARAMÈTRES SYSTÈME (réglages GoLivra + contrôle de l'app)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS parametres_systeme (
  cle         VARCHAR(100) PRIMARY KEY,
  valeur      TEXT         NOT NULL,
  type        VARCHAR(20)  NOT NULL DEFAULT 'string',
  description TEXT,
  est_public  BOOLEAN      NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_par UUID         REFERENCES utilisateurs(id)
);

INSERT INTO parametres_systeme (cle, valeur, type, description, est_public) VALUES
  -- Finances / livraison
  ('commission_marketplace_defaut_pct',  '5',     'number',  'Commission GoLivra sur ventes (%)',            FALSE),
  ('commission_livraison_min_fcfa',      '200',   'number',  'Commission min par livraison (FCFA)',          FALSE),
  ('commission_livraison_max_fcfa',      '500',   'number',  'Commission max par livraison (FCFA)',          FALSE),
  ('frais_livraison_base_fcfa',          '500',   'number',  'Frais de livraison de base (FCFA)',            TRUE),
  ('frais_livraison_par_km_fcfa',        '150',   'number',  'Frais additionnels par km (FCFA)',             TRUE),
  ('rayon_livraison_defaut_km',          '10',    'number',  'Rayon de livraison par défaut (km)',           TRUE),
  ('montant_min_commande_fcfa',          '1000',  'number',  'Montant minimum de commande (FCFA)',           TRUE),
  ('delai_acceptation_etablissement_min','10',    'number',  'Délai max pour qu''un établissement accepte',  FALSE),
  ('otp_expiration_minutes',             '10',    'number',  'Durée de vie d''un OTP (minutes)',             FALSE),
  ('max_tentatives_otp',                 '3',     'number',  'Tentatives OTP max par session',               FALSE),
  ('auto_approve_etablissements',        'false', 'boolean', 'Auto-validation établissements (dev only)',    FALSE),
  ('validation_manuelle_obligatoire',    'true',  'boolean', 'Restaurateurs/commerçants validés par admin',  FALSE),
  ('panier_expiration_heures',           '3',     'number',  'Durée d''un panier inactif (heures)',          FALSE),
  ('panier_mixte_autorise',              'true',  'boolean', 'Panier mixte restaurant + boutique autorisé',  TRUE),
  -- Contrôle total de l'application (feature flags)
  ('golivra_app_enabled',      'true',  'boolean', 'Kill switch global : si false, toute l''application est coupée',   TRUE),
  ('golivra_maintenance_mode', 'false', 'boolean', 'Mode maintenance : blocage de toute l''application (sauf admin)',   FALSE),
  ('golivra_min_app_version',  '1.0.0', 'string',  'Version minimale acceptée (force la mise à jour de l''APK)',        TRUE),
  ('golivra_beta_mode',        'false', 'boolean', 'Bêta fermée : seuls les téléphones autorisés peuvent se connecter', TRUE),
  ('golivra_beta_phones',      '',      'string',  'Téléphones autorisés en bêta fermée (séparés par des virgules)',    FALSE),
  ('golivra_orders_enabled',   'true',  'boolean', 'Activer / désactiver la passation de commandes',                    TRUE),
  ('golivra_payments_enabled', 'true',  'boolean', 'Activer / désactiver les paiements en ligne',                       TRUE),
  ('golivra_delivery_enabled', 'true',  'boolean', 'Activer / désactiver les livraisons',                               TRUE),
  ('golivra_signups_open',     'true',  'boolean', 'Activer / désactiver les nouvelles inscriptions',                   TRUE),
  ('golivra_announcement',     '',      'string',  'Message d''annonce affiché dans l''application (bannière)',         TRUE)
ON CONFLICT (cle) DO NOTHING;

-- ─────────────────────────────────────────────
-- 6. FK ORPHELINES : purge + rebranchement des tables métier
--    (articles/plats/restaurants/boutiques) vers les référentiels globaux.
--    Best-effort : ne fait rien si les tables n'existent pas.
-- ─────────────────────────────────────────────
DO $$
DECLARE
  con record;
  has_articles BOOLEAN;
  has_plats    BOOLEAN;
  has_restos   BOOLEAN;
  has_bout     BOOLEAN;
BEGIN
  has_articles := to_regclass('public.articles') IS NOT NULL;
  has_plats    := to_regclass('public.plats') IS NOT NULL;
  has_restos   := to_regclass('public.restaurants') IS NOT NULL;
  has_bout     := to_regclass('public.boutiques') IS NOT NULL;

  -- Purge des références orphelines (sinon les nouvelles FK échoueraient).
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
  IF has_restos THEN
    UPDATE restaurants SET categorie_id = NULL
    WHERE categorie_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM categories_restaurants WHERE id = restaurants.categorie_id);
  END IF;
  IF has_bout THEN
    UPDATE boutiques SET categorie_id = NULL
    WHERE categorie_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM categories_boutiques WHERE id = boutiques.categorie_id);
  END IF;

  -- Supprime les anciennes FK (par-commerce ou obsolètes) sur ces colonnes.
  FOR con IN
    SELECT c.conname, rel.relname AS tbl, ref.relname AS reftbl
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_class ref ON ref.oid = c.confrelid
    WHERE c.contype = 'f'
      AND rel.relname IN ('articles','plats','restaurants','boutiques')
      AND ref.relname IN ('categories_articles','categories_plats','categories_restaurants','categories_boutiques')
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', con.tbl, con.conname);
  END LOOP;

  -- Garantit les nouvelles FK vers les référentiels globaux (si absentes).
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

  IF has_restos AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'restaurants_categorie_id_fkey' AND conrelid = 'restaurants'::regclass
  ) THEN
    ALTER TABLE restaurants ADD CONSTRAINT restaurants_categorie_id_fkey
      FOREIGN KEY (categorie_id) REFERENCES categories_restaurants(id) ON DELETE SET NULL;
  END IF;

  IF has_bout AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'boutiques_categorie_id_fkey' AND conrelid = 'boutiques'::regclass
  ) THEN
    ALTER TABLE boutiques ADD CONSTRAINT boutiques_categorie_id_fkey
      FOREIGN KEY (categorie_id) REFERENCES categories_boutiques(id) ON DELETE SET NULL;
  END IF;
END $$;
