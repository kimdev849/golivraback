-- ============================================================================
-- GoLivra — Prix maximal produit/plat : 999 999 999 FCFA
-- ----------------------------------------------------------------------------
-- Le schéma v3 utilise déjà DECIMAL(12,2) (max 9 999 999 999,99) sur toutes les
-- colonnes monétaires. Mais les bases créées avec l'ancien schéma (v2) ont des
-- colonnes DECIMAL(10,2) → maximum 99 999 999,99 : un prix de 135 000 000
-- FCFA (ou plus) provoquerait une erreur « numeric field overflow » à l'insertion.
--
-- Ce correctif est IDEMPOTENT : il ne modifie que les colonnes NUMERIC dont la
-- précision est inférieure à 12 (il ne touche pas poids_kg ni les colonnes déjà
-- correctes, donc pas de réécriture de table inutile).
--
-- Exécution : Supabase → SQL Editor (ou psql), puis
--   1) Supabase → Project Settings → API → « Reload schema cache »
--   2) Redéployez l'API (Render) pour purger le cache PostgREST.
-- ============================================================================

DO $$
DECLARE
  col record;
BEGIN
  FOR col IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type = 'numeric'
      AND numeric_precision < 12
      AND column_name IN (
        'prix', 'prix_promo', 'prix_unitaire', 'prix_total',
        'total', 'sous_total', 'frais_livraison', 'frais_livraison_total',
        'remise', 'remise_totale', 'montant', 'solde',
        'commission_ttc', 'montant_etablissement'
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE IF EXISTS %I ALTER COLUMN %I TYPE DECIMAL(12,2)',
      col.table_name,
      col.column_name
    );
    RAISE NOTICE 'Élargi : %.% → DECIMAL(12,2)', col.table_name, col.column_name;
  END LOOP;
END $$;
