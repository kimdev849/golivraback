-- =============================================================================
-- GoLivra — Observabilité v2 : monitoring pro-grade
-- Dépend de : amendments-observability.sql (la table app_incidents doit exister)
-- À appliquer sur Supabase SQL Editor (idempotent).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Enrichissement de app_incidents
--    - fingerprint : regroupement d'occurrences du même bug
--    - error_type  : classification automatique (DatabaseError, AuthError, etc.)
--    - state       : cycle de vie (ouvert / acquitté / en cours / résolu)
--    - frames      : frames de la stack trace parsées (fichier:ligne:fonction)
--    - source_location : frame principale (où le bug s'est produit)
--    - code_context : extrait du code source autour de la frame
--    - github_url  : lien direct vers le fichier:ligne sur GitHub
-- -----------------------------------------------------------------------------
ALTER TABLE app_incidents
  ADD COLUMN IF NOT EXISTS fingerprint           TEXT,
  ADD COLUMN IF NOT EXISTS error_type            TEXT,
  ADD COLUMN IF NOT EXISTS state                 TEXT NOT NULL DEFAULT 'ouvert'
    CHECK (state IN ('ouvert', 'acquitte', 'en_cours', 'resolu')),
  ADD COLUMN IF NOT EXISTS occurrence_count      INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS latency_ms            INTEGER,
  ADD COLUMN IF NOT EXISTS acknowledged_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS acknowledged_by       UUID REFERENCES utilisateurs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_location       JSONB,
  ADD COLUMN IF NOT EXISTS frames                JSONB,
  ADD COLUMN IF NOT EXISTS code_context          JSONB,
  ADD COLUMN IF NOT EXISTS github_url            TEXT,
  ADD COLUMN IF NOT EXISTS request_payload       JSONB,
  ADD COLUMN IF NOT EXISTS environment           TEXT,
  ADD COLUMN IF NOT EXISTS release               TEXT;

-- Rétro-compat : les incidents créés avant la v2 utilisaient 'open' / 'resolved'.
UPDATE app_incidents
   SET state = 'ouvert'
 WHERE state = 'open';

UPDATE app_incidents
   SET state = 'resolu'
 WHERE state = 'resolved';

-- Rétro-compat : colonnes first_seen_at / last_seen_at
UPDATE app_incidents
   SET first_seen_at = COALESCE(first_seen_at, created_at),
       last_seen_at  = COALESCE(last_seen_at,  created_at)
 WHERE first_seen_at IS NULL OR last_seen_at IS NULL;

-- Index de regroupement par fingerprint
CREATE INDEX IF NOT EXISTS idx_app_incidents_fingerprint
  ON app_incidents (fingerprint)
  WHERE fingerprint IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_app_incidents_state_open
  ON app_incidents (state, last_seen_at DESC)
  WHERE state <> 'resolu';

CREATE INDEX IF NOT EXISTS idx_app_incidents_endpoint
  ON app_incidents (http_method, http_path, created_at DESC)
  WHERE http_path IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_app_incidents_error_type
  ON app_incidents (error_type, created_at DESC)
  WHERE error_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_app_incidents_severity_created
  ON app_incidents (severity, created_at DESC);

-- Index GIN pour la recherche par fichier dans source_location
CREATE INDEX IF NOT EXISTS idx_app_incidents_source_file
  ON app_incidents ((source_location->>'file'))
  WHERE source_location IS NOT NULL;

COMMENT ON TABLE app_incidents IS
  'Journal centralisé des erreurs et anomalies (mobile, admin web, API backend).';
COMMENT ON COLUMN app_incidents.fingerprint IS
  'Empreinte SHA1 pour regrouper les occurrences du même incident (méthode+endpoint+type+cause).';
COMMENT ON COLUMN app_incidents.error_type IS
  'Classification automatique (DatabaseError, AuthError, ValidationError, NetworkError, PaymentError, ExternalServiceError, RuntimeError, UnknownError).';
COMMENT ON COLUMN app_incidents.state IS
  'Cycle de vie : ouvert → acquitte → en_cours → resolu (peut revenir à ouvert).';
COMMENT ON COLUMN app_incidents.source_location IS
  'Frame principale du bug (fichier, ligne, colonne, fonction, in_app).';
COMMENT ON COLUMN app_incidents.frames IS
  'Liste des frames de la stack trace parsées.';
COMMENT ON COLUMN app_incidents.code_context IS
  'Extrait du code source autour de la frame (lignes avant/après).';
COMMENT ON COLUMN app_incidents.github_url IS
  'Lien direct GitHub vers le fichier:ligne fautif (si BACKEND_GITHUB_REPO_URL configuré).';

-- -----------------------------------------------------------------------------
-- 2) Événements de timeline (changements d'état, notes, occurrences)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id     UUID NOT NULL REFERENCES app_incidents(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL CHECK (event_type IN (
                    'cree', 'occurrence', 'acquitte', 'en_cours',
                    'resolu', 'reouvert', 'note', 'changement_statut'
                  )),
  actor_id        UUID REFERENCES utilisateurs(id) ON DELETE SET NULL,
  actor_kind      TEXT NOT NULL DEFAULT 'systeme'
                    CHECK (actor_kind IN ('admin', 'systeme', 'mobile', 'backend')),
  message         TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incident_events_incident
  ON incident_events (incident_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_incident_events_type
  ON incident_events (event_type, created_at DESC);

COMMENT ON TABLE incident_events IS
  'Timeline immuable des actions et occurrences d''un incident.';

-- -----------------------------------------------------------------------------
-- 3) Métriques brutes par requête (alimenté par le middleware de tracing)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS request_metrics (
  id              BIGSERIAL PRIMARY KEY,
  request_id      TEXT NOT NULL,
  method          TEXT NOT NULL,
  path            TEXT NOT NULL,
  status          INTEGER NOT NULL,
  latency_ms      INTEGER NOT NULL,
  source          TEXT,
  user_id         UUID REFERENCES utilisateurs(id) ON DELETE SET NULL,
  user_role       TEXT,
  error_type      TEXT,
  fingerprint     TEXT,
  environment     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_request_metrics_created
  ON request_metrics (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_request_metrics_endpoint_created
  ON request_metrics (method, path, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_request_metrics_status
  ON request_metrics (status, created_at DESC)
  WHERE status >= 400;

CREATE INDEX IF NOT EXISTS idx_request_metrics_fingerprint
  ON request_metrics (fingerprint, created_at DESC)
  WHERE fingerprint IS NOT NULL;

COMMENT ON TABLE request_metrics IS
  'Métriques brutes par requête (rétention 30j conseillée). Permet p50/p95/p99, taux d''erreur, slow.';

-- -----------------------------------------------------------------------------
-- 4) Snapshots horaires d'agrégation par endpoint
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS endpoint_health_snapshots (
  id                  BIGSERIAL PRIMARY KEY,
  bucket_hour         TIMESTAMPTZ NOT NULL,
  method              TEXT NOT NULL,
  path                TEXT NOT NULL,
  request_count       INTEGER NOT NULL DEFAULT 0,
  error_count         INTEGER NOT NULL DEFAULT 0,
  slow_count          INTEGER NOT NULL DEFAULT 0,
  latency_p50_ms      INTEGER,
  latency_p95_ms      INTEGER,
  latency_p99_ms      INTEGER,
  latency_max_ms      INTEGER,
  error_rate          NUMERIC(6,4) GENERATED ALWAYS AS
    (CASE WHEN request_count > 0
          THEN error_count::numeric / request_count
          ELSE 0 END) STORED,
  slow_rate           NUMERIC(6,4) GENERATED ALWAYS AS
    (CASE WHEN request_count > 0
          THEN slow_count::numeric / request_count
          ELSE 0 END) STORED,
  top_fingerprint     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bucket_hour, method, path)
);

CREATE INDEX IF NOT EXISTS idx_endpoint_health_bucket
  ON endpoint_health_snapshots (bucket_hour DESC);

CREATE INDEX IF NOT EXISTS idx_endpoint_health_endpoint
  ON endpoint_health_snapshots (method, path, bucket_hour DESC);

CREATE INDEX IF NOT EXISTS idx_endpoint_health_error_rate
  ON endpoint_health_snapshots (error_rate DESC, bucket_hour DESC)
  WHERE error_count > 0;

COMMENT ON TABLE endpoint_health_snapshots IS
  'Agrégations horaires par endpoint (taux d''erreur, p50/p95/p99, slow).';

-- -----------------------------------------------------------------------------
-- 5) Canaux d'alerte (Telegram, webhook, email)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_channels (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom             TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('telegram', 'webhook', 'email')),
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  est_actif       BOOLEAN NOT NULL DEFAULT TRUE,
  created_by      UUID REFERENCES utilisateurs(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_channels_actif
  ON alert_channels (est_actif) WHERE est_actif = TRUE;

COMMENT ON TABLE alert_channels IS
  'Destinations configurées pour recevoir les alertes (bot Telegram, webhook, email).';

-- -----------------------------------------------------------------------------
-- 6) Règles d'alerte
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_rules (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom                 TEXT NOT NULL,
  description         TEXT,
  est_actif           BOOLEAN NOT NULL DEFAULT TRUE,
  -- Condition (JSONB) — exemples :
  --   {"kind":"taux_erreur","path":"/api/orders","threshold":0.10,"window_min":15}
  --   {"kind":"endpoint_lent","threshold_ms":2000,"window_min":10}
  --   {"kind":"pic_incidents","severity":"error","window_min":5,"count":10}
  --   {"kind":"spike","baseline_min":60,"factor":3.0}
  condition           JSONB NOT NULL,
  channel_ids         UUID[] NOT NULL DEFAULT '{}',
  cooldown_min        INTEGER NOT NULL DEFAULT 15,
  last_fired_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_actif
  ON alert_rules (est_actif) WHERE est_actif = TRUE;

COMMENT ON TABLE alert_rules IS
  'Règles déclenchant des alertes selon des seuils sur les métriques.';

-- -----------------------------------------------------------------------------
-- 7) Historique d'envoi d'alertes
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id         UUID REFERENCES alert_rules(id) ON DELETE SET NULL,
  channel_id      UUID REFERENCES alert_channels(id) ON DELETE SET NULL,
  incident_id     UUID REFERENCES app_incidents(id) ON DELETE SET NULL,
  status          TEXT NOT NULL CHECK (status IN ('envoye', 'echec', 'skip_cooldown')),
  message         TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_history_created
  ON alert_history (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alert_history_rule
  ON alert_history (rule_id, created_at DESC);

-- =============================================================================
-- 8) Fonctions RPC utilitaires
-- =============================================================================

