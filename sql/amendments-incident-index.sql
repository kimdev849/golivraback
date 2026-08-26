-- =============================================================================
-- Index pour les statuts incident workflow
-- Exécuter APRÈS amendments-incident-workflow.sql (les valeurs d'enum
-- doivent être commitées avant d'être référencées dans un WHERE clause)
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_livraisons_statut_incident
  ON livraisons (statut)
  WHERE statut IN ('incident', 'reassigning', 'transferring');

NOTIFY pgrst, 'reload schema';
