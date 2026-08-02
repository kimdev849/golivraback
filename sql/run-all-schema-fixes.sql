-- ============================================================================
-- GoLivra — Correctifs de schéma CONSOLIDÉS (idempotent, exécution multiple OK)
-- ----------------------------------------------------------------------------
-- Cible : Supabase → SQL Editor (ou psql).
--
-- Corrige les causes racines de la plupart des erreurs API observées :
--   1. Inscription / login 500        → colonne `avatar_url` absente
--   2. Feed / recherche produits 500  → colonnes `logo_url`/`image_url` absentes
--   3. Favoris produits 500           → table `favoris_produits` absente
--   4. Locations 404                  → tables `pays` / `villes` absentes
--   5. Retraits admin 500             → table `withdrawals` absente
--   6. Admin « Analyser » 500         → table `incident_events` absente
--
-- Une fois exécuté : Supabase → Project Settings → API → « Reload schema cache »
-- puis redéployez l'API (Render) pour purger le cache PostgREST.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. UTILISATEURS : avatar_url (image de profil par URL)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. COMMERCES : logo_url (image par URL) — restaurants + boutiques
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE boutiques   ADD COLUMN IF NOT EXISTS logo_url TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. PRODUITS : image_url (image principale par URL) — plats + articles
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE plats     ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE articles  ADD COLUMN IF NOT EXISTS image_url TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. PAYS / VILLES (référentiel géographique)
-- ─────────────────────────────────────────────────────────────────────────────
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

ALTER TABLE pays ADD COLUMN IF NOT EXISTS phone_digits SMALLINT;
ALTER TABLE pays ADD COLUMN IF NOT EXISTS phone_format VARCHAR(20);

CREATE TABLE IF NOT EXISTS villes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pays_id     UUID         NOT NULL REFERENCES pays(id) ON DELETE CASCADE,
  nom         VARCHAR(150) NOT NULL,
  sort_order  INTEGER      NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT villes_pays_nom_unique UNIQUE (pays_id, nom)
);

CREATE INDEX IF NOT EXISTS idx_villes_pays_id ON villes(pays_id);

-- Colonnes ville/pays sur les commerces (filtre du feed + adresses)
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS pays_id  UUID REFERENCES pays(id)   ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ville_id UUID REFERENCES villes(id) ON DELETE SET NULL;
ALTER TABLE boutiques
  ADD COLUMN IF NOT EXISTS pays_id  UUID REFERENCES pays(id)   ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ville_id UUID REFERENCES villes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_restaurants_pays_id  ON restaurants(pays_id);
CREATE INDEX IF NOT EXISTS idx_restaurants_ville_id ON restaurants(ville_id);
CREATE INDEX IF NOT EXISTS idx_boutiques_pays_id    ON boutiques(pays_id);
CREATE INDEX IF NOT EXISTS idx_boutiques_ville_id   ON boutiques(ville_id);

-- Seed minimal (Congo / Brazzaville) — idempotent
INSERT INTO pays (nom, code_iso2, code_iso3, indicatif) VALUES
  ('Congo', 'CG', 'COG', '+242')
ON CONFLICT (code_iso2) DO NOTHING;

UPDATE pays SET phone_digits = 9, phone_format = '2,3,2,2' WHERE code_iso2 = 'CG';

DO $$
DECLARE
  v_cg_id UUID;
  v_bzv_id UUID;
BEGIN
  SELECT id INTO v_cg_id FROM pays WHERE code_iso2 = 'CG';
  INSERT INTO villes (pays_id, nom, sort_order) VALUES
    (v_cg_id, 'Brazzaville', 1),
    (v_cg_id, 'Pointe-Noire', 2),
    (v_cg_id, 'Dolisie', 3)
  ON CONFLICT (pays_id, nom) DO NOTHING;

  -- Backfill des commerces existants sans pays/ville → Congo / Brazzaville
  SELECT id INTO v_bzv_id FROM villes WHERE pays_id = v_cg_id AND nom = 'Brazzaville';
  UPDATE restaurants SET pays_id = COALESCE(pays_id, v_cg_id), ville_id = COALESCE(ville_id, v_bzv_id)
    WHERE pays_id IS NULL OR ville_id IS NULL;
  UPDATE boutiques SET pays_id = COALESCE(pays_id, v_cg_id), ville_id = COALESCE(ville_id, v_bzv_id)
    WHERE pays_id IS NULL OR ville_id IS NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. FAVORIS PRODUITS (plats + articles)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS favoris_produits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
  produit_id UUID NOT NULL,
  produit_kind VARCHAR(20) NOT NULL CHECK (produit_kind IN ('plat', 'article')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, produit_id, produit_kind)
);

