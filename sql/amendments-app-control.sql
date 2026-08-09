-- ============================================================================
-- GoLivra — Contrôle total de l'application (feature flags)
-- ----------------------------------------------------------------------------
-- Ajoute dans parametres_systeme les interrupteurs de contrôle de l'app :
--   • golivra_app_enabled      → kill switch global (coupe toute l'app)
--   • golivra_maintenance_mode → mode maintenance (déjà existant)
--   • golivra_min_app_version  → version minimale acceptée (force la MAJ APK)
--   • golivra_beta_mode        → bêta fermée (accès restreint par téléphone)
--   • golivra_beta_phones      → liste de téléphones autorisés en bêta (virgules)
--   • golivra_orders_enabled   → activer / désactiver les commandes
--   • golivra_payments_enabled → activer / désactiver les paiements
--   • golivra_delivery_enabled → activer / désactiver les livraisons
--   • golivra_announcement     → message affiché dans l'app (bannière)
--
-- Idempotent : peut être exécuté plusieurs fois sans effet de bord.
-- Exécution : Supabase → SQL Editor → Run.
-- ============================================================================

-- Table parametres_systeme (créée si absente — base fraîchement resetée)
CREATE TABLE IF NOT EXISTS parametres_systeme (
  cle         VARCHAR(100) PRIMARY KEY,
  valeur      TEXT         NOT NULL,
  type        VARCHAR(20)  NOT NULL DEFAULT 'string',
  description TEXT,
  est_public  BOOLEAN      NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_par UUID
);

INSERT INTO parametres_systeme (cle, valeur, type, description, est_public) VALUES
  ('golivra_app_enabled',      'true',  'boolean', 'Kill switch global : si false, toute l''application est coupée',       TRUE),
  ('golivra_maintenance_mode', 'false', 'boolean', 'Mode maintenance : blocage de toute l''application (sauf admin)',     FALSE),
  ('golivra_min_app_version',  '1.0.0', 'string',  'Version minimale acceptée (force la mise à jour de l''APK)',          TRUE),
  ('golivra_beta_mode',        'false', 'boolean', 'Bêta fermée : seuls les téléphones autorisés peuvent se connecter',   TRUE),
  ('golivra_beta_phones',      '',      'string',  'Téléphones autorisés en bêta fermée (séparés par des virgules)',      FALSE),
  ('golivra_orders_enabled',   'true',  'boolean', 'Activer / désactiver la passation de commandes',                       TRUE),
  ('golivra_payments_enabled', 'true',  'boolean', 'Activer / désactiver les paiements en ligne',                          TRUE),
  ('golivra_delivery_enabled', 'true',  'boolean', 'Activer / désactiver les livraisons',                                  TRUE),
  ('golivra_announcement',     '',      'string',  'Message d''annonce affiché dans l''application (bannière)',            TRUE)
ON CONFLICT (cle) DO NOTHING;

-- Rapport
DO $$
DECLARE v_cnt BIGINT;
BEGIN
  SELECT count(*) INTO v_cnt FROM parametres_systeme WHERE cle LIKE 'golivra_%';
  RAISE NOTICE 'feature_flags=%', v_cnt;
END $$;
