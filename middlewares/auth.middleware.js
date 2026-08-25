const { getDb } = require('../config/db');
const { hashSessionToken } = require('../utils/token');

async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'En-tête Authorization manquant ou invalide' });
    }

    const token = authHeader.replace('Bearer ', '').trim();
    const tokenHash = hashSessionToken(token);
    const db = getDb();

    const { data: session, error } = await db
      .from('sessions')
      .select('id, utilisateur_id, expire_at, revoque')
      .eq('token_hash', tokenHash)
      .maybeSingle();

    if (error || !session) {
      return res.status(401).json({ message: 'Jeton de session invalide' });
    }

    if (session.revoque) {
      return res.status(401).json({ message: 'Session révoquée' });
    }

    if (new Date(session.expire_at) <= new Date()) {
      return res.status(401).json({ message: 'Session expirée' });
    }

    const { data: user, error: userError } = await db
      .from('utilisateurs')
      .select('id, telephone, role_id')
      .eq('id', session.utilisateur_id)
      .single();
    if (userError || !user) {
      return res.status(401).json({ message: 'Aucun utilisateur associé à cette session' });
    }

    const { data: role } = await db.from('roles').select('nom').eq('id', user.role_id).maybeSingle();
    const roleNom = role ? role.nom : null;

    // ── Marchands : bloquer si rejetés ou en attente d'approbation ──
    if (roleNom === 'restaurateur' || roleNom === 'commercant') {
      const { data: fullUser } = await db
        .from('utilisateurs')
        .select('est_approuve, raison_rejet')
        .eq('id', session.utilisateur_id)
        .maybeSingle();
      if (fullUser?.raison_rejet) {
        return res.status(403).json({ message: 'Votre compte a été refusé.', raison_rejet: fullUser.raison_rejet });
      }
      if (fullUser && !fullUser.est_approuve) {
        return res.status(403).json({ message: 'Votre compte est en cours de vérification.' });
      }
    }

    req.auth = {
      sessionId: session.id,
      userId: session.utilisateur_id,
      telephone: user.telephone,
      role: roleNom,
    };

    return next();
  } catch (err) {
    return next(err);
  }
}

/** Remplit `req.auth` si un Bearer valide est présent ; sinon `req.auth = null` (ne renvoie jamais 401). */
async function optionalAuthMiddleware(req, res, next) {
  req.auth = null;
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next();
    }

    const token = authHeader.replace('Bearer ', '').trim();
    const tokenHash = hashSessionToken(token);
    const db = getDb();

    const { data: session, error } = await db
      .from('sessions')
      .select('id, utilisateur_id, expire_at, revoque')
      .eq('token_hash', tokenHash)
      .maybeSingle();

    if (error || !session || session.revoque || new Date(session.expire_at) <= new Date()) {
      return next();
    }

    const { data: user, error: userError } = await db
      .from('utilisateurs')
      .select('id, telephone, role_id')
      .eq('id', session.utilisateur_id)
      .single();
    if (userError || !user) {
      return next();
    }

    const { data: role } = await db.from('roles').select('nom').eq('id', user.role_id).maybeSingle();

    req.auth = {
      sessionId: session.id,
      userId: session.utilisateur_id,
      telephone: user.telephone,
      role: role ? role.nom : null,
    };
  } catch {
    req.auth = null;
  }
  return next();
}

module.exports = { authMiddleware, optionalAuthMiddleware };
