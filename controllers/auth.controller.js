const { getDb } = require('../config/db');
const bcrypt = require('bcryptjs');
const { createHttpError, requireFields } = require('../utils/http');
const { generateToken, hashSessionToken } = require('../utils/token');
const { normalizeCgE164 } = require('../utils/phone');
const { findPendingOtp, deleteOtpById } = require('../services/otp.store');

const PUBLIC_REGISTER_ROLES = new Set(['client', 'restaurateur', 'commercant']);
const STAFF_LOGIN_ROLES = new Set(['admin', 'gestionnaire_logistique']);

async function findValidOtpRow(db, telephone, code) {
  const { data: otpRow, error } = await findPendingOtp(db, telephone, code);

  if (error) {
    throw createHttpError(500, `Erreur OTP lors de l'inscription: ${error.message}`);
  }
  if (!otpRow) throw createHttpError(400, 'Code de vérification introuvable ou incorrect');
  if (new Date(otpRow.expire_at) <= new Date()) throw createHttpError(400, 'Le code de vérification a expiré');
  if (String(otpRow.code) !== String(code)) throw createHttpError(400, 'Code de vérification incorrect');

  return otpRow;
}

async function deleteOtpRow(db, otpId) {
  const { error: deleteError } = await deleteOtpById(db, otpId);
  if (deleteError) throw deleteError;
}

async function insertSession(db, utilisateurId, token, req) {
  const expireDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const { error: sessionError } = await db.from('sessions').insert({
    utilisateur_id: utilisateurId,
    token_hash: hashSessionToken(token),
    expire_at: expireDate.toISOString(),
    user_agent: req.get('user-agent') || null,
    ip_address: req.ip || null,
    revoque: false,
  });
  return { sessionError, expireDate };
}

function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!email || !email.includes('@') || email.length > 255) return null;
  return email;
}

async function verifyPasswordAndMaybeUpgrade(db, user, motDePasse) {
  const hash = user.mot_de_passe_hash;
  const isBcryptHash = typeof hash === 'string' && (hash.startsWith('$2a$') || hash.startsWith('$2b$'));
  const passwordValid = isBcryptHash ? await bcrypt.compare(motDePasse, hash) : hash === motDePasse;
  if (!passwordValid) return false;

  if (!isBcryptHash) {
    const upgradedHash = await bcrypt.hash(motDePasse, 10);
    await db.from('utilisateurs').update({ mot_de_passe_hash: upgradedHash }).eq('id', user.id);
  }
  return true;
}

function userImageUrl(user) {
  return user?.avatar_url && String(user.avatar_url).trim().startsWith('http')
    ? String(user.avatar_url).trim()
    : null;
}

async function buildSessionResponse(db, user, req) {
  const token = generateToken();
  const { sessionError, expireDate } = await insertSession(db, user.id, token, req);
  if (sessionError) throw sessionError;

  await db.from('utilisateurs').update({ derniere_connexion: new Date().toISOString() }).eq('id', user.id);

  const { data: roleNomRow } = await db.from('roles').select('nom').eq('id', user.role_id).maybeSingle();

  return {
    token,
    expireLe: expireDate.toISOString(),
    user: {
      id: user.id,
      nom: user.nom,
      telephone: user.telephone ?? null,
      email: user.email ?? null,
      imageUrl: userImageUrl(user),
      roleId: user.role_id,
      role: roleNomRow?.nom ?? null,
      est_approuve: user.est_approuve,
    },
  };
}

