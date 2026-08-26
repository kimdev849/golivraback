-- =============================================================================
-- Workflow d'incident complet
-- Nouveaux statuts de livraison pour le transfert physique
-- Exécutez dans Supabase SQL Editor (une seule fois)
--
-- La colonne statut est un ENUM PostgreSQL → ALTER TYPE ADD VALUE
--
-- IMPORTANT : Ce script ne fait QUE créer les valeurs d'enum.
-- L'index est créé séparément (les valeurs d'enum doivent être
-- commitées avant d'être référencées dans un WHERE clause).
-- =============================================================================

-- ── Ajouter les nouvelles valeurs à l'enum livraison_statut ──────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'livraison_statut' AND e.enumlabel = 'incident'
  ) THEN
    ALTER TYPE livraison_statut ADD VALUE 'incident';
    RAISE NOTICE 'Valeur ajoutée : incident';
  ELSE
    RAISE NOTICE 'Déjà existant : incident';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'livraison_statut' AND e.enumlabel = 'reassigning'
  ) THEN
    ALTER TYPE livraison_statut ADD VALUE 'reassigning';
    RAISE NOTICE 'Valeur ajoutée : reassigning';
  ELSE
    RAISE NOTICE 'Déjà existant : reassigning';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'livraison_statut' AND e.enumlabel = 'transferring'
  ) THEN
    ALTER TYPE livraison_statut ADD VALUE 'transferring';
    RAISE NOTICE 'Valeur ajoutée : transferring';
  ELSE
    RAISE NOTICE 'Déjà existant : transferring';
  END IF;
END $$;

-- Recharge le cache PostgREST
NOTIFY pgrst, 'reload schema';
