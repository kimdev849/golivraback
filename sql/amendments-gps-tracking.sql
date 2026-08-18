-- =============================================================================
-- GPS Tracking : colonnes de position pour le suivi temps réel des livreurs
-- Exécutez dans Supabase SQL Editor (une fois)
-- =============================================================================

-- Position actuelle du livreur (mise à jour toutes les 30s pendant une course)
ALTER TABLE livreurs
  ADD COLUMN IF NOT EXISTS latitude_actuelle   DECIMAL(10, 8),
  ADD COLUMN IF NOT EXISTS longitude_actuelle  DECIMAL(11, 8),
  ADD COLUMN IF NOT EXISTS derniere_position_at TIMESTAMPTZ;

-- Coordonnées GPS de la livraison (pour calculer distance livreur→client)
-- latitude_collecte = position du commerce (retrait)
-- latitude_livraison = position du client (destination)
ALTER TABLE livraisons
  ADD COLUMN IF NOT EXISTS latitude_collecte   DECIMAL(10, 8),
  ADD COLUMN IF NOT EXISTS longitude_collecte  DECIMAL(11, 8),
  ADD COLUMN IF NOT EXISTS latitude_livraison  DECIMAL(10, 8),
  ADD COLUMN IF NOT EXISTS longitude_livraison DECIMAL(11, 8);

-- Index pour la requête tracking (recherche rapide des livreurs avec position récente)
CREATE INDEX IF NOT EXISTS idx_livreurs_derniere_position
  ON livreurs (derniere_position_at)
  WHERE latitude_actuelle IS NOT NULL;

-- Recharge le cache PostgREST après ALTER
NOTIFY pgrst, 'reload schema';
