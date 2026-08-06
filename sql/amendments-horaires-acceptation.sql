-- ============================================================
-- HORAIRES D'OUVERTURE + DÉLAI D'ACCEPTATION (15 min)
-- ============================================================
-- 1) horaires_etablissements : horaires par commerce (restaurant OU boutique),
--    plusieurs plages possibles par jour (ex. déjeuner + dîner).
--    jour : 0 = Dimanche … 6 = Samedi (convention JS getDay()).
--    ouverture/fermeture : TIME (fermeture < ouverture = plage qui chevauche minuit).
-- 2) commandes.acceptation_limite_at : le commerce a 15 minutes pour accepter
--    après la création. Passé ce délai, un job expire la commande et déclenche
--    le remboursement automatique du client.
-- ============================================================

CREATE TABLE IF NOT EXISTS horaires_etablissements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  boutique_id   UUID REFERENCES boutiques(id)   ON DELETE CASCADE,
  jour          INT  NOT NULL CHECK (jour BETWEEN 0 AND 6),
  ouverture     TIME NOT NULL,
  fermeture     TIME NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT horaires_etablissements_ou_resto_ou_boutique CHECK (
    (restaurant_id IS NOT NULL AND boutique_id IS NULL)
    OR (restaurant_id IS NULL AND boutique_id IS NOT NULL)
  )
);

-- Empêche les doublons (même commerce, même jour, même plage).
CREATE UNIQUE INDEX IF NOT EXISTS idx_horaires_etablissements_resto_unique
  ON horaires_etablissements (restaurant_id, jour, ouverture, fermeture)
  WHERE restaurant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_horaires_etablissements_boutique_unique
  ON horaires_etablissements (boutique_id, jour, ouverture, fermeture)
  WHERE boutique_id IS NOT NULL;

COMMENT ON TABLE horaires_etablissements IS
  'Horaires d''ouverture des commerces. Jour 0=Dimanche … 6=Samedi. Une plage avec fermeture < ouverture chevauche minuit.';

-- ── Délai d'acceptation des commandes ─────────────────────────
ALTER TABLE commandes
  ADD COLUMN IF NOT EXISTS acceptation_limite_at TIMESTAMPTZ;

ALTER TABLE commandes
  ADD COLUMN IF NOT EXISTS expiree_at TIMESTAMPTZ;

ALTER TABLE sous_commandes
  ADD COLUMN IF NOT EXISTS expiree_at TIMESTAMPTZ;

COMMENT ON COLUMN commandes.acceptation_limite_at IS
  'Délai (15 min) laissé aux commerces pour accepter la commande. Dépassé → expiration + remboursement auto.';

-- Index pour le job d'expiration (recherche des commandes en attente en retard).
CREATE INDEX IF NOT EXISTS idx_commandes_acceptation_limite
  ON commandes (acceptation_limite_at)
  WHERE statut IN ('en_attente', 'partiellement_acceptee');

-- ── Remboursements (suivi des rembours automatiques d'expiration) ─────────
CREATE TABLE IF NOT EXISTS remboursements (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commande_id       UUID REFERENCES commandes(id) ON DELETE CASCADE,
  paiement_id       UUID REFERENCES paiements(id)  ON DELETE SET NULL,
  montant           NUMERIC(12,2),
  raison            TEXT,
  statut            VARCHAR(20) NOT NULL DEFAULT 'en_attente',
  pawapay_refund_id TEXT,
  reference_externe TEXT,
  cree_le           TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  traite_le         TIMESTAMPTZ
);

ALTER TABLE remboursements
  ADD COLUMN IF NOT EXISTS commande_id       UUID,
  ADD COLUMN IF NOT EXISTS paiement_id       UUID,
  ADD COLUMN IF NOT EXISTS montant           NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS raison            TEXT,
  ADD COLUMN IF NOT EXISTS statut            VARCHAR(20),
  ADD COLUMN IF NOT EXISTS pawapay_refund_id TEXT,
  ADD COLUMN IF NOT EXISTS reference_externe TEXT,
  ADD COLUMN IF NOT EXISTS traite_le         TIMESTAMPTZ;
