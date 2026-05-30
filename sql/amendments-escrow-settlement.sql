-- Escrow commande + règlement unique post-livraison
ALTER TABLE commandes
  ADD COLUMN IF NOT EXISTS escrow_credite_at TIMESTAMPTZ;

ALTER TABLE sous_commandes
  ADD COLUMN IF NOT EXISTS reglee_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sous_commandes_reglee_at ON sous_commandes(reglee_at)
  WHERE reglee_at IS NOT NULL;

COMMENT ON COLUMN commandes.escrow_credite_at IS 'Paiement client crédité sur le portefeuille escrow GoLivra';
COMMENT ON COLUMN sous_commandes.reglee_at IS 'Répartition marchand / livreur / commission effectuée (idempotent)';
