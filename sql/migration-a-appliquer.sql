-- ============================================================================
-- GOLIVRA — MIGRATION À APPLIQUER (Supabase → SQL Editor → Run)
-- ============================================================================
-- Regroupe 2 migrations :
--   1) Parcours « paiement après acceptation »  (amendments-paiement-apres-acceptation.sql)
--   2) Suppression de compte + engagement       (amendments-account-deletion-and-engagement.sql)
--
-- ⚠️  IDEMPOTENT : peut être rejoué sans risque (ADD COLUMN IF NOT EXISTS).
--     Résultat attendu : « Success. No rows returned ».
-- ============================================================================


-- ============================================================================
-- 1. PARCOURS « PAIEMENT APRÈS ACCEPTATION »
-- ----------------------------------------------------------------------------
-- Nouveau flux client :
--   1. Commande envoyée (en_attente) — AUCUN paiement
--   2. Chaque commerce a 5 min (acceptation_limite_at) pour accepter/refuser,
--      avec un rappel à 3 min (acceptation_rappel_at).
--   3. Une fois toutes les réponses reçues (ou expirées), le client a 5 min
--      (paiement_limite_at) pour payer les segments acceptés.
--   4. Paiement confirmé → préparation → collecte → livraison → livrée.
--   5. Si le client ne paie pas dans le délai → commande annulée
--      (annulation_motif = « Le délai de paiement est expiré. »).
--
-- Rétro-compatible : ajoute uniquement des colonnes ; l'ancien flux (paiement
-- avant acceptation) continue de fonctionner.
-- ============================================================================

-- Rappel d'acceptation : posé une seule fois quand il reste <= 3 min.
ALTER TABLE commandes
  ADD COLUMN IF NOT EXISTS acceptation_rappel_at TIMESTAMPTZ;

-- Délai de paiement du client : armé quand la commande est « prête » (toutes
-- les sous-commandes ont répondu et au moins une est acceptée), effacé dès
-- que le paiement est validé.
ALTER TABLE commandes
  ADD COLUMN IF NOT EXISTS paiement_limite_at TIMESTAMPTZ;

-- Motif d'annulation affiché au client (ex. délai de paiement expiré,
-- annulé par le client).
ALTER TABLE commandes
  ADD COLUMN IF NOT EXISTS annulation_motif TEXT;

CREATE INDEX IF NOT EXISTS idx_commandes_paiement_limite
  ON commandes (paiement_limite_at)
  WHERE paiement_limite_at IS NOT NULL;

COMMENT ON COLUMN commandes.paiement_limite_at IS
  'Délai de paiement du client (5 min) : armé à la fin des réponses des commerces, annulé dès le paiement validé.';


-- ============================================================================
-- 2. SUPPRESSION DE COMPTE (soft delete + anonymisation) + ENGAGEMENT
-- ============================================================================

-- ----------------------------------------------------------------
-- 2.1 UTILISATEURS : colonnes de suppression douce (RGPD)
-- ----------------------------------------------------------------
ALTER TABLE utilisateurs
  ADD COLUMN IF NOT EXISTS est_supprime BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS supprime_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS raison_suppression TEXT;

CREATE INDEX IF NOT EXISTS idx_utilisateurs_est_supprime
  ON utilisateurs (est_supprime)
  WHERE est_supprime = TRUE;

COMMENT ON COLUMN utilisateurs.est_supprime IS
  'Compte supprimé par l''utilisateur (anonymisé, login bloqué). Conserve les FK pour l''historique.';
COMMENT ON COLUMN utilisateurs.supprime_at IS
  'Horodatage de la demande de suppression.';

-- ----------------------------------------------------------------
-- 2.2 PLATS / ARTICLES : compteurs vues & clics (engagement)
-- ----------------------------------------------------------------
ALTER TABLE plats
  ADD COLUMN IF NOT EXISTS nb_vues  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS nb_clics INTEGER NOT NULL DEFAULT 0;

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS nb_vues  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS nb_clics INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN plats.nb_vues  IS 'Nombre cumulé d''affichages du plat sur le marketplace.';
COMMENT ON COLUMN plats.nb_clics IS 'Nombre cumulé d''ajouts au panier / actions fortes.';
COMMENT ON COLUMN articles.nb_vues  IS 'Nombre cumulé d''affichages de l''article sur le marketplace.';
COMMENT ON COLUMN articles.nb_clics IS 'Nombre cumulé d''ajouts au panier / actions fortes.';

-- Fonctions d'incrément atomique (évite les races)
CREATE OR REPLACE FUNCTION increment_product_view(p_table TEXT, p_id UUID, p_amount INT DEFAULT 1)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_table = 'plats' THEN
    UPDATE plats SET nb_vues = COALESCE(nb_vues, 0) + p_amount WHERE id = p_id;
  ELSIF p_table = 'articles' THEN
    UPDATE articles SET nb_vues = COALESCE(nb_vues, 0) + p_amount WHERE id = p_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION increment_product_click(p_table TEXT, p_id UUID, p_amount INT DEFAULT 1)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_table = 'plats' THEN
    UPDATE plats SET nb_clics = COALESCE(nb_clics, 0) + p_amount WHERE id = p_id;
  ELSIF p_table = 'articles' THEN
    UPDATE articles SET nb_clics = COALESCE(nb_clics, 0) + p_amount WHERE id = p_id;
  END IF;
END;
$$;

-- ----------------------------------------------------------------
-- 2.3 (Optionnel) Index pour le tri par engagement (top vus)
-- ----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_plats_nb_vues_desc
  ON plats (restaurant_id, nb_vues DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_articles_nb_vues_desc
  ON articles (boutique_id, nb_vues DESC NULLS LAST);
