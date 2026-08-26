-- =============================================================================
-- Table incident_event_logs : historique immuable des événements d'incident
-- Chaque action est enregistrée avec : acteur, rôle, action, dates, états
-- =============================================================================

CREATE TABLE IF NOT EXISTS incident_event_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  livraison_id    UUID NOT NULL REFERENCES livraisons(id) ON DELETE CASCADE,
  incident_id     UUID,  -- référence future si on crée une table incidents séparée
  
  -- Acteur
  acteur_id       UUID,  -- utilisateur_id de celui qui a effectué l'action
  acteur_role     VARCHAR(50),  -- 'livreur', 'gestionnaire', 'admin', 'systeme'
  acteur_nom      TEXT,  -- nom affiché (snapshot)
  
  -- Action
  action          VARCHAR(50) NOT NULL,  -- 'problem_reported', 'contacted', 'resolved', etc.
  action_detail   TEXT,  -- description détaillée
  
  -- États
  statut_avant    VARCHAR(30),  -- statut de la livraison AVANT l'action
  statut_apres    VARCHAR(30),  -- statut de la livraison APRÈS l'action
  
  -- Livreur
  livreur_avant_id UUID,  -- livreur AVANT changement
  livreur_apres_id UUID,  -- livreur APRÈS changement
  
  -- Entreprise
  entreprise_avant_id UUID,  -- entreprise AVANT changement
  entreprise_apres_id UUID,  -- entreprise APRÈS changement
  
  -- Métadonnées
  metadata        JSONB,  -- données supplémentaires (position, motif, etc.)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index pour les requêtes fréquentes
CREATE INDEX IF NOT EXISTS idx_incident_logs_livraison
  ON incident_event_logs (livraison_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_incident_logs_action
  ON incident_event_logs (action, created_at DESC);

-- Rendre la table immuable : pas de UPDATE, pas de DELETE
-- (PostgreSQL ne supporte pas 직접 AFTER DELETE/UPDATE sur les tables,
--  mais on peut révoquer les privilèges)
REVOKE UPDATE, DELETE ON incident_event_logs FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';
