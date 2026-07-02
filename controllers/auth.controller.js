const { getDb } = require('../config/db');
const bcrypt = require('bcryptjs');
const { createHttpError, requireFields } = require('../utils/http');
const { generateToken, hashSessionToken } = require('../utils/token');
const { normalizeCgE164 } = require('../utils/phone');
const { findPendingOtp, deleteOtpById } = require('../services/otp.store');
const { getPreferences, updatePreferences } = require('../services/preferences.service');
const { getPublicSettings } = require('../services/settings.service');

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

async function assertSignupsAllowed(db) {
  try {
    const pub = await getPublicSettings(db);
    if (pub.golivra_maintenance_mode === true) {
      throw createHttpError(503, 'GoLivra est en maintenance. Réessayez plus tard.');
    }
    if (pub.golivra_signups_open === false) {
      throw createHttpError(403, 'Les inscriptions sont temporairement fermées.');
    }
  } catch (e) {
    if (e.status || e.statusCode) throw e;
  }
}

async function resetPassword(req, res, next) {
  try {
    const { telephone: telephoneRaw, otpCode: otpRaw, newPassword } = req.body;
    requireFields(req.body, ['telephone', 'otpCode', 'newPassword']);

    const validators = require('../lib/validators');
    const telephoneClean = validators.requireValid(telephoneRaw, validators.validatePhoneCg, 'telephone');
    const otpClean = validators.requireValid(otpRaw, validators.validateOtp, 'otpCode');
    validators.requireValid(newPassword, validators.validatePassword, 'newPassword');

    const telephone = normalizeCgE164(telephoneClean);
    if (!telephone) {
      throw createHttpError(400, 'Numéro de téléphone invalide. Indiquez +242 suivi de 9 chiffres (Congo).');
    }

    const db = getDb();
    const otpRow = await findValidOtpRow(db, telephone, otpClean);

    const { data: user, error: userErr } = await db
      .from('utilisateurs')
      .select('id, nom, telephone, email, role_id, est_approuve, est_actif, est_supprime, avatar_url')
      .eq('telephone', telephone)
      .maybeSingle();

    if (userErr) throw userErr;
    if (!user) {
      throw createHttpError(404, 'Aucun compte associé à ce numéro.');
    }
    if (user.est_supprime === true) {
      throw createHttpError(410, 'Ce compte a été supprimé.');
    }
    if (user.est_actif === false) {
      throw createHttpError(403, 'Ce compte est désactivé.');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    const { error: upErr } = await db
      .from('utilisateurs')
      .update({ mot_de_passe_hash: hashedPassword })
      .eq('id', user.id);
    if (upErr) throw upErr;

    await deleteOtpRow(db, otpRow.id);

    return res.json({
      message: 'Mot de passe réinitialisé. Vous pouvez vous connecter.',
      ...(process.env.NODE_ENV !== 'production'
        ? { devNote: 'En production, connectez-vous avec le nouveau mot de passe.' }
        : {}),
    });
  } catch (error) {
    return next(error);
  }
}

async function getMyPreferences(req, res, next) {
  try {
    const db = getDb();
    const preferences = await getPreferences(db, req.auth.userId);
    return res.json({ preferences });
  } catch (error) {
    return next(error);
  }
}

async function patchMyPreferences(req, res, next) {
  try {
    const db = getDb();
    const allowed = {};
    if (req.body.notif_push_enabled !== undefined) {
      allowed.notif_push_enabled = Boolean(req.body.notif_push_enabled);
    }
    if (req.body.notif_email_enabled !== undefined) {
      allowed.notif_email_enabled = Boolean(req.body.notif_email_enabled);
    }
    if (req.body.dark_mode !== undefined) {
      allowed.dark_mode = Boolean(req.body.dark_mode);
    }
    if (req.body.langue !== undefined && typeof req.body.langue === 'string') {
      allowed.langue = req.body.langue.trim().slice(0, 10) || 'fr';
    }
    if (Object.keys(allowed).length === 0) {
      throw createHttpError(400, 'Aucune préférence à mettre à jour.');
    }
    const preferences = await updatePreferences(db, req.auth.userId, allowed);
    return res.json({ preferences });
  } catch (error) {
    return next(error);
  }
}

async function register(req, res, next) {
  const db = getDb();
  let createdUserId = null;
  let otpRowId = null;

  try {
    const rawRole = req.body.role;
    const role = typeof rawRole === 'string' && rawRole.trim() ? rawRole.trim() : 'client';
    const { telephone: telephoneRaw, motDePasse, otpCode, imageUrl, pays_id: paysId, ville_id: villeId } = req.body;
    requireFields(req.body, ['telephone', 'motDePasse', 'otpCode']);
    const avatarUrl =
      typeof imageUrl === 'string' && imageUrl.trim().startsWith('http') ? imageUrl.trim() : null;

    const validators = require('../lib/validators');
    const nomClean = validators.requireValid(req.body.nom, validators.validatePersonName, 'nom');
    const telephoneClean = validators.requireValid(telephoneRaw, validators.validatePhoneCg, 'telephone');
    validators.requireValid(motDePasse, validators.validatePassword, 'motDePasse');
    const otpClean = validators.requireValid(otpCode, validators.validateOtp, 'otpCode');

    const telephone = normalizeCgE164(telephoneClean);
    if (!telephone) {
      throw createHttpError(400, 'Numéro de téléphone invalide. Indiquez +242 suivi de 9 chiffres (Congo).');
    }

    // Validation pays_id / ville_id (optionnels pour backward compat)
    let resolvedPaysId = null;
    let resolvedVilleId = null;
    if (paysId) {
      const { data: paysRow } = await db.from('pays').select('id').eq('id', paysId).maybeSingle();
      if (!paysRow) throw createHttpError(400, 'Pays invalide.');
      resolvedPaysId = paysId;
    }
    if (villeId) {
      const { data: villeRow } = await db.from('villes').select('id').eq('id', villeId).maybeSingle();
      if (!villeRow) throw createHttpError(400, 'Ville invalide.');
      resolvedVilleId = villeId;
    }

    // ── Garde-fous AVANT toute écriture ───────────────────────────────
    await assertSignupsAllowed(db);
    if (!PUBLIC_REGISTER_ROLES.has(role)) {
      throw createHttpError(403, 'Inscription réservée aux rôles client, restaurateur ou commerçant.');
    }

    const otpRow = await findValidOtpRow(db, telephone, otpClean);
    otpRowId = otpRow.id;

    const { data: roleRow, error: roleError } = await db
      .from('roles')
      .select('id')
      .eq('nom', role)
      .limit(1)
      .maybeSingle();
    if (roleError || !roleRow) throw createHttpError(400, 'Profil demandé non reconnu.');
    const hashedPassword = await bcrypt.hash(motDePasse, 10);

    // ── INSERT utilisateur (point de non-retour) ──────────────────────
    const { data, error } = await db
      .from('utilisateurs')
      .insert({
        nom: nomClean,
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
    createdUserId = data.id;

    // ── Tout ce qui suit est dans un sous-try : si quoi que ce soit
    //    échoue, on ROLLBACK l'utilisateur (et on remet l'OTP pending)
    //    AVANT de propager l'erreur. → atomicité stricte. ─────────────
    let token;
    let expireDate;
    try {
      const sessionToken = generateToken();
      const sessionResult = await insertSession(db, data.id, sessionToken, req);
      if (sessionResult.sessionError) throw sessionResult.sessionError;
      token = sessionToken;
      expireDate = sessionResult.expireDate;

      await deleteOtpRow(db, otpRow.id);

      const { data: roleNomRow } = await db.from('roles').select('nom').eq('id', data.role_id).maybeSingle();
      const roleNom = roleNomRow?.nom ?? role;

      if (!data.est_approuve && (roleNom === 'restaurateur' || roleNom === 'commercant')) {
        const { notifyAllAdmins } = require('../services/admin-notify.service');
        await notifyAllAdmins(db, {
          type: 'compte_marchand_en_attente',
          titre: 'Nouveau compte marchand',
          corps: `« ${nomClean} » (${roleNom}) attend la validation de son compte.`,
          data: { utilisateur_id: data.id, role: roleNom, action: 'review_accounts' },
        }).catch(() => undefined);
      }

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
    } catch (postInsertError) {
      // ROLLBACK : suppression utilisateur + restauration OTP (best-effort).
      // On log sévèrement si le rollback lui-même échoue.
      if (createdUserId) {
        await db.from('utilisateurs').delete().eq('id', createdUserId).catch((delErr) => {
          console.error('[register] ROLLBACK utilisateur impossible:', createdUserId, delErr.message);
        });
      }
      if (otpRowId) {
        await db.from('otp_verifications').update({ utilise_at: null }).eq('id', otpRowId).catch(() => undefined);
      }
      throw postInsertError;
    }
  } catch (error) {
    return next(error);
  }
}

/**
 * Inscription ATOMIQUE d'un vendeur (restaurateur / commerçant) :
 * crée l'utilisateur ET le commerce (restaurants OU boutiques) en une
 * seule requête HTTP. Si l'une des deux insertions échoue, on ROLLBACK
 * l'autre (suppression) avant de renvoyer l'erreur.
 *
 * Garantit qu'on ne se retrouve JAMAIS avec un utilisateur orphelin
 * sans son commerce (ou inversement) en base.
 */
async function registerVendor(req, res, next) {
  const db = getDb();
  let createdUserId = null;
  let createdEnterpriseId = null;
  let otpRowId = null;

  try {
    const {
      nom, telephone: telephoneRaw, motDePasse, otpCode, imageUrl, role,
    } = req.body;
    const enterprise = req.body.enterprise || {};

    requireFields(req.body, ['nom', 'telephone', 'motDePasse', 'otpCode', 'role']);
    requireFields(enterprise, ['type', 'nom', 'telephone', 'categorieId']);

    const validators = require('../lib/validators');
    const PUBLIC_VENDOR_ROLES = new Set(['restaurateur', 'commercant']);
    if (!PUBLIC_VENDOR_ROLES.has(role)) {
      throw createHttpError(400, 'Rôle vendeur invalide (restaurateur ou commercant).');
    }
    if (!['restaurant', 'boutique'].includes(enterprise.type)) {
      throw createHttpError(400, 'Type de commerce invalide (restaurant ou boutique).');
    }
    // Cohérence role / type commerce
    const expectedRole = enterprise.type === 'restaurant' ? 'restaurateur' : 'commercant';
    if (role !== expectedRole) {
      throw createHttpError(400, `Rôle ${role} incompatible avec un commerce de type ${enterprise.type}.`);
    }

    // Validation utilisateur
    const nomClean = validators.requireValid(nom, validators.validatePersonName, 'nom');
    const telephoneClean = validators.requireValid(telephoneRaw, validators.validatePhoneCg, 'telephone');
    validators.requireValid(motDePasse, validators.validatePassword, 'motDePasse');
    const otpClean = validators.requireValid(otpCode, validators.validateOtp, 'otpCode');
    const telephone = normalizeCgE164(telephoneClean);
    if (!telephone) {
      throw createHttpError(400, 'Numéro de téléphone invalide. Indiquez +242 suivi de 9 chiffres (Congo).');
    }
    const avatarUrl =
      typeof imageUrl === 'string' && imageUrl.trim().startsWith('http') ? imageUrl.trim() : null;

    // Validation pays / ville (optionnels pour backward compat)
    let resolvedPaysId = null;
    let resolvedVilleId = null;
    const { pays_id, ville_id } = req.body;
    if (pays_id) {
      const { data: paysRow } = await db.from('pays').select('id').eq('id', pays_id).maybeSingle();
      if (!paysRow) throw createHttpError(400, 'Pays invalide.');
      resolvedPaysId = pays_id;
    }
    if (ville_id) {
      const { data: villeRow } = await db.from('villes').select('id').eq('id', ville_id).maybeSingle();
      if (!villeRow) throw createHttpError(400, 'Ville invalide.');
      resolvedVilleId = ville_id;
    }

    // Validation commerce
    const entNomClean = validators.requireValid(enterprise.nom, validators.validateCommerceName, 'enterprise.nom');
    const entTelClean = validators.requireValid(enterprise.telephone, validators.validatePhoneCg, 'enterprise.telephone');
    let entAdresseClean = '';
    if (enterprise.type === 'restaurant') {
      entAdresseClean = validators.requireValid(
        enterprise.adresse,
        (v) => validators.validateAddress(v, true),
        'enterprise.adresse',
      );
    } else {
      entAdresseClean = validators.sanitizeText(enterprise.adresse || '');
    }
    const entDescriptionClean = enterprise.description
      ? validators.requireValid(
          enterprise.description,
          (v) => validators.validateDescription(v, 500),
          'enterprise.description',
        )
      : null;
    if (!enterprise.categorieId || typeof enterprise.categorieId !== 'string') {
      throw createHttpError(400, 'Catégorie du commerce requise.');
    }

    // Garde-fous globaux
    await assertSignupsAllowed(db);
    const otpRow = await findValidOtpRow(db, telephone, otpClean);
    otpRowId = otpRow.id;

    const { data: roleRow, error: roleError } = await db
      .from('roles').select('id').eq('nom', role).limit(1).maybeSingle();
    if (roleError || !roleRow) throw createHttpError(400, 'Profil demandé non reconnu.');

    // 1) Insertion utilisateur
    const hashedPassword = await bcrypt.hash(motDePasse, 10);
    const { data: userRow, error: userError } = await db
      .from('utilisateurs')
      .insert({
        nom: nomClean,
        telephone,
        mot_de_passe_hash: hashedPassword,
        role_id: roleRow.id,
        est_verifie: true,
        est_approuve: false, // les marchands sont toujours en attente de modération
        avatar_url: avatarUrl,
      })
      .select('id, nom, telephone, email, role_id, est_approuve, avatar_url, created_at')
      .single();

    if (userError) {
      if (userError.code === '23505') throw createHttpError(409, 'Ce numéro de téléphone est déjà enregistré');
      throw userError;
    }
    createdUserId = userRow.id;

    // 2) Insertion commerce (avec rollback utilisateur en cas d'échec)
    try {
      const {
        initialModerationStatus,
        MODERATION,
        resolveCategoryId,
        logoFieldsFromBody,
      } = require('./enterprise.controller');
      const statut = initialModerationStatus();

      const resolvedCategoryId = await resolveCategoryId(db, enterprise.type, enterprise.categorieId);
      const logoFields = logoFieldsFromBody(enterprise);

      const base = {
        proprietaire_id: userRow.id,
        categorie_id: resolvedCategoryId,
        nom: entNomClean,
        description: entDescriptionClean,
        telephone: entTelClean,
        adresse_ligne1: entAdresseClean,
        pays_id: resolvedPaysId,
        ville_id: resolvedVilleId,
        latitude: enterprise.latitude ?? null,
        longitude: enterprise.longitude ?? null,
        statut,
        est_ouvert: statut === MODERATION.ACTIVE,
        livraison_propre: false,
        ...logoFields,
      };

      const table = enterprise.type === 'restaurant' ? 'restaurants' : 'boutiques';
      const { data: entRow, error: entError } = await db
        .from(table)
        .insert(base)
        .select('*')
        .single();
      if (entError) throw entError;
      createdEnterpriseId = entRow.id;

      // 3) Session + token
      const token = generateToken();
      const { sessionError, expireDate } = await insertSession(db, userRow.id, token, req);
      if (sessionError) throw sessionError;

      // 4) Nettoyage OTP (succès complet)
      await deleteOtpRow(db, otpRow.id);

      // 5) Notifications admin (best-effort, hors chemin critique)
      try {
        const { notifyAllAdmins } = require('../services/admin-notify.service');
        await notifyAllAdmins(db, {
          type: 'compte_marchand_en_attente',
          titre: 'Nouveau compte marchand',
          corps: `« ${nomClean} » (${role}) attend la validation de son compte.`,
          data: { utilisateur_id: userRow.id, role, action: 'review_accounts' },
        });
        const { notifyEnterprisePendingModeration } = require('../services/admin-notify.service');
        await notifyEnterprisePendingModeration(db, {
          type: enterprise.type,
          nom: entNomClean,
          enterpriseId: entRow.id,
        });
      } catch (notifyError) {
        console.warn('[registerVendor] notification admin échouée (non-bloquant):', notifyError.message);
      }

      const { data: roleNomRow } = await db
        .from('roles').select('nom').eq('id', userRow.role_id).maybeSingle();
      const roleNom = roleNomRow?.nom ?? role;

      return res.status(201).json({
        token,
        expireLe: expireDate.toISOString(),
        user: {
          id: userRow.id,
          nom: userRow.nom,
          telephone: userRow.telephone,
          imageUrl: userImageUrl(userRow),
          roleId: userRow.role_id,
          role: roleNom,
          est_approuve: userRow.est_approuve,
        },
        enterprise: entRow,
      });
    } catch (innerError) {
      // ROLLBACK : on supprime l'utilisateur qu'on vient de créer pour
      // garantir l'atomicité côté mobile. Si même ça échoue, on log
      // sévèrement mais on continue à propager l'erreur d'origine.
      if (createdEnterpriseId) {
        await db.from('restaurants').delete().eq('id', createdEnterpriseId).catch(() => undefined);
        await db.from('boutiques').delete().eq('id', createdEnterpriseId).catch(() => undefined);
      }
      if (createdUserId) {
        await db.from('utilisateurs').delete().eq('id', createdUserId).catch((delErr) => {
          console.error('[registerVendor] ROLLBACK utilisateur impossible:', createdUserId, delErr.message);
        });
      }
      // Restaurer l'OTP pour permettre une nouvelle tentative
      if (otpRowId) {
        // L'OTP a peut-être été marqué utilisé, on tente de le remettre pending
        // (best-effort, silencieux en cas d'échec)
        await db.from('otp_verifications').update({ utilise_at: null }).eq('id', otpRowId).catch(() => undefined);
      }
      throw innerError;
    }
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
      .select('id, nom, telephone, email, mot_de_passe_hash, role_id, est_approuve, est_actif, est_supprime, avatar_url')
      .eq('telephone', telephone)
      .single();

    if (error || !user) {
      throw createHttpError(401, 'Téléphone ou mot de passe incorrect');
    }

    if (user.est_supprime === true) {
      throw createHttpError(410, 'Ce compte a été supprimé. Créez un nouveau compte pour utiliser GoLivra.');
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
      .select('id, nom, telephone, email, mot_de_passe_hash, role_id, est_approuve, est_actif, est_supprime, avatar_url')
      .eq('email', email)
      .maybeSingle();

    if (error) throw error;
    if (!user) {
      throw createHttpError(401, 'E-mail ou mot de passe incorrect');
    }

    if (user.est_supprime === true) {
      throw createHttpError(410, 'Ce compte a été supprimé.');
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

    let livreur = null;
    let entrepriseLogistique = null;
    if (roleNom === 'livreur') {
      const { data: liv } = await db
        .from('livreurs')
        .select(
          'id, type_vehicule, est_disponible, est_approuve, nb_livraisons_total, nb_livraisons_reussies, plaque_immatriculation, entreprise_logistique_id, created_at',
        )
        .eq('utilisateur_id', user.id)
        .maybeSingle();
      if (liv) {
        livreur = {
          id: liv.id,
          type_vehicule: liv.type_vehicule,
          est_disponible: liv.est_disponible,
          est_approuve: liv.est_approuve,
          nb_livraisons_total: liv.nb_livraisons_total,
          nb_livraisons_reussies: liv.nb_livraisons_reussies,
          plaque_immatriculation: liv.plaque_immatriculation,
          created_at: liv.created_at,
        };
        if (liv.entreprise_logistique_id) {
          const { data: ent } = await db
            .from('entreprises_logistiques')
            .select('id, nom, telephone')
            .eq('id', liv.entreprise_logistique_id)
            .maybeSingle();
          entrepriseLogistique = ent;
        }
      }
    }

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
      livreur,
      entreprise_logistique: entrepriseLogistique,
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
      const validators = require('../lib/validators');
      updates.nom = validators.requireValid(nom, validators.validatePersonName, 'nom');
    }

    if (hasTel) {
      const validators = require('../lib/validators');
      const telClean = validators.requireValid(telephone, validators.validatePhoneCg, 'telephone');
      const normalized = normalizeCgE164(telClean);
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

/**
 * Suppression du compte par l'utilisateur (RGPD-friendly).
 * - Vérifie le mot de passe pour confirmer l'intention.
 * - Soft delete : anonymise les PII (nom, email, téléphone, avatar), bloque la connexion.
 * - Révoque toutes les sessions actives.
 * - Supprime tous les push tokens (plus aucune notification).
 * - Les données historiques (commandes, factures…) sont conservées via FK pour l'audit légal.
 */
async function deleteAccount(req, res, next) {
  try {
    const { password, reason } = req.body || {};
    requireFields(req.body, ['password']);

    const db = getDb();
    const userId = req.auth.userId;

    const { data: user, error } = await db
      .from('utilisateurs')
      .select('id, role_id, mot_de_passe_hash, telephone, est_supprime')
      .eq('id', userId)
      .single();

    if (error || !user) throw createHttpError(404, 'Utilisateur introuvable');
    if (user.est_supprime === true) {
      throw createHttpError(410, 'Ce compte a déjà été supprimé.');
    }

    const ok = await verifyPasswordAndMaybeUpgrade(db, user, password);
    if (!ok) throw createHttpError(401, 'Mot de passe incorrect.');

    // Empêche un marchand de supprimer son compte s'il a une boutique/restaurant active
    // (force d'abord un transfert ou suppression par l'admin).
    const { data: roleRow } = await db.from('roles').select('nom').eq('id', user.role_id).maybeSingle();
    const roleNom = roleRow?.nom ?? null;
    if (roleNom === 'restaurateur' || roleNom === 'commercant') {
      const [{ count: nbRest }, { count: nbBout }] = await Promise.all([
        db.from('restaurants').select('id', { count: 'exact', head: true }).eq('proprietaire_id', userId).neq('statut', 'suspendu'),
        db.from('boutiques').select('id', { count: 'exact', head: true }).eq('proprietaire_id', userId).neq('statut', 'suspendu'),
      ]);
      if ((nbRest ?? 0) > 0 || (nbBout ?? 0) > 0) {
        throw createHttpError(
          409,
          'Vous gérez encore un commerce actif. Contactez le support GoLivra pour transférer ou fermer votre commerce avant de supprimer votre compte.',
        );
      }
    }

    if (roleNom === 'livreur') {
      const { data: liv } = await db
        .from('livreurs')
        .select('id, est_disponible')
        .eq('utilisateur_id', userId)
        .maybeSingle();
      if (liv?.id) {
        const { count: enCours } = await db
          .from('livraisons')
          .select('id', { count: 'exact', head: true })
          .eq('livreur_id', liv.id)
          .in('statut', ['attribuee', 'en_collecte', 'en_route']);
        if ((enCours ?? 0) > 0) {
          throw createHttpError(409, 'Vous avez des livraisons en cours. Terminez-les avant de supprimer votre compte.');
        }
        await db.from('livreurs').update({ est_disponible: false }).eq('id', liv.id);
      }
    }

    // 1) Push tokens : suppression totale
    try {
      const { unregisterAllTokensForUser } = require('../services/push.service');
      await unregisterAllTokensForUser(db, userId);
    } catch (e) {
      // non bloquant
      console.warn('[delete-account] push cleanup failed:', e?.message || e);
    }

    // 2) Sessions : révocation
    try {
      await db.from('sessions').delete().eq('utilisateur_id', userId);
    } catch (e) {
      console.warn('[delete-account] sessions cleanup failed:', e?.message || e);
    }

    // 3) Anonymisation des PII
    const anonTag = String(userId).slice(0, 8);
    const anonPhone = `+0000000${anonTag}`.slice(0, 20);
    const anonReason = typeof reason === 'string' ? reason.trim().slice(0, 500) : null;

    const { error: anonErr } = await db
      .from('utilisateurs')
      .update({
        est_supprime: true,
        est_actif: false,
        supprime_at: new Date().toISOString(),
        raison_suppression: anonReason || null,
        nom: 'Compte supprimé',
        telephone: anonPhone,
        email: null,
        avatar_url: null,
        mot_de_passe_hash: null,
      })
      .eq('id', userId);

    if (anonErr) {
      // Si on échoue ici on remonte une 500 — l'utilisateur peut réessayer.
      throw createHttpError(500, "Impossible de finaliser la suppression. Réessayez ou contactez le support.");
    }

    return res.json({
      message: 'Votre compte a été supprimé. Merci d’avoir utilisé GoLivra.',
      supprime_at: new Date().toISOString(),
    });
  } catch (error) {
    return next(error);
  }
}

async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body;
    requireFields(req.body, ['currentPassword', 'newPassword']);

    const validators = require('../lib/validators');
    validators.requireValid(newPassword, validators.validatePassword, 'newPassword');
    if (newPassword === currentPassword) {
      throw createHttpError(400, 'Le nouveau mot de passe doit être différent de l\'ancien.');
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

module.exports = {
  register,
  registerVendor,
  login,
  staffLogin,
  me,
  logout,
  updateProfile,
  changePassword,
  resetPassword,
  deleteAccount,
  getMyPreferences,
  patchMyPreferences,
};
