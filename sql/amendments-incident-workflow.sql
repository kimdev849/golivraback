-- =============================================================================
-- Workflow d'incident complet
-- Nouveaux statuts de livraison pour le transfert physique
-- Exécutez dans Supabase SQL Editor (une seule fois)
--
-- Nouveaux statuts :
--   incident     : livreur a signalé un problème
--   reassigning  : en attente d'un nouveau livreur (colis pas encore récupéré)
--   transferring : nouveau livreur assigné, transfert physique en cours
--
-- La colonne statut est un ENUM PostgreSQL → on utilise ALTER TYPE ADD VALUE
-- (on ne peut PAS ajouter de CHECK constraint sur un enum)
-- =============================================================================

-- ── Ajouter les nouvelles valeurs à l'enum livraison_statut ──────────────────
-- On vérifie d'abord si la valeur existe déjà pour éviter l'erreur "value already exists"
DO $$
BEGIN
  -- incident
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'livraison_statut' AND e.enumlabel = 'incident'
  ) THEN
    ALTER TYPE livraison_statut ADD VALUE 'incident';
    RAISE NOTICE 'Valeur ajoutée : incident';
  ELSE
    RAISE NOTICE 'Valeur déjà existante : incident';
  END IF;

  -- reassigning
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'livraison_statut' AND e.enumlabel = 'reassigning'
  ) THEN
    ALTER TYPE livraison_statut ADD VALUE 'reassigning';
    RAISE NOTICE 'Valeur ajoutée : reassigning';
  ELSE
    RAISE NOTICE 'Valeur déjà existante : reassigning';
  END IF;

  -- transferring
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'livraison_statut' AND e.enumlabel = 'transferring'
  ) THEN
    ALTER TYPE livraison_statut ADD VALUE 'transferring';
    RAISE NOTICE 'Valeur ajoutée : transferring';
  ELSE
    RAISE NOTICE 'Valeur déjà existante : transferring';
  END IF;
END $$;

-- ── Index pour les nouveaux statuts ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_livraisons_statut_incident
  ON livraisons (statut)
  WHERE statut IN ('incident', 'reassigning', 'transferring');

-- Recharge le cache PostgREST après ALTER TYPE (sinon l'API voit encore les anciennes valeurs)
NOTIFY pgrst, 'reload schema';
