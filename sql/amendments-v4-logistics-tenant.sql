-- =============================================================================
-- GoLivra v4 — Module entreprises logistiques (tenant livreurs)
-- À appliquer après amendments-v3-auth-staff-web.sql
-- =============================================================================

-- Nouveau rôle gestionnaire d'entreprise logistique (back-office tenant)
ALTER TYPE role_nom ADD VALUE IF NOT EXISTS 'gestionnaire_logistique';

INSERT INTO roles (nom, description) VALUES
  (
    'gestionnaire_logistique',
    'Gestionnaire d''une entreprise logistique — crée et supervise ses livreurs'
  )
ON CONFLICT (nom) DO NOTHING;

-- Canal d'identité : email obligatoire (connexion web), téléphone optionnel
CREATE OR REPLACE FUNCTION trg_validate_utilisateur_identite()
RETURNS TRIGGER AS $$
DECLARE
  r role_nom;
BEGIN
  SELECT nom INTO r FROM roles WHERE id = NEW.role_id;
  IF r IS NULL THEN
    RAISE EXCEPTION 'role_id invalide';
  END IF;

  IF r IN ('admin', 'gestionnaire_logistique') THEN
    IF NEW.email IS NULL OR btrim(NEW.email) = '' THEN
      RAISE EXCEPTION 'Pour le rôle %, l''email est obligatoire (connexion web).', r;
    END IF;
  ELSE
    IF NEW.telephone IS NULL OR btrim(NEW.telephone) = '' THEN
      RAISE EXCEPTION 'Pour le rôle %, le téléphone est obligatoire.', r;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