-- Agrège les métriques d'une fenêtre (en minutes) en un seul objet par endpoint.
CREATE OR REPLACE FUNCTION aggregate_endpoint_health(window_min INTEGER DEFAULT 60)
RETURNS TABLE (
  method TEXT,
  path TEXT,
  request_count BIGINT,
  error_count BIGINT,
  slow_count BIGINT,
  latency_p50_ms INTEGER,
  latency_p95_ms INTEGER,
  latency_p99_ms INTEGER,
  latency_max_ms INTEGER,
  top_fingerprint TEXT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH window_data AS (
    SELECT
      rm.method,
      rm.path,
      rm.status,
      rm.latency_ms,
      rm.fingerprint
    FROM request_metrics rm
    WHERE rm.created_at >= NOW() - (window_min || ' minutes')::interval
  ),
  agg AS (
    SELECT
      w.method,
      w.path,
      COUNT(*)::bigint AS request_count,
      COUNT(*) FILTER (WHERE w.status >= 500)::bigint AS error_count,
      COUNT(*) FILTER (WHERE w.latency_ms >= 2000)::bigint AS slow_count,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY w.latency_ms)::int AS latency_p50_ms,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY w.latency_ms)::int AS latency_p95_ms,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY w.latency_ms)::int AS latency_p99_ms,
      MAX(w.latency_ms)::int AS latency_max_ms
    FROM window_data w
    GROUP BY w.method, w.path
  ),
  top_fp AS (
    SELECT DISTINCT ON (w.method, w.path) w.method, w.path, w.fingerprint
    FROM window_data w
    WHERE w.fingerprint IS NOT NULL
    ORDER BY w.method, w.path, COUNT(*) DESC
  )
  SELECT
    a.method,
    a.path,
    a.request_count,
    a.error_count,
    a.slow_count,
    a.latency_p50_ms,
    a.latency_p95_ms,
    a.latency_p99_ms,
    a.latency_max_ms,
    tf.fingerprint
  FROM agg a
  LEFT JOIN top_fp tf ON tf.method = a.method AND tf.path = a.path
  ORDER BY a.request_count DESC;
