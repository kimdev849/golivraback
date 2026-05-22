-- Corrige les anciens frais livraison à 500 FCFA (défaut schéma v3) vers le minimum plateforme.
UPDATE entreprises
SET frais_livraison = 1000
WHERE frais_livraison IS NOT NULL AND frais_livraison > 0 AND frais_livraison < 1000;

UPDATE parametres_systeme
SET valeur = '1000'
WHERE cle IN ('frais_livraison_base_fcfa', 'frais_livraison_min_fcfa')
  AND valeur IS NOT NULL
  AND CAST(NULLIF(TRIM(valeur), '') AS DECIMAL) < 1000;
