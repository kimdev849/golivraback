/**
 * Script de migration : crée les tables pays/villes/arrondissements
 * et ajoute les colonnes FK aux tables existantes.
 *
 * Usage : node scripts/migrate-location.js
 *
 * Pré-requis : .env avec SUPABASE_URL et SUPABASE_SECRET_KEY / SUPABASE_SERVICE_KEY
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SQL = `
-- ============================================================================
-- CRÉATION DES TABLES PAYS / VILLES / ARRONDISSEMENTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS pays (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom         VARCHAR(100) NOT NULL,
  code_iso2   VARCHAR(2)   NOT NULL,
  code_iso3   VARCHAR(3)   NOT NULL,
  indicatif   VARCHAR(6)   DEFAULT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT pays_code_iso2_unique UNIQUE (code_iso2),
  CONSTRAINT pays_code_iso3_unique UNIQUE (code_iso3)
);

CREATE TABLE IF NOT EXISTS villes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pays_id     UUID         NOT NULL REFERENCES pays(id) ON DELETE CASCADE,
  nom         VARCHAR(150) NOT NULL,
  sort_order  INTEGER      NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT villes_pays_nom_unique UNIQUE (pays_id, nom)
);

CREATE TABLE IF NOT EXISTS arrondissements (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         VARCHAR(100) NOT NULL,
  zone_id      UUID,
  ville_id     UUID REFERENCES villes(id) ON DELETE SET NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ajout col dans adresses_utilisateur
ALTER TABLE adresses_utilisateur ADD COLUMN IF NOT EXISTS pays_id UUID REFERENCES pays(id) ON DELETE SET NULL;
ALTER TABLE adresses_utilisateur ADD COLUMN IF NOT EXISTS ville_id UUID REFERENCES villes(id) ON DELETE SET NULL;

-- Ajout col dans adresses (si existe)
ALTER TABLE adresses ADD COLUMN IF NOT EXISTS pays_id UUID REFERENCES pays(id) ON DELETE SET NULL;
ALTER TABLE adresses ADD COLUMN IF NOT EXISTS ville_id UUID REFERENCES villes(id) ON DELETE SET NULL;

-- Ajout col dans restaurants / boutiques
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS pays_id UUID REFERENCES pays(id) ON DELETE SET NULL;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS ville_id UUID REFERENCES villes(id) ON DELETE SET NULL;
ALTER TABLE boutiques ADD COLUMN IF NOT EXISTS pays_id UUID REFERENCES pays(id) ON DELETE SET NULL;
ALTER TABLE boutiques ADD COLUMN IF NOT EXISTS ville_id UUID REFERENCES villes(id) ON DELETE SET NULL;

ALTER TABLE arrondissements ADD COLUMN IF NOT EXISTS ville_id UUID REFERENCES villes(id) ON DELETE SET NULL;

-- SEED : pays
INSERT INTO pays (nom, code_iso2, code_iso3, indicatif) VALUES
  ('Congo', 'CG', 'COG', '+242'),
  ('République Démocratique du Congo', 'CD', 'COD', '+243'),
  ('Gabon', 'GA', 'GAB', '+241'),
  ('Cameroun', 'CM', 'CMR', '+237'),
  ('République Centrafricaine', 'CF', 'CAF', '+236'),
  ('Angola', 'AO', 'AGO', '+244')
ON CONFLICT (code_iso2) DO NOTHING;

-- SEED : villes
DO $$
DECLARE
  v_cg_id UUID; v_cd_id UUID; v_ga_id UUID; v_cm_id UUID; v_cf_id UUID; v_ao_id UUID;
BEGIN
  SELECT id INTO v_cg_id FROM pays WHERE code_iso2 = 'CG';
  SELECT id INTO v_cd_id FROM pays WHERE code_iso2 = 'CD';
  SELECT id INTO v_ga_id FROM pays WHERE code_iso2 = 'GA';
  SELECT id INTO v_cm_id FROM pays WHERE code_iso2 = 'CM';
  SELECT id INTO v_cf_id FROM pays WHERE code_iso2 = 'CF';
  SELECT id INTO v_ao_id FROM pays WHERE code_iso2 = 'AO';

  INSERT INTO villes (pays_id, nom, sort_order) VALUES
    (v_cg_id, 'Brazzaville', 1), (v_cg_id, 'Pointe-Noire', 2), (v_cg_id, 'Dolisie', 3), (v_cg_id, 'Nkayi', 4),
    (v_cg_id, 'Owando', 5), (v_cg_id, 'Ouesso', 6), (v_cg_id, 'Madingou', 7), (v_cg_id, 'Sibiti', 8),
    (v_cg_id, 'Kinkala', 9), (v_cg_id, 'Impfondo', 10), (v_cg_id, 'Ewo', 11), (v_cg_id, 'Mossaka', 12)
  ON CONFLICT (pays_id, nom) DO NOTHING;
  INSERT INTO villes (pays_id, nom, sort_order) VALUES
    (v_cd_id, 'Kinshasa', 1), (v_cd_id, 'Lubumbashi', 2), (v_cd_id, 'Mbuji-Mayi', 3), (v_cd_id, 'Kananga', 4),
    (v_cd_id, 'Kisangani', 5), (v_cd_id, 'Goma', 6), (v_cd_id, 'Bukavu', 7), (v_cd_id, 'Matadi', 8),
    (v_cd_id, 'Boma', 9), (v_cd_id, 'Mwene-Ditu', 10), (v_cd_id, 'Kikwit', 11), (v_cd_id, 'Uvira', 12)
  ON CONFLICT (pays_id, nom) DO NOTHING;
  INSERT INTO villes (pays_id, nom, sort_order) VALUES
    (v_ga_id, 'Libreville', 1), (v_ga_id, 'Port-Gentil', 2), (v_ga_id, 'Franceville', 3), (v_ga_id, 'Oyem', 4),
    (v_ga_id, 'Moanda', 5), (v_ga_id, 'Mouila', 6), (v_ga_id, 'Lambaréné', 7), (v_ga_id, 'Tchibanga', 8),
    (v_ga_id, 'Koulamoutou', 9), (v_ga_id, 'Makokou', 10)
  ON CONFLICT (pays_id, nom) DO NOTHING;
  INSERT INTO villes (pays_id, nom, sort_order) VALUES
    (v_cm_id, 'Yaoundé', 1), (v_cm_id, 'Douala', 2), (v_cm_id, 'Garoua', 3), (v_cm_id, 'Bamenda', 4),
    (v_cm_id, 'Maroua', 5), (v_cm_id, 'Nkongsamba', 6), (v_cm_id, 'Bafoussam', 7), (v_cm_id, 'Ngaoundéré', 8),
    (v_cm_id, 'Bertoua', 9), (v_cm_id, 'Loum', 10), (v_cm_id, 'Kumba', 11), (v_cm_id, 'Edéa', 12)
  ON CONFLICT (pays_id, nom) DO NOTHING;
  INSERT INTO villes (pays_id, nom, sort_order) VALUES
    (v_cf_id, 'Bangui', 1), (v_cf_id, 'Bimbo', 2), (v_cf_id, 'Berbérati', 3), (v_cf_id, 'Bossangoa', 4),
    (v_cf_id, 'Bambari', 5), (v_cf_id, 'Bouar', 6), (v_cf_id, 'Bangassou', 7), (v_cf_id, 'Mbaïki', 8),
    (v_cf_id, 'Kaga-Bandoro', 9), (v_cf_id, 'Sibut', 10)
  ON CONFLICT (pays_id, nom) DO NOTHING;
  INSERT INTO villes (pays_id, nom, sort_order) VALUES
    (v_ao_id, 'Luanda', 1), (v_ao_id, 'Cabinda', 2), (v_ao_id, 'Huambo', 3), (v_ao_id, 'Lubango', 4),
    (v_ao_id, 'Benguela', 5), (v_ao_id, 'Malanje', 6), (v_ao_id, 'Saurimo', 7), (v_ao_id, 'Uíge', 8),
    (v_ao_id, 'Mbanza Congo', 9), (v_ao_id, 'Caxito', 10), (v_ao_id, 'Lobito', 11), (v_ao_id, 'Namibe', 12)
  ON CONFLICT (pays_id, nom) DO NOTHING;
END $$;
`;

/** Exécute du SQL brut via l'API REST Supabase (service_role required). */
async function run() {
  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();

  if (!url || !key) {
    console.error('❌ SUPABASE_URL et SUPABASE_SECRET_KEY requis dans .env');
    process.exit(1);
  }

  console.log('🔧 Connexion à Supabase...');
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  // Exécute le SQL via l'endpoint REST /rest/v1/ avec le header Prefer
  console.log('📦 Exécution de la migration...');
  
  const response = await fetch(`${url}/rest/v1/rpc/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({ query: SQL }),
  });

  if (response.ok) {
    console.log('✅ Migration terminée avec succès !');
    console.log('📋 Tables créées : pays, villes, arrondissements');
    console.log('📋 Colonnes ajoutées : adresses_utilisateur.pays_id, adresses_utilisateur.ville_id');
  } else {
    // Fallback : essayer via requête directe
    console.log('⚠️  Tentative alternative...');
    try {
      const { error } = await supabase.rpc('exec_sql', { query: SQL });
      if (error) {
        // Dernier recours : exécuter chaque instruction une par une
        console.log('⚠️  Exécution instruction par instruction...');
        const statements = SQL.split(';').filter(s => s.trim().length > 5);
        let ok = 0, fail = 0;
        for (const stmt of statements) {
          try {
            const { error: e } = await supabase.rpc('exec_sql', { query: stmt + ';' });
            if (e) {
              console.warn(`  ⚠️  ${e.message.slice(0, 80)}`);
              fail++;
            } else ok++;
          } catch {
            fail++;
          }
        }
        console.log(`✅ ${ok} instructions réussies, ${fail} échecs`);
      } else {
        console.log('✅ Migration terminée avec succès !');
      }
    } catch (err) {
      console.error('❌ Erreur:', err.message);
      console.log('\n💡 Solution manuelle : ouvrez Supabase → SQL Editor et exécutez le contenu de :');
      console.log('   golivra-backendcd/scripts/migrate-location.js (la variable SQL)');
    }
  }
}

run().catch(console.error);