END;
$$;

-- Calcule l'overview : volume, taux d'erreur, slow, par source, top endpoints.
CREATE OR REPLACE FUNCTION get_observability_summary(window_min INTEGER DEFAULT 60)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'window_min', window_min,
    'request_count', COALESCE(SUM(rm.request_count), 0),
    'error_count',   COALESCE(SUM(rm.error_count), 0),
    'slow_count',    COALESCE(SUM(rm.slow_count), 0),
    'by_source',     COALESCE((
      SELECT jsonb_agg(row_to_json(s))
      FROM (
        SELECT source,
               COUNT(*)::bigint AS total,
               COUNT(*) FILTER (WHERE status >= 500)::bigint AS errors
        FROM request_metrics
        WHERE created_at >= NOW() - (window_min || ' minutes')::interval
        GROUP BY source
      ) s
    ), '[]'::jsonb),
    'open_incidents', COALESCE((
      SELECT jsonb_agg(row_to_json(i))
      FROM (
        SELECT severity, COUNT(*)::bigint AS total
        FROM app_incidents
        WHERE state <> 'resolu'
        GROUP BY severity
      ) i
    ), '[]'::jsonb)
  )
  INTO result
  FROM (
    SELECT
      COUNT(*)::bigint AS request_count,
      COUNT(*) FILTER (WHERE status >= 500)::bigint AS error_count,
      COUNT(*) FILTER (WHERE latency_ms >= 2000)::bigint AS slow_count
    FROM request_metrics
    WHERE created_at >= NOW() - (window_min || ' minutes')::interval
  ) rm;
  RETURN result;
