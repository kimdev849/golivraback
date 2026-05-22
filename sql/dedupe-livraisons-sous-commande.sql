-- Nettoie les livraisons en double pour une même sous-commande (garde la plus ancienne).
-- À exécuter une fois sur Supabase si des doublons existent déjà.

UPDATE livraisons AS dup
SET statut = 'annulee', updated_at = NOW()
WHERE dup.statut = 'en_attente'
  AND dup.livreur_id IS NULL
  AND dup.sous_commande_id IS NOT NULL
  AND dup.id <> (
    SELECT l2.id
    FROM livraisons l2
    WHERE l2.sous_commande_id = dup.sous_commande_id
    ORDER BY l2.created_at ASC NULLS LAST
    LIMIT 1
  );

-- Empêche les futurs doublons (sous-commande liée)
CREATE UNIQUE INDEX IF NOT EXISTS uq_livraisons_sous_commande_active
  ON livraisons (sous_commande_id)
  WHERE sous_commande_id IS NOT NULL AND statut NOT IN ('annulee', 'echec');
