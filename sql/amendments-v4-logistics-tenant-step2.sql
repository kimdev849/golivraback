-- =============================================================================
-- GoLivra v4 — Étape 2/2 : rôle + trigger identité
-- À exécuter APRÈS amendments-v4-logistics-tenant.sql (étape 1 validée).
-- =============================================================================

INSERT INTO roles (nom, description) VALUES
  (
    'gestionnaire_logistique',
    'Gestionnaire d''une entreprise logistique — crée et supervise ses livreurs'
  )
ON CONFLICT (nom) DO NOTHING;

-- Met à jour la fonction appelée au démarrage du backend (ensureBaseRoles)
CREATE OR REPLACE FUNCTION ensure_base_roles()
RETURNS VOID AS $$
BEGIN
  INSERT INTO roles (nom, description) VALUES
    ('client',       'Utilisateur final'),
    ('restaurateur', 'Propriétaire de restaurant'),
    ('commercant',   'Propriétaire de boutique'),
    ('admin',        'Administrateur GoLivra'),
    ('livreur',      'Agent de livraison'),
    (
      'gestionnaire_logistique',
      'Gestionnaire d''une entreprise logistique — crée et supervise ses livreurs'
    )
  ON CONFLICT (nom) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- Canal d'identité : email obligatoire pour admin et gestionnaire logistique
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
