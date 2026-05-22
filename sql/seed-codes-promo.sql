-- Codes promo GoLivra (à exécuter dans Supabase SQL Editor)
-- GOLIVRA10 : -10 % sur le sous-total (min 3000 FCFA)
-- LIVRAISON500 : -500 FCFA sur le sous-total (min 5000 FCFA)

INSERT INTO codes_promo (code, description, type_remise, valeur, montant_min, limite_usage, par_utilisateur, est_actif)
VALUES
  (
    'GOLIVRA10',
    '10 % de réduction sur vos achats',
    'pourcentage',
    10,
    3000,
    NULL,
    3,
    TRUE
  ),
  (
    'LIVRAISON500',
    '500 FCFA de réduction',
    'montant_fixe',
    500,
    5000,
    NULL,
    5,
    TRUE
  )
ON CONFLICT (code) DO UPDATE SET
  description = EXCLUDED.description,
  type_remise = EXCLUDED.type_remise,
  valeur = EXCLUDED.valeur,
  montant_min = EXCLUDED.montant_min,
  par_utilisateur = EXCLUDED.par_utilisateur,
  est_actif = TRUE;
