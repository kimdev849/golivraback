-- =============================================================================
-- GoLivra — Observabilité : incidents applicatifs (mobile, admin, backend)
-- À appliquer sur Supabase avant d'utiliser le module observability.
-- =============================================================================

CREATE TABLE IF NOT EXISTS app_incidents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('mobile', 'admin', 'backend', 'api')),
  severity        TEXT NOT NULL DEFAULT 'error' CHECK (severity IN ('error', 'warn', 'info')),
  category        TEXT NOT NULL DEFAULT 'unknown',
  title           TEXT NOT NULL,
  message         TEXT NOT NULL,
  cause           TEXT,
  stack           TEXT,
  http_method     TEXT,
  http_path       TEXT,
  http_status     INT,
  user_id         UUID REFERENCES utilisateurs(id) ON DELETE SET NULL,
  user_role       TEXT,
  platform        TEXT,
  app_version     TEXT,
  device_info     JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved        BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID REFERENCES utilisateurs(id) ON DELETE SET NULL,
  admin_note      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_incidents_created_at
  ON app_incidents (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_incidents_request_id
  ON app_incidents (request_id);

CREATE INDEX IF NOT EXISTS idx_app_incidents_open
  ON app_incidents (resolved, created_at DESC)
  WHERE resolved = FALSE;

CREATE INDEX IF NOT EXISTS idx_app_incidents_source_severity
  ON app_incidents (source, severity, created_at DESC);

COMMENT ON TABLE app_incidents IS
  'Journal centralisé des erreurs et anomalies (mobile, admin web, API backend).';
