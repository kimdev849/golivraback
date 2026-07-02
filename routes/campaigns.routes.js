const express = require('express');
const { getDb } = require('../config/db');

const router = express.Router();

/**
 * GET /api/campaigns/active
 * Retourne les campagnes actives pour la période courante.
 * Utilisé par l'app mobile pour la section "Offre du jour" / merchandising.
 * Supporte le filtre optionnel ?ville_id= pour la pertinence locale.
 */
router.get('/active', async (req, res, next) => {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const villeId = req.query.ville_id || null;

    // Campagnes avec dates dans la période courante
    let { data: campaignsWithDates, error: err1 } = await db
      .from('marketing_campaigns')
      .select('*')
      .eq('est_actif', true)
      .lte('date_debut', now)
      .gte('date_fin', now)
      .order('created_at', { ascending: false });

    if (err1) throw err1;

    // Campagnes sans date (toujours actives tant que est_actif = true)
    let { data: campaignsNoDate, error: err2 } = await db
      .from('marketing_campaigns')
      .select('*')
      .eq('est_actif', true)
      .is('date_debut', null)
      .order('created_at', { ascending: false });

    if (err2) throw err2;

    let campaigns = [...(campaignsWithDates || []), ...(campaignsNoDate || [])];

    // Si filtre par ville, ne garder que les campagnes associées à cette ville
    if (villeId && campaigns.length > 0) {
      const campagneIds = campaigns.map((c) => c.id);
      const { data: cv, error: cvErr } = await db
        .from('campagne_villes')
        .select('campagne_id')
        .eq('ville_id', villeId)
        .in('campagne_id', campagneIds);

      if (cvErr) throw cvErr;

      const allowedIds = new Set((cv || []).map((r) => r.campagne_id));
      campaigns = campaigns.filter((c) => allowedIds.has(c.id));
    }

    // Enrichir avec les villes associées
    const enriched = await Promise.all(
      campaigns.map(async (c) => {
        const { data: villes, error: vErr } = await db
          .from('campagne_villes')
          .select('ville_id, villes!inner(id, nom)')
          .eq('campagne_id', c.id);

        return {
          id: c.id,
          nom: c.nom,
          description: c.description || null,
          type: c.type,
          image_url: c.image_url || null,
          date_debut: c.date_debut || null,
          date_fin: c.date_fin || null,
          villes: (villes || []).map((v) => ({ id: v.ville_id, nom: v.villes.nom })),
        };
      }),
    );

    return res.json(enriched);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