END;
$$;

-- =============================================================================
-- 9) Trigger : déduplication incrémentale par fingerprint
-- =============================================================================
CREATE OR REPLACE FUNCTION trg_incident_dedup()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.fingerprint IS NULL THEN
    RETURN NEW;
  END IF;
  -- Si un incident résolu existe déjà avec le même fingerprint, on le rouvre
  -- et on compte l'occurrence.
  IF TG_OP = 'INSERT' THEN
    UPDATE app_incidents
    SET occurrence_count = occurrence_count + 1,
        last_seen_at = NOW(),
        state = 'ouvert',
        resolved = FALSE,
        resolved_at = NULL,
        resolved_by = NULL
    WHERE fingerprint = NEW.fingerprint
      AND id <> NEW.id
      AND state = 'resolu';
    -- Sinon, on incrémente l'incident ouvert le plus ancien.
    UPDATE app_incidents
    SET occurrence_count = occurrence_count + 1,
        last_seen_at = NOW()
    WHERE fingerprint = NEW.fingerprint
      AND id <> NEW.id
      AND state <> 'resolu'
      AND created_at < NEW.created_at;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_app_incidents_dedup ON app_incidents;
CREATE TRIGGER trg_app_incidents_dedup
  BEFORE INSERT ON app_incidents
  FOR EACH ROW
  EXECUTE FUNCTION trg_incident_dedup();

-- =============================================================================
-- 10) Trigger : crée automatiquement un événement "cree" / "occurrence" /
--     "changement_statut" dans la timeline.
-- =============================================================================
CREATE OR REPLACE FUNCTION trg_incident_event_log()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO incident_events (incident_id, event_type, actor_kind, message, metadata)
    VALUES (
      NEW.id,
      'cree',
      COALESCE(NEW.source, 'systeme'),
      NEW.title,
      jsonb_build_object('severity', NEW.severity, 'category', NEW.category, 'fingerprint', NEW.fingerprint)
    );
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.state IS DISTINCT FROM OLD.state THEN
      INSERT INTO incident_events (incident_id, event_type, actor_kind, message, metadata)
      VALUES (
        NEW.id,
        CASE
          WHEN NEW.state = 'acquitte'  THEN 'acquitte'
          WHEN NEW.state = 'en_cours' THEN 'en_cours'
          WHEN NEW.state = 'resolu'   THEN 'resolu'
          WHEN OLD.state = 'resolu' AND NEW.state <> 'resolu' THEN 'reouvert'
          ELSE 'changement_statut'
        END,
        'admin',
        NEW.admin_note,
        jsonb_build_object(
          'old_state', OLD.state,
          'new_state', NEW.state,
          'occurrence_count', NEW.occurrence_count
        )
      );
    ELSIF NEW.occurrence_count IS DISTINCT FROM OLD.occurrence_count THEN
      INSERT INTO incident_events (incident_id, event_type, actor_kind, message, metadata)
      VALUES (
        NEW.id,
        'occurrence',
        'systeme',
        'Nouvelle occurrence détectée',
        jsonb_build_object('count', NEW.occurrence_count, 'last_seen_at', NEW.last_seen_at)
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_app_incidents_event_log ON app_incidents;
CREATE TRIGGER trg_app_incidents_event_log
  AFTER INSERT OR UPDATE ON app_incidents
  FOR EACH ROW
  EXECUTE FUNCTION trg_incident_event_log();
