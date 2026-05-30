-- ============================================================
-- Migration : table push_tokens
-- À exécuter dans Supabase → SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS push_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utilisateur_id  UUID NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
  token           TEXT NOT NULL,
  platform        TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (utilisateur_id, token)
);

-- Index pour chercher rapidement les tokens d'un utilisateur
CREATE INDEX IF NOT EXISTS idx_push_tokens_user
  ON push_tokens (utilisateur_id);

-- Trigger updated_at automatique
CREATE OR REPLACE FUNCTION update_push_tokens_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_push_tokens_updated_at ON push_tokens;
CREATE TRIGGER trg_push_tokens_updated_at
  BEFORE UPDATE ON push_tokens
  FOR EACH ROW EXECUTE FUNCTION update_push_tokens_updated_at();

-- RLS : les utilisateurs ne peuvent voir que leurs propres tokens
ALTER TABLE push_tokens ENABLE ROW LEVEL SECURITY;

-- La clé service_role (backend) bypass RLS, pas besoin de policy pour lui.
-- Policy lecture : un user ne peut lire que ses tokens (inutile côté app mais safe)
CREATE POLICY "push_tokens_owner_select"
  ON push_tokens FOR SELECT
  USING (auth.uid() = utilisateur_id);

-- Policy insert : uniquement pour ses propres tokens
CREATE POLICY "push_tokens_owner_insert"
  ON push_tokens FOR INSERT
  WITH CHECK (auth.uid() = utilisateur_id);

-- Policy delete : uniquement les siens
CREATE POLICY "push_tokens_owner_delete"
  ON push_tokens FOR DELETE
  USING (auth.uid() = utilisateur_id);
