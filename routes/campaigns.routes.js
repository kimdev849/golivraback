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
    const villeId = req.query.ville_id || null;

    // Campagnes marquées actives. On filtre ensuite sur la période en mémoire
    // pour gérer proprement les dates nulles (début/fin optionnelles).
    let { data: campaignsAll, error: err1 } = await db
      .from('marketing_campaigns')
      .select('*')
      .eq('est_actif', true)
      .order('created_at', { ascending: false });

    if (err1) throw err1;

    // Une campagne est « en cours » si :
    //  - pas encore commencée ? non (date_debut future)
    //  - déjà terminée ? non (date_fin passée)
    // Les dates vides sont considérées comme sans limite (toujours en cours).
    const nowMs = Date.now();
    const isOngoing = (c) => {
      const debut = c.date_debut ? new Date(c.date_debut).getTime() : null;
      const fin = c.date_fin ? new Date(c.date_fin).getTime() : null;
      if (debut && debut > nowMs) return false;
      if (fin && fin < nowMs) return false;
      return true;
    };

    let campaigns = (campaignsAll || []).filter(isOngoing);

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
