-- ============================================================================
-- Migration : Ajout des métadonnées téléphone à la table `pays`
-- Permet le formatage et la validation dynamique des numéros de téléphone
-- par pays, sans hardcoder les règles côté frontend.
--
-- Colonnes ajoutées :
--   phone_digits   SMALLINT  → nombre de chiffres nationaux (ex: 9 pour +242)
--   phone_format   TEXT      → motif de formatage optionnel (ex: "2,3,2,2")
--
-- Exécuter dans Supabase SQL Editor.
-- ============================================================================

-- 1. Ajouter les colonnes ------------------------------------------------

ALTER TABLE pays
  ADD COLUMN IF NOT EXISTS phone_digits  SMALLINT,
  ADD COLUMN IF NOT EXISTS phone_format  VARCHAR(20);

-- 2. Seeder les données existantes ----------------------------------------

UPDATE pays SET phone_digits = 9,  phone_format = '2,3,2,2' WHERE code_iso2 = 'CG';   -- Congo
UPDATE pays SET phone_digits = 9,  phone_format = '2,3,2,2' WHERE code_iso2 = 'CD';   -- RDC
UPDATE pays SET phone_digits = 9,  phone_format = '3,2,2,2' WHERE code_iso2 = 'CM';   -- Cameroun
UPDATE pays SET phone_digits = 9,  phone_format = '2,3,2,2' WHERE code_iso2 = 'SN';   -- Sénégal
UPDATE pays SET phone_digits = 10, phone_format = '2,2,2,2,2' WHERE code_iso2 = 'CI'; -- Côte d'Ivoire
UPDATE pays SET phone_digits = 8,  phone_format = '1,2,2,3' WHERE code_iso2 = 'GA';   -- Gabon
UPDATE pays SET phone_digits = 8,  phone_format = '2,2,2,2' WHERE code_iso2 = 'BJ';   -- Bénin
UPDATE pays SET phone_digits = 8,  phone_format = '2,2,2,2' WHERE code_iso2 = 'TG';   -- Togo
UPDATE pays SET phone_digits = 9,  phone_format = '2,3,2,2' WHERE code_iso2 = 'GN';   -- Guinée
UPDATE pays SET phone_digits = 8,  phone_format = '2,2,2,2' WHERE code_iso2 = 'ML';   -- Mali
UPDATE pays SET phone_digits = 8,  phone_format = '2,2,2,2' WHERE code_iso2 = 'BF';   -- Burkina Faso
UPDATE pays SET phone_digits = 8,  phone_format = '2,2,2,2' WHERE code_iso2 = 'NE';   -- Niger
UPDATE pays SET phone_digits = 10, phone_format = '3,3,4'   WHERE code_iso2 = 'NG';   -- Nigeria
UPDATE pays SET phone_digits = 9,  phone_format = '1,2,2,2,2' WHERE code_iso2 = 'FR'; -- France
UPDATE pays SET phone_digits = 9,  phone_format = '2,3,2,2' WHERE code_iso2 = 'CF';   -- Centrafrique
UPDATE pays SET phone_digits = 9,  phone_format = '2,3,2,2' WHERE code_iso2 = 'AO';   -- Angola
UPDATE pays SET phone_digits = 9,  phone_format = '2,3,2,2' WHERE code_iso2 = 'GA';   -- Gabon (déjà fait, laisser)

-- Ajouter des pays supplémentaires avec leurs infos téléphone
INSERT INTO pays (nom, code_iso2, code_iso3, indicatif, phone_digits, phone_format) VALUES
  ('Sénégal',           'SN', 'SEN', '+221', 9,  '2,3,2,2'),
  ('Côte d''Ivoire',    'CI', 'CIV', '+225', 10, '2,2,2,2,2'),
  ('Bénin',             'BJ', 'BEN', '+229', 8,  '2,2,2,2'),
  ('Togo',              'TG', 'TGO', '+228', 8,  '2,2,2,2'),
  ('Guinée',            'GN', 'GIN', '+224', 9,  '2,3,2,2'),
  ('Mali',              'ML', 'MLI', '+223', 8,  '2,2,2,2'),
  ('Burkina Faso',      'BF', 'BFA', '+226', 8,  '2,2,2,2'),
  ('Niger',             'NE', 'NER', '+227', 8,  '2,2,2,2'),
  ('Nigeria',           'NG', 'NGA', '+234', 10, '3,3,4'),
  ('France',            'FR', 'FRA', '+33',  9,  '1,2,2,2,2')
ON CONFLICT (code_iso2) DO UPDATE SET
  indicatif     = EXCLUDED.indicatif,
  phone_digits  = EXCLUDED.phone_digits,
  phone_format  = EXCLUDED.phone_format;
