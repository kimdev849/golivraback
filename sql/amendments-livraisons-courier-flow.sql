-- =============================================================================
-- Flux livreur GoLivra : colonnes requises pour accepter / avancer / terminer
-- Exécutez dans Supabase SQL Editor (une fois), après dedupe-livraisons-sous-commande.sql
-- =============================================================================

ALTER TABLE livraisons
  ADD COLUMN IF NOT EXISTS sous_commande_id UUID,
  ADD COLUMN IF NOT EXISTS type_livraison VARCHAR(20) DEFAULT 'commande',
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS attribuee_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS collectee_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS livree_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS adresse_collecte_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS adresse_livraison_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS montant_livreur DECIMAL(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS commission_logistique DECIMAL(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS entreprise_logistique_id UUID,
  ADD COLUMN IF NOT EXISTS restaurant_id UUID,
  ADD COLUMN IF NOT EXISTS boutique_id UUID,
  ADD COLUMN IF NOT EXISTS client_nom TEXT,
  ADD COLUMN IF NOT EXISTS client_telephone TEXT,
  ADD COLUMN IF NOT EXISTS montant_total DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS note TEXT;

-- Ancienne colonne legacy (schema.sql) → synchro avec attribuee_at
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'livraisons' AND column_name = 'assigne_le'
  ) THEN
    UPDATE livraisons SET attribuee_at = assigne_le WHERE attribuee_at IS NULL AND assigne_le IS NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'livraisons' AND column_name = 'livre_le'
  ) THEN
    UPDATE livraisons SET livree_at = livre_le WHERE livree_at IS NULL AND livre_le IS NOT NULL;
  END IF;
END $$;

ALTER TABLE livreurs
  ADD COLUMN IF NOT EXISTS disponibilite_bloquee_entreprise BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS nb_livraisons_total INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS nb_livraisons_reussies INT NOT NULL DEFAULT 0;

ALTER TABLE sous_commandes
  ADD COLUMN IF NOT EXISTS collectee_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS livree_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS prete_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Dédoublonnage + index (idempotent)
UPDATE livraisons AS dup
SET statut = 'annulee', updated_at = NOW()
WHERE dup.statut = 'en_attente'
  AND dup.livreur_id IS NULL
  AND dup.sous_commande_id IS NOT NULL
  AND dup.id <> (
    SELECT l2.id FROM livraisons l2
    WHERE l2.sous_commande_id = dup.sous_commande_id
    ORDER BY l2.created_at ASC NULLS LAST
    LIMIT 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_livraisons_sous_commande_active
  ON livraisons (sous_commande_id)
  WHERE sous_commande_id IS NOT NULL AND statut NOT IN ('annulee', 'echec');

CREATE INDEX IF NOT EXISTS idx_livraisons_open
  ON livraisons (statut, created_at)
  WHERE livreur_id IS NULL AND statut = 'en_attente';

-- Legacy (schema.sql) : garder assigne_le / livre_le si la base est ancienne
ALTER TABLE livraisons
  ADD COLUMN IF NOT EXISTS assigne_le TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS livre_le TIMESTAMPTZ;

-- Recharge le cache PostgREST après ALTER (sinon l’API voit encore d’anciennes colonnes)
NOTIFY pgrst, 'reload schema';
