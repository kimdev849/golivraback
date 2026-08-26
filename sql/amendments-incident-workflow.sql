-- =============================================================================
-- Workflow d'incident complet
-- Nouveaux statuts de livraison + colonnes pour le transfert physique
-- Exécutez dans Supabase SQL Editor (une seule fois)
--
-- Nouveaux statuts :
--   incident     : livreur a signalé un problème
--   reassigning  : en attente d'un nouveau livreur (colis pas encore récupéré)
--   transferring : nouveau livreur assigné, transfert physique en cours
--
-- Ces statuts coexistent avec les statuts existants :
--   attribuee, en_collecte, collectee, en_route, livree, annulee
-- =============================================================================

-- ── Étendre le CHECK constraint du statut si elle existe ────────────────────
-- Supabase/PostgreSQL : on vérifie si la contrainte CHECK existe et on la met à jour
DO $$
DECLARE
  con_name text;
BEGIN
  -- Trouver la contrainte CHECK sur la colonne 'statut' de livraisons
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'livraisons'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%statut%'
  LIMIT 1;

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE livraisons DROP CONSTRAINT %I', con_name);
    RAISE NOTICE 'Ancienne contrainte CHECK supprimée : %', con_name;
  END IF;

  -- Recréer avec les nouveaux statuts
  ALTER TABLE livraisons ADD CONSTRAINT livraisons_statut_check
    CHECK (statut IN (
      'en_attente', 'attribuee', 'en_collecte', 'collectee', 'en_route',
      'livree', 'annulee', 'echec',
      'incident', 'reassigning', 'transferring'
    ));
  RAISE NOTICE 'Contrainte CHECK recréée avec les nouveaux statuts';
END $$;

-- ── Index pour les nouveaux statuts ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_livraisons_statut_incident
  ON livraisons (statut)
  WHERE statut IN ('incident', 'reassigning', 'transferring');

-- ── Mettre à jour les statuts actifs pour inclure les nouveaux ──────────────
-- ( Ceci est informatif — le code backend gère la liste ACTIVE_STATUSES )

NOTIFY pgrst, 'reload schema';
