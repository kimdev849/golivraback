-- =============================================================================
-- Preuve de livraison : photo prise par le livreur lors de la finalisation
-- =============================================================================

ALTER TABLE livraisons
  ADD COLUMN IF NOT EXISTS proof_photo_url TEXT;

NOTIFY pgrst, 'reload schema';
