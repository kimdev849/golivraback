-- Flux commande / livreur : blocage disponibilité par l'entreprise logistique
ALTER TABLE livreurs
  ADD COLUMN IF NOT EXISTS disponibilite_bloquee_entreprise BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_livreurs_dispo_bloquee ON livreurs(disponibilite_bloquee_entreprise)
  WHERE disponibilite_bloquee_entreprise = TRUE;
