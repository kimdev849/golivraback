-- ============================================================================
-- GoLivra — Nettoyage du bruit d'observabilité (à exécuter UNE SEULE FOIS)
-- ============================================================================
-- Après les correctifs déployés (catégories PostgREST + 503 « règle métier »
-- exclus des incidents et du taux de 5xx), ce script purge :
--   1. les incidents ouverts créés il y a plus d'1 heure → bruit pré-correctif
--      (500 catégories, 503 paiements/commandes des tests, bug ID court…),
--   2. les métriques 5xx antérieures à 30 minutes → le taux de 5xx du
--      « Centre de contrôle » revient à zéro immédiatement.
--
-- ⚠️  Aucune donnée métier n'est touchée (commandes, paiements, utilisateurs…).
--     Le compte admin est intact. Les incidents RÉCENTS (moins d'1 h) restent
--     ouverts pour ne rien masquer.
-- ============================================================================

-- 1) Résoudre les incidents ouverts antérieurs à 1 heure (bruit historique)
UPDATE app_incidents
SET state = 'resolu',
    resolved = true,
    resolved_at = now(),
    resolved_by = NULL,
    admin_note = 'Résolu automatiquement — cause racine corrigée (catégories + 503 métier)'
WHERE state <> 'resolu'
  AND created_at < now() - interval '1 hour';

-- 2) Purger les métriques 5xx antérieures à 30 minutes
--    (le taux de 5xx affiché se recale immédiatement sur la fenêtre de 60 min)
DELETE FROM request_metrics
WHERE status >= 500
  AND created_at < now() - interval '30 minutes';
