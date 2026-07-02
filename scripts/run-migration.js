require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SQL = `
CREATE TABLE IF NOT EXISTS pays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom VARCHAR(100) NOT NULL,
  code_iso2 VARCHAR(2) NOT NULL UNIQUE,
  code_iso3 VARCHAR(3) NOT NULL UNIQUE,
  indicatif VARCHAR(6) DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO pays (nom, code_iso2, code_iso3, indicatif) VALUES
  ('Congo', 'CG', 'COG', '+242'),
  ('République Démocratique du Congo', 'CD', 'COD', '+243'),
  ('Gabon', 'GA', 'GAB', '+241'),
  ('Cameroun', 'CM', 'CMR', '+237'),
  ('République Centrafricaine', 'CF', 'CAF', '+236'),
  ('Angola', 'AO', 'AGO', '+244')
ON CONFLICT (code_iso2) DO NOTHING;

CREATE TABLE IF NOT EXISTS villes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pays_id UUID NOT NULL REFERENCES pays(id) ON DELETE CASCADE,
  nom VARCHAR(150) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT villes_pays_nom_unique UNIQUE (pays_id, nom)
);

DO $$
DECLARE
  cg_id UUID; cd_id UUID; ga_id UUID; cm_id UUID; cf_id UUID; ao_id UUID;
BEGIN
  SELECT id INTO cg_id FROM pays WHERE code_iso2='CG';
  SELECT id INTO cd_id FROM pays WHERE code_iso2='CD';
  SELECT id INTO ga_id FROM pays WHERE code_iso2='GA';
  SELECT id INTO cm_id FROM pays WHERE code_iso2='CM';
  SELECT id INTO cf_id FROM pays WHERE code_iso2='CF';
  SELECT id INTO ao_id FROM pays WHERE code_iso2='AO';

  INSERT INTO villes(pays_id,nom,sort_order) VALUES(cg_id,'Brazzaville',1),(cg_id,'Pointe-Noire',2),(cg_id,'Dolisie',3),(cg_id,'Nkayi',4),(cg_id,'Owando',5),(cg_id,'Ouesso',6) ON CONFLICT DO NOTHING;
  INSERT INTO villes(pays_id,nom,sort_order) VALUES(cd_id,'Kinshasa',1),(cd_id,'Lubumbashi',2),(cd_id,'Mbuji-Mayi',3),(cd_id,'Kananga',4) ON CONFLICT DO NOTHING;
  INSERT INTO villes(pays_id,nom,sort_order) VALUES(ga_id,'Libreville',1),(ga_id,'Port-Gentil',2),(ga_id,'Franceville',3) ON CONFLICT DO NOTHING;
  INSERT INTO villes(pays_id,nom,sort_order) VALUES(cm_id,'Yaoundé',1),(cm_id,'Douala',2),(cm_id,'Garoua',3) ON CONFLICT DO NOTHING;
  INSERT INTO villes(pays_id,nom,sort_order) VALUES(cf_id,'Bangui',1),(cf_id,'Bimbo',2) ON CONFLICT DO NOTHING;
  INSERT INTO villes(pays_id,nom,sort_order) VALUES(ao_id,'Luanda',1),(ao_id,'Cabinda',2) ON CONFLICT DO NOTHING;
END $$;

ALTER TABLE adresses_utilisateur ADD COLUMN IF NOT EXISTS pays_id UUID REFERENCES pays(id) ON DELETE SET NULL;
ALTER TABLE adresses_utilisateur ADD COLUMN IF NOT EXISTS ville_id UUID REFERENCES villes(id) ON DELETE SET NULL;
ALTER TABLE adresses ADD COLUMN IF NOT EXISTS pays_id UUID REFERENCES pays(id) ON DELETE SET NULL;
ALTER TABLE adresses ADD COLUMN IF NOT EXISTS ville_id UUID REFERENCES villes(id) ON DELETE SET NULL;
`;

async function main() {
  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url || !key) {
    console.error('❌ SUPABASE_URL et SUPABASE_SECRET_KEY requis');
    process.exit(1);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  // Try RPC first
  const { error } = await db.rpc('exec_sql', { query: SQL });
  if (!error) { console.log('✅ Migration réussie !'); return; }

  console.log('⚠️ exec_sql RPC pas disponible, tentative directe...');
  // Execute each statement individually
  const stmts = SQL.split(';').map(s => s.trim()).filter(s => s.length > 5);
  let ok = 0, fail = 0;
  for (const stmt of stmts) {
    try {
      const { error: e } = await db.rpc('exec_sql', { query: stmt + ';' });
      if (e) { console.warn('  ⚠️', e.message.slice(0, 80)); fail++; }
      else ok++;
    } catch (e) { console.warn('  ⚠️', e.message.slice(0, 80)); fail++; }
  }
  console.log(`✅ ${ok} OK, ${fail} échecs`);
}

main().catch(e => console.error('❌', e.message));
