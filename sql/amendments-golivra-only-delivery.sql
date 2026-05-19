-- Tous les commerces : livraison exclusivement via livreurs GoLivra
UPDATE restaurants SET livraison_propre = FALSE WHERE livraison_propre = TRUE;
UPDATE boutiques SET livraison_propre = FALSE WHERE livraison_propre = TRUE;
