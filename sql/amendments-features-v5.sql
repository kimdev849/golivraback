-- GoLivra v5 — préférences utilisateur, paramètres plateforme admin
-- Exécuter dans Supabase SQL Editor (idempotent).

ALTER TABLE utilisateurs
  ADD COLUMN IF NOT EXISTS preferences_json JSONB NOT NULL DEFAULT '{}'::jsonb;

INSERT INTO parametres_systeme (cle, valeur, type, description, est_public) VALUES
  ('golivra_platform_name', 'GoLivra', 'string', 'Nom affiché de la plateforme', TRUE),
  ('golivra_support_email', 'support@golivra.cg', 'string', 'E-mail support', TRUE),
  ('golivra_maintenance_mode', 'false', 'boolean', 'Mode maintenance (bloque les inscriptions)', FALSE),
  ('golivra_signups_open', 'true', 'boolean', 'Inscriptions ouvertes', TRUE),
  ('golivra_email_notifications', 'true', 'boolean', 'Notifications e-mail système', FALSE),
  ('golivra_sms_notifications', 'true', 'boolean', 'Notifications SMS système', FALSE)
ON CONFLICT (cle) DO NOTHING;
