-- Portefeuilles : demandes de retrait (Mobile Money / virement)
CREATE TABLE IF NOT EXISTS demandes_retrait (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  portefeuille_id UUID          NOT NULL REFERENCES portefeuilles(id),
  utilisateur_id  UUID          NOT NULL REFERENCES utilisateurs(id),
  montant         DECIMAL(12,2) NOT NULL CHECK (montant > 0),
  methode         VARCHAR(50)   NOT NULL DEFAULT 'airtel_money',
  numero_compte   VARCHAR(50)   NOT NULL,
  statut          VARCHAR(20)   NOT NULL DEFAULT 'en_attente',
  note_demandeur  TEXT,
  note_admin      TEXT,
  traite_par      UUID          REFERENCES utilisateurs(id),
  traite_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_demande_retrait_statut CHECK (
    statut IN ('en_attente', 'approuve', 'rejete', 'paye')
  )
);

CREATE INDEX IF NOT EXISTS idx_demandes_retrait_utilisateur ON demandes_retrait(utilisateur_id);
CREATE INDEX IF NOT EXISTS idx_demandes_retrait_statut ON demandes_retrait(statut);
CREATE INDEX IF NOT EXISTS idx_demandes_retrait_created ON demandes_retrait(created_at DESC);

-- GoLivra : aucune commission sur les ventes, uniquement sur les frais de livraison
INSERT INTO parametres_systeme (cle, valeur, type, description, est_public) VALUES
  ('platform_fee_percent', '0', 'number', 'Commission GoLivra sur ventes produits (%) — toujours 0', FALSE),
  ('merchant_percent', '100', 'number', 'Part commerce sur ventes (%)', FALSE)
ON CONFLICT (cle) DO UPDATE SET valeur = EXCLUDED.valeur, updated_at = NOW();
