-- ============================================================================
-- Parcours « paiement après acceptation »
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
