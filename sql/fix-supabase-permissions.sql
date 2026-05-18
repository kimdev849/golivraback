-- =============================================================================
-- GoLivra — Permissions Supabase (schema public)
-- Erreur typique API : "permission denied for schema public"
--
-- CAUSE LA PLUS FRÉQUENTE : mauvaise clé sur Render / .env
--   ❌ sb_publishable_...  (clé publique — mobile / navigateur)
--   ✅ sb_secret_...        (clé secrète serveur — backend Render)
--
-- Exécuter ce script dans Supabase → SQL Editor (une fois).
-- Puis remplacer SUPABASE_SECRET_KEY sur Render par la clé SECRÈTE.
-- =============================================================================

-- Accès au schéma public pour les rôles Supabase
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO postgres, service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO postgres, service_role;
GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public TO postgres, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO postgres, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ROUTINES TO postgres, service_role;

-- Tables OTP (les deux noms possibles)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;

-- PostgREST : recharger le cache après création de tables
NOTIFY pgrst, 'reload schema';