CREATE INDEX IF NOT EXISTS idx_favoris_produits_client
  ON favoris_produits (client_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. RETRAITS (payments refactor) : enum + table withdrawals
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE withdrawal_statut AS ENUM (
    'en_attente', 'en_traitement', 'reussi', 'echoue', 'rejete', 'annule'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE withdrawal_methode AS ENUM ('airtel_money', 'mtn_money', 'virement');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS withdrawals (
  id                  UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  portefeuille_id     UUID                NOT NULL REFERENCES portefeuilles(id),
  utilisateur_id      UUID                NOT NULL REFERENCES utilisateurs(id),
  montant             DECIMAL(12,2)       NOT NULL CHECK (montant > 0),
  devise              VARCHAR(5)          NOT NULL DEFAULT 'XAF',
  methode             withdrawal_methode  NOT NULL DEFAULT 'airtel_money',
  numero_compte       VARCHAR(50)         NOT NULL,
  nom_beneficiaire    VARCHAR(150),
  statut              withdrawal_statut   NOT NULL DEFAULT 'en_attente',
  motif_rejet         TEXT,
  note_demandeur      TEXT,
  note_admin          TEXT,
  payout_id           TEXT,
  payout_failure_reason TEXT,
  tentatives          SMALLINT            NOT NULL DEFAULT 0,
  traite_par          UUID                REFERENCES utilisateurs(id),
  traite_at           TIMESTAMPTZ,
  processed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_withdrawals_utilisateur  ON withdrawals(utilisateur_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_portefeuille ON withdrawals(portefeuille_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_statut       ON withdrawals(statut);
CREATE INDEX IF NOT EXISTS idx_withdrawals_created      ON withdrawals(created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. OBSERVABILITÉ v2 : table incident_events (timeline des incidents)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS incident_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id     UUID NOT NULL REFERENCES app_incidents(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL CHECK (event_type IN (
                    'cree', 'occurrence', 'acquitte', 'en_cours',
                    'resolu', 'reouvert', 'note', 'changement_statut'
                  )),
  actor_id        UUID REFERENCES utilisateurs(id) ON DELETE SET NULL,
  actor_kind      TEXT NOT NULL DEFAULT 'systeme',
  message         TEXT,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incident_events_incident
  ON incident_events (incident_id, created_at DESC);

-- Colonnes JSONB manquantes éventuelles sur app_incidents
ALTER TABLE app_incidents
  ADD COLUMN IF NOT EXISTS source_location JSONB,
  ADD COLUMN IF NOT EXISTS frames          JSONB,
  ADD COLUMN IF NOT EXISTS code_context    JSONB,
  ADD COLUMN IF NOT EXISTS github_url      TEXT,
  ADD COLUMN IF NOT EXISTS request_payload JSONB;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. OBSERVABILITÉ v2 : trigger de timeline (si la fonction n'existe pas déjà)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION log_incident_event()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO incident_events (incident_id, event_type, actor_kind, message, metadata)
    VALUES (NEW.id, 'cree', COALESCE(NEW.source, 'systeme'), NEW.title,
            jsonb_build_object('severity', NEW.severity, 'category', NEW.category,
                               'fingerprint', NEW.fingerprint));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.state IS DISTINCT FROM OLD.state THEN
      INSERT INTO incident_events (incident_id, event_type, actor_kind, message, metadata)
      VALUES (NEW.id,
              CASE
                WHEN NEW.state = 'acquitte' THEN 'acquitte'
                WHEN NEW.state = 'en_cours' THEN 'en_cours'
                WHEN NEW.state = 'resolu'   THEN 'resolu'
                WHEN OLD.state = 'resolu' AND NEW.state <> 'resolu' THEN 'reouvert'
                ELSE 'changement_statut'
              END,
              'systeme', NULL, jsonb_build_object('from', OLD.state, 'to', NEW.state));
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_app_incidents_timeline ON app_incidents;
CREATE TRIGGER trg_app_incidents_timeline
  AFTER INSERT OR UPDATE OF state ON app_incidents
  FOR EACH ROW EXECUTE FUNCTION log_incident_event();

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. RAPPEL FINAL
-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Supabase → Project Settings → API → « Reload schema »
-- 2) Redéployez l'API (Render) pour vider le cache PostgREST.
-- 3) Pour le référentiel complet (tous pays / arrondissements / zones), exécutez
--    aussi : amendments-pays-villes-quartiers.sql, amendments-pays-phone-digits.sql,
--    amendments-image-urls.sql, amendments-observability-v2.sql (déjà inclus ici).
