-- Tarification en pourcentages (montants dynamiques, pas de FCFA fixes en code)
INSERT INTO parametres_systeme (cle, valeur, type, description, est_public) VALUES
  ('platform_fee_percent',        '0', 'number', 'Commission GoLivra sur ventes (%) — 0',                FALSE),
  ('merchant_percent',            '100', 'number', 'Part commerce sur ventes (%)',                        FALSE),
  ('delivery_platform_percent',   '20', 'number', 'Part GoLivra sur les frais de livraison (%)',        FALSE),
  ('delivery_logistics_percent',  '80', 'number', 'Part entreprise logistique sur frais livraison (%)', FALSE),
  ('frais_livraison_min_fcfa',    '200', 'number', 'Frais livraison minimum indicatif (FCFA)',          TRUE),
  ('frais_livraison_max_fcfa',    '500', 'number', 'Frais livraison maximum indicatif (FCFA)',          TRUE),
  ('payment_test_min_fcfa',       '1000', 'number', 'DEV : montant test paiement min (FCFA)',           FALSE),
  ('payment_test_max_fcfa',       '2000', 'number', 'DEV : montant test paiement max (FCFA)',           FALSE)
ON CONFLICT (cle) DO UPDATE SET
  valeur = EXCLUDED.valeur,
  description = EXCLUDED.description,
  updated_at = NOW();
