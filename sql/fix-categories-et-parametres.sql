-- ============================================================================
-- GoLivra — FIX : catégories + paramètres système (base déjà seedée partiellement)
-- ----------------------------------------------------------------------------
-- À exécuter quand l'admin affiche :
--   « Impossible de charger les catégories. Vérifiez que la migration des
--    catégories globales est appliquée en base. »
--
-- Idempotent : peut être exécuté plusieurs fois sans risque.
-- Sans effet sur les données existantes (comptes, commerces, commandes).
-- 1) Supabase → SQL Editor → colle TOUT ce fichier → Run
-- 2) Supabase → Project Settings → API → « Reload schema » (cache PostgREST)
-- 3) L'admin web se recharge → Catégories opérationnelles
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────
-- 1. TABLE : types de restaurant
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
-- 2. TABLE : types de boutique
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
-- 3. TABLE : catégories de plats (menus)
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

-- ─────────────────────────────────────────────
-- 4. TABLE : catégories de produits
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
-- 5. TABLE : paramètres système + feature flags
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS parametres_systeme (
  cle         VARCHAR(100) PRIMARY KEY,
  valeur      TEXT         NOT NULL,
  type        VARCHAR(20)  NOT NULL DEFAULT 'string',
  description TEXT,
  est_public  BOOLEAN      NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_par UUID
);

INSERT INTO parametres_systeme (cle, valeur, type, description, est_public) VALUES
  ('commission_marketplace_defaut_pct',  '5',     'number',  'Commission GoLivra sur ventes (%)',            FALSE),
  ('frais_livraison_base_fcfa',          '500',   'number',  'Frais de livraison de base (FCFA)',            TRUE),
  ('frais_livraison_par_km_fcfa',        '150',   'number',  'Frais additionnels par km (FCFA)',             TRUE),
  ('frais_livraison_min_fcfa',           '500',   'number',  'Frais de livraison minimum (FCFA)',            TRUE),
  ('frais_livraison_max_fcfa',           '5000',  'number',  'Frais de livraison maximum (FCFA)',            TRUE),
  ('rayon_livraison_defaut_km',          '10',    'number',  'Rayon de livraison par défaut (km)',           TRUE),
  ('montant_min_commande_fcfa',          '1000',  'number',  'Montant minimum de commande (FCFA)',           TRUE),
  ('platform_fee_percent',               '0',     'number',  'Commission plateforme sur ventes (%)',         FALSE),
  ('merchant_percent',                   '100',   'number',  'Part commerce sur ventes (%)',                 FALSE),
  ('delivery_platform_percent',          '20',    'number',  'Part plateforme sur frais de livraison (%)',   FALSE),
  ('delivery_logistics_percent',         '80',    'number',  'Part logistique sur frais de livraison (%)',   FALSE),
  ('golivra_platform_name',              'GoLivra','string',  'Nom affiché de la plateforme',                 TRUE),
  ('golivra_support_email',              'support@golivra.cg', 'string', 'E-mail de support',            TRUE),
  ('golivra_email_notifications',        'true',  'boolean', 'Notifications e-mail système',                 FALSE),
  ('golivra_sms_notifications',          'true',  'boolean', 'Notifications SMS système',                    FALSE),
  ('golivra_app_enabled',                'true',  'boolean', 'Kill switch global : si false, toute l''application est coupée', TRUE),
  ('golivra_maintenance_mode',           'false', 'boolean', 'Mode maintenance : blocage de toute l''application', FALSE),
  ('golivra_min_app_version',            '1.0.0', 'string',  'Version minimale acceptée (force la MAJ APK)',  TRUE),
  ('golivra_beta_mode',                  'false', 'boolean', 'Bêta fermée : seuls les téléphones autorisés accèdent', TRUE),
  ('golivra_beta_phones',                '',      'string',  'Téléphones autorisés en bêta fermée (virgules)', FALSE),
  ('golivra_orders_enabled',             'true',  'boolean', 'Activer / désactiver la passation de commandes', TRUE),
  ('golivra_payments_enabled',           'true',  'boolean', 'Activer / désactiver les paiements en ligne',    TRUE),
  ('golivra_delivery_enabled',           'true',  'boolean', 'Activer / désactiver les livraisons',            TRUE),
  ('golivra_announcement',               '',      'string',  'Message d''annonce affiché dans l''application',  TRUE)
ON CONFLICT (cle) DO NOTHING;

-- ─────────────────────────────────────────────
-- RAPPORT
-- ─────────────────────────────────────────────
DO $$
DECLARE v_cnt BIGINT;
BEGIN
  IF to_regclass('public.categories_produits') IS NOT NULL THEN
    SELECT count(*) INTO v_cnt FROM categories_produits;
    RAISE NOTICE 'cats_produits=%', v_cnt;
  END IF;
  IF to_regclass('public.categories_menus') IS NOT NULL THEN
    SELECT count(*) INTO v_cnt FROM categories_menus;
    RAISE NOTICE 'cats_menus=%', v_cnt;
  END IF;
  IF to_regclass('public.categories_boutiques') IS NOT NULL THEN
    SELECT count(*) INTO v_cnt FROM categories_boutiques;
    RAISE NOTICE 'types_boutiques=%', v_cnt;
  END IF;
  IF to_regclass('public.categories_restaurants') IS NOT NULL THEN
    SELECT count(*) INTO v_cnt FROM categories_restaurants;
    RAISE NOTICE 'types_restaurants=%', v_cnt;
  END IF;
  IF to_regclass('public.parametres_systeme') IS NOT NULL THEN
    SELECT count(*) INTO v_cnt FROM parametres_systeme WHERE cle LIKE 'golivra_%';
    RAISE NOTICE 'feature_flags=%', v_cnt;
  END IF;
END $$;