async function register(req, res, next) {
  try {
    const rawRole = req.body.role;
    const role = typeof rawRole === 'string' && rawRole.trim() ? rawRole.trim() : 'client';
    const { nom, telephone: telephoneRaw, motDePasse, otpCode, imageUrl } = req.body;
    requireFields(req.body, ['nom', 'telephone', 'motDePasse', 'otpCode']);
    const avatarUrl =
      typeof imageUrl === 'string' && imageUrl.trim().startsWith('http') ? imageUrl.trim() : null;

    const telephone = normalizeCgE164(telephoneRaw);
    if (!telephone) {
      throw createHttpError(400, 'Numéro de téléphone invalide. Indiquez +242 suivi de 9 chiffres (Congo).');
    }

    const db = getDb();
    if (!PUBLIC_REGISTER_ROLES.has(role)) {
      throw createHttpError(403, 'Inscription réservée aux rôles client, restaurateur ou commerçant.');
    }

    const otpRow = await findValidOtpRow(db, telephone, otpCode);

    const { data: roleRow, error: roleError } = await db
      .from('roles')
      .select('id')
      .eq('nom', role)
      .limit(1)
      .maybeSingle();
    if (roleError || !roleRow) throw createHttpError(400, 'Profil demandé non reconnu.');
    const hashedPassword = await bcrypt.hash(motDePasse, 10);

    const { data, error } = await db
      .from('utilisateurs')
      .insert({
        nom,
        telephone,
        mot_de_passe_hash: hashedPassword,
        role_id: roleRow.id,
        est_verifie: true,
        est_approuve: role === 'client',
        avatar_url: avatarUrl,
      })
      .select('id, nom, telephone, email, role_id, est_approuve, avatar_url, created_at')
      .single();

    if (error) {
      if (error.code === '23505') throw createHttpError(409, 'Ce numéro de téléphone est déjà enregistré');
      throw error;
    }

    const token = generateToken();
    const { sessionError, expireDate } = await insertSession(db, data.id, token, req);
    if (sessionError) {
      await db.from('utilisateurs').delete().eq('id', data.id);
      throw sessionError;
    }

    await deleteOtpRow(db, otpRow.id);

    const { data: roleNomRow } = await db.from('roles').select('nom').eq('id', data.role_id).maybeSingle();

    return res.status(201).json({
      token,
      expireLe: expireDate.toISOString(),
      user: {
        id: data.id,
        nom: data.nom,
        telephone: data.telephone,
        imageUrl: userImageUrl(data),
        roleId: data.role_id,
        role: roleNomRow?.nom ?? null,
        est_approuve: data.est_approuve,
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function login(req, res, next) {
  try {
    const { telephone: telephoneRaw, email: emailRaw, motDePasse } = req.body;
    requireFields(req.body, ['motDePasse']);

    const emailFromPhone =
      typeof telephoneRaw === 'string' && telephoneRaw.includes('@') ? normalizeEmail(telephoneRaw) : null;
    const email = normalizeEmail(emailRaw) || emailFromPhone;

    if (email) {
      req.body.email = email;
      return staffLogin(req, res, next);
    }

    requireFields(req.body, ['telephone']);

    const telephone = normalizeCgE164(telephoneRaw);
    if (!telephone) {
      throw createHttpError(400, 'Numéro de téléphone invalide. Indiquez +242 suivi de 9 chiffres (Congo).');
    }

    const db = getDb();

    const { data: user, error } = await db
      .from('utilisateurs')
      .select('id, nom, telephone, email, mot_de_passe_hash, role_id, est_approuve, est_actif, avatar_url')
      .eq('telephone', telephone)
      .single();

    if (error || !user) {
      throw createHttpError(401, 'Téléphone ou mot de passe incorrect');
    }

    if (user.est_actif === false) {
      throw createHttpError(403, 'Ce compte est désactivé.');
    }

    const ok = await verifyPasswordAndMaybeUpgrade(db, user, motDePasse);
    if (!ok) {
      throw createHttpError(401, 'Téléphone ou mot de passe incorrect');
    }

    return res.json(await buildSessionResponse(db, user, req));
  } catch (error) {
    return next(error);
  }
}

/** Connexion back-office web : email + mot de passe (comptes admin). */
async function staffLogin(req, res, next) {
  try {
    const { email: emailRaw, motDePasse } = req.body;
    requireFields(req.body, ['email', 'motDePasse']);

    const email = normalizeEmail(emailRaw);
    if (!email) {
      throw createHttpError(400, 'Adresse e-mail invalide.');
    }

    if (typeof motDePasse !== 'string' || motDePasse.length < 6) {
      throw createHttpError(400, 'Mot de passe requis (6 caractères minimum).');
    }

    const db = getDb();

    const { data: user, error } = await db
      .from('utilisateurs')
      .select('id, nom, telephone, email, mot_de_passe_hash, role_id, est_approuve, est_actif, avatar_url')
      .eq('email', email)
      .maybeSingle();

    if (error) throw error;
    if (!user) {
      throw createHttpError(401, 'E-mail ou mot de passe incorrect');
    }

    const { data: roleRow } = await db.from('roles').select('nom').eq('id', user.role_id).maybeSingle();
    const roleNom = roleRow?.nom ?? null;

    if (!STAFF_LOGIN_ROLES.has(roleNom)) {
      throw createHttpError(403, 'Accès réservé au personnel GoLivra (admin ou gestionnaire logistique).');
    }

    if (user.est_actif === false) {
      throw createHttpError(403, 'Ce compte administrateur est désactivé.');
    }

    const ok = await verifyPasswordAndMaybeUpgrade(db, user, motDePasse);
    if (!ok) {
      throw createHttpError(401, 'E-mail ou mot de passe incorrect');
    }

    return res.json(await buildSessionResponse(db, user, req));
  } catch (error) {
    return next(error);
  }
}

async function me(req, res, next) {
  try {
    const db = getDb();
    const { data: user, error } = await db
      .from('utilisateurs')
      .select('id, nom, telephone, email, role_id, est_approuve, avatar_url, created_at')
      .eq('id', req.auth.userId)
      .single();

    if (error || !user) throw createHttpError(404, 'Utilisateur introuvable');

    const { data: roleRow } = await db.from('roles').select('nom').eq('id', user.role_id).maybeSingle();
    const roleNom = roleRow?.nom ?? null;

    return res.json({
      id: user.id,
      nom: user.nom,
      telephone: user.telephone,
      email: user.email,
      role_id: user.role_id,
      roleId: user.role_id,
      role: roleNom,
      est_approuve: user.est_approuve,
      created_at: user.created_at,
      imageUrl: userImageUrl(user),
      image_url: userImageUrl(user),
    });
  } catch (error) {
    return next(error);
  }
}

async function logout(req, res, next) {
  try {
    const db = getDb();
    await db.from('sessions').delete().eq('id', req.auth.sessionId);
    return res.json({ message: 'Déconnexion réussie' });
  } catch (error) {
    return next(error);
  }
}

async function updateProfile(req, res, next) {
  try {
    const { nom, telephone, imageUrl } = req.body;
    const hasNom = nom !== undefined;
    const hasTel = telephone !== undefined;
    const hasImage = imageUrl !== undefined;
    if (!hasNom && !hasTel && !hasImage) {
      throw createHttpError(400, 'Indiquez au moins le nom, le numéro ou la photo à modifier.');
    }

    const db = getDb();
    const updates = {};

    if (hasNom) {
      const n = typeof nom === 'string' ? nom.trim() : '';
      if (!n) throw createHttpError(400, 'Le nom ne peut pas être vide.');
      if (n.length > 100) throw createHttpError(400, 'Nom trop long.');
      updates.nom = n;
    }

    if (hasTel) {
      const normalized = normalizeCgE164(telephone);
      if (!normalized) {
        throw createHttpError(400, 'Numéro de téléphone invalide. Indiquez +242 suivi de 9 chiffres (Congo).');
      }
      const { data: other } = await db
        .from('utilisateurs')
        .select('id')
        .eq('telephone', normalized)
        .neq('id', req.auth.userId)
        .maybeSingle();
      if (other) throw createHttpError(409, 'Ce numéro de téléphone est déjà utilisé.');
      updates.telephone = normalized;
    }

    if (hasImage) {
      updates.avatar_url =
        typeof imageUrl === 'string' && imageUrl.trim().startsWith('http') ? imageUrl.trim() : null;
    }

    const { data: user, error } = await db
      .from('utilisateurs')
      .update(updates)
      .eq('id', req.auth.userId)
      .select('id, nom, telephone, email, role_id, est_approuve, avatar_url, created_at')
      .single();

    if (error || !user) throw createHttpError(500, 'Impossible de mettre à jour le profil.');

    const { data: roleRow } = await db.from('roles').select('nom').eq('id', user.role_id).maybeSingle();

    return res.json({
      id: user.id,
      nom: user.nom,
      telephone: user.telephone,
      email: user.email,
      role_id: user.role_id,
      roleId: user.role_id,
      role: roleRow?.nom ?? null,
      est_approuve: user.est_approuve,
      created_at: user.created_at,
      imageUrl: userImageUrl(user),
      image_url: userImageUrl(user),
    });
  } catch (error) {
    return next(error);
  }
}

async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body;
    requireFields(req.body, ['currentPassword', 'newPassword']);

    if (typeof newPassword !== 'string' || newPassword.length < 6) {
      throw createHttpError(400, 'Le nouveau mot de passe doit contenir au moins 6 caractères.');
    }

    const db = getDb();
    const { data: user, error } = await db
      .from('utilisateurs')
      .select('id, mot_de_passe_hash')
      .eq('id', req.auth.userId)
      .single();

    if (error || !user) throw createHttpError(404, 'Utilisateur introuvable');

    const hash = user.mot_de_passe_hash;
    const isBcryptHash = typeof hash === 'string' && (hash.startsWith('$2a$') || hash.startsWith('$2b$'));
    const passwordValid = isBcryptHash ? await bcrypt.compare(currentPassword, hash) : hash === currentPassword;

    if (!passwordValid) {
      throw createHttpError(401, 'Mot de passe actuel incorrect.');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    const { error: upErr } = await db
      .from('utilisateurs')
      .update({ mot_de_passe_hash: hashedPassword })
      .eq('id', user.id);

    if (upErr) throw upErr;
    return res.json({ message: 'Mot de passe mis à jour.' });
  } catch (error) {
    return next(error);
  }
}

module.exports = { register, login, staffLogin, me, logout, updateProfile, changePassword };
