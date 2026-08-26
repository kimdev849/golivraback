-- =============================================================================
-- Colonnes incident + retard pour la table livraisons
-- Exécutez dans Supabase SQL Editor (une seule fois)
--
-- Colonnes ajoutées :
--   incident_niveau  : 'niveau_1' | 'niveau_2' | 'niveau_3' (NULL = pas d'incident)
--   incident_depuis  : date/heure à laquelle l'incident a été détecté
--   incident_raison  : raison textuelle de la résolution/annulation
--   annulee_at       : date/heure d'annulation de la livraison
--   delay_reason     : motif du retard signalé par le livreur
--   delay_reason_at  : date du signalement du motif
--   delay_reason_detail : détails supplémentaires du motif
-- =============================================================================

-- ── Incident tracking ───────────────────────────────────────────────────────
ALTER TABLE livraisons
  ADD COLUMN IF NOT EXISTS incident_niveau VARCHAR(20),
  ADD COLUMN IF NOT EXISTS incident_depuis TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS incident_raison TEXT;

-- ── Annulation ──────────────────────────────────────────────────────────────
ALTER TABLE livraisons
  ADD COLUMN IF NOT EXISTS annulee_at TIMESTAMPTZ;

-- ── Motif de retard (signalé par le livreur) ────────────────────────────────
ALTER TABLE livraisons
  ADD COLUMN IF NOT EXISTS delay_reason VARCHAR(50),
  ADD COLUMN IF NOT EXISTS delay_reason_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delay_reason_detail TEXT;

-- ── Index pour les requêtes incident ────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_livraisons_incident_niveau
  ON livraisons (incident_niveau)
  WHERE incident_niveau IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_livraisons_incident_depuis
  ON livraisons (incident_depuis)
  WHERE incident_depuis IS NOT NULL;

-- Recharge le cache PostgREST après ALTER (sinon l'API voit encore d'anciennes colonnes)
NOTIFY pgrst, 'reload schema';
