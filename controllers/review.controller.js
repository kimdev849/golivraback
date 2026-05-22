const { getDb } = require('../config/db');
const { createHttpError, requireFields } = require('../utils/http');

function parseNote(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 5) return null;
  return n;
}

/** Sous-commandes livrées du client, pas encore notées. */
async function listPendingReviews(req, res, next) {
  try {
    const db = getDb();
    const clientId = req.auth.userId;

    const { data: commandes, error: cErr } = await db
      .from('commandes')
      .select('id')
      .eq('client_id', clientId);
    if (cErr) throw cErr;
    const commandeIds = (commandes || []).map((c) => c.id);
    if (commandeIds.length === 0) return res.json([]);

    const { data: scs, error: scErr } = await db
      .from('sous_commandes')
      .select('id, commande_id, restaurant_id, boutique_id, statut')
      .in('commande_id', commandeIds)
      .eq('statut', 'livree');
    if (scErr) throw scErr;

    const livrees = scs || [];
    if (livrees.length === 0) return res.json([]);

    const scIds = livrees.map((s) => s.id);

    const [{ data: avisR }, { data: avisB }] = await Promise.all([
      db.from('avis_restaurants').select('sous_commande_id').eq('client_id', clientId).in('sous_commande_id', scIds),
      db.from('avis_boutiques').select('sous_commande_id').eq('client_id', clientId).in('sous_commande_id', scIds),
    ]);

    const rated = new Set([
      ...(avisR || []).map((a) => a.sous_commande_id),
      ...(avisB || []).map((a) => a.sous_commande_id),
    ]);

    const pending = livrees.filter((s) => !rated.has(s.id));
    if (pending.length === 0) return res.json([]);

    const restoIds = [...new Set(pending.map((s) => s.restaurant_id).filter(Boolean))];
    const boutIds = [...new Set(pending.map((s) => s.boutique_id).filter(Boolean))];

    const [{ data: restos }, { data: bouts }] = await Promise.all([
      restoIds.length
        ? db.from('restaurants').select('id, nom').in('id', restoIds)
        : Promise.resolve({ data: [] }),
      boutIds.length
        ? db.from('boutiques').select('id, nom').in('id', boutIds)
        : Promise.resolve({ data: [] }),
    ]);

    const nomById = new Map([
      ...(restos || []).map((r) => [r.id, r.nom]),
      ...(bouts || []).map((b) => [b.id, b.nom]),
    ]);

    const out = pending.map((s) => {
      const enterpriseId = s.restaurant_id || s.boutique_id;
      const type = s.restaurant_id ? 'restaurant' : 'boutique';
      return {
        sous_commande_id: s.id,
        commande_id: s.commande_id,
        enterprise_id: enterpriseId,
        enterprise_type: type,
        enterprise_nom: nomById.get(enterpriseId) ?? null,
      };
    });

    return res.json(out);
  } catch (error) {
    return next(error);
  }
}

/** Note 1–5 sans commentaire (commentaire optionnel plus tard). */
async function submitReview(req, res, next) {
  try {
    requireFields(req.body, ['sousCommandeId', 'note']);
    const { sousCommandeId, note: noteRaw, commentaire: commentaireRaw } = req.body;
    const note = parseNote(noteRaw);
    if (note == null) {
      throw createHttpError(400, 'La note doit être un entier entre 1 et 5.');
    }
    const commentaire =
      commentaireRaw != null && String(commentaireRaw).trim()
        ? String(commentaireRaw).trim().slice(0, 500)
        : null;

    const db = getDb();
    const clientId = req.auth.userId;

    const { data: sc, error: scErr } = await db
      .from('sous_commandes')
      .select('id, commande_id, restaurant_id, boutique_id, statut')
      .eq('id', sousCommandeId)
      .maybeSingle();
    if (scErr) throw scErr;
    if (!sc) throw createHttpError(404, 'Sous-commande introuvable.');

    const { data: commande, error: cErr } = await db
      .from('commandes')
      .select('client_id')
      .eq('id', sc.commande_id)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!commande || commande.client_id !== clientId) {
      throw createHttpError(403, 'Action non autorisée.');
    }

    if (sc.statut !== 'livree') {
      throw createHttpError(400, 'Vous pouvez noter uniquement une commande livrée.');
    }

    const row = {
      client_id: clientId,
      sous_commande_id: sc.id,
      note,
      commentaire,
    };

    if (sc.restaurant_id) {
      const { data: existing } = await db
        .from('avis_restaurants')
        .select('id')
        .eq('client_id', clientId)
        .eq('sous_commande_id', sc.id)
        .maybeSingle();
      if (existing) throw createHttpError(409, 'Vous avez déjà noté ce commerce pour cette commande.');

      const { data, error } = await db
        .from('avis_restaurants')
        .insert({ ...row, restaurant_id: sc.restaurant_id })
        .select('id, note, created_at')
        .single();
      if (error) throw error;

      const { data: resto } = await db
        .from('restaurants')
        .select('note_moyenne, nb_avis')
        .eq('id', sc.restaurant_id)
        .maybeSingle();

      return res.status(201).json({
        id: data.id,
        note: data.note,
        enterprise_id: sc.restaurant_id,
        enterprise_type: 'restaurant',
        note_moyenne: resto?.note_moyenne != null ? Number(resto.note_moyenne) : 0,
        nb_avis: resto?.nb_avis ?? 0,
      });
    }

    if (sc.boutique_id) {
      const { data: existing } = await db
        .from('avis_boutiques')
        .select('id')
        .eq('client_id', clientId)
        .eq('sous_commande_id', sc.id)
        .maybeSingle();
      if (existing) throw createHttpError(409, 'Vous avez déjà noté ce commerce pour cette commande.');

      const { data, error } = await db
        .from('avis_boutiques')
        .insert({ ...row, boutique_id: sc.boutique_id })
        .select('id, note, created_at')
        .single();
      if (error) throw error;

      const { data: bout } = await db
        .from('boutiques')
        .select('note_moyenne, nb_avis')
        .eq('id', sc.boutique_id)
        .maybeSingle();

      return res.status(201).json({
        id: data.id,
        note: data.note,
        enterprise_id: sc.boutique_id,
        enterprise_type: 'boutique',
        note_moyenne: bout?.note_moyenne != null ? Number(bout.note_moyenne) : 0,
        nb_avis: bout?.nb_avis ?? 0,
      });
    }

    throw createHttpError(400, 'Commerce introuvable pour cette sous-commande.');
  } catch (error) {
    return next(error);
  }
}

module.exports = { listPendingReviews, submitReview };
