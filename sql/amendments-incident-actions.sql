-- =============================================================================
-- Table incident_actions : journal des actions operateur sur les incidents
-- Chaque action (resolution, annulation, note, escalade) est enregistree ici.
-- =============================================================================

CREATE TABLE IF NOT EXISTS incident_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  livraison_id UUID NOT NULL REFERENCES livraisons(id) ON DELETE CASCADE,
  action VARCHAR(50) NOT NULL,
  operateur_nom TEXT,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incident_actions_livraison
  ON incident_actions (livraison_id, created_at DESC);

NOTIFY pgrst, 'reload schema';
