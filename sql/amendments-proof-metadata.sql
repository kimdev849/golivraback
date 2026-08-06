-- =============================================================================
-- Preuve de livraison : méta-données complètes
-- -----------------------------------------------------------------------------
-- La photo (proof_photo_url) existe déjà. Cette migration ajoute :
--   - position GPS au moment de la prise
--   - horodatage de la prise
--   - présence ou non du client (cas 1 : client GoLivra / cas 2 : externe)
--
-- Ces données ne sont consultables qu'en cas de litige ou par l'administration
-- (elles sont masquées côté client dans les endpoints).
-- =============================================================================

ALTER TABLE livraisons
  ADD COLUMN IF NOT EXISTS proof_photo_url      TEXT,
  ADD COLUMN IF NOT EXISTS proof_gps_lat        NUMERIC(10, 8),
  ADD COLUMN IF NOT EXISTS proof_gps_lng        NUMERIC(11, 8),
  ADD COLUMN IF NOT EXISTS proof_taken_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS proof_client_present BOOLEAN;

NOTIFY pgrst, 'reload schema';
