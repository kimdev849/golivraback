const { sendSms } = require('../services/twilio.service');
const { getDb } = require('../config/db');
const { requireFields, createHttpError } = require('../utils/http');
const { normalizeCgE164 } = require('../utils/phone');
const {
  insertOtp,
  findPendingOtp,
  deleteOtpByPhoneAndCode,
  otpTableHint,
} = require('../services/otp.store');

function buildOtpCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function isOtpTestModeEnabled() {
  return process.env.OTP_TEST_MODE === '1' || process.env.OTP_TEST_MODE === 'true';
}

function isTwilioConfigured() {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const messaging = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  const from = process.env.TWILIO_FROM_NUMBER?.trim();
  return Boolean(sid && token && (messaging || from));
}

async function requestOtp(req, res, next) {
  try {
    const { telephone: telephoneRaw } = req.body;
    requireFields(req.body, ['telephone']);

    const telephone = normalizeCgE164(telephoneRaw);
    if (!telephone) {
      throw createHttpError(
        400,
        'Numéro de téléphone invalide. Indiquez +242 suivi de 9 chiffres (Congo).',
      );
    }

    const code = buildOtpCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const db = getDb();

    const { error } = await insertOtp(db, { telephone, code, expiresAt });
    if (error) {
      const detail = String(error.message || '');
      if (detail.toLowerCase().includes('permission denied')) {
        throw createHttpError(
          503,
          'Accès Supabase refusé (permission denied). Sur Render, remplacez SUPABASE_SECRET_KEY par la clé SECRÈTE ' +
            '(sb_secret_… ou service_role), pas la clé publishable (sb_publishable_…). ' +
            'Exécutez aussi sql/fix-supabase-permissions.sql dans Supabase.',
        );
      }
      throw createHttpError(
        500,
        `Impossible de générer le code de vérification. Vérifiez la table ${otpTableHint()} sur Supabase (détail: ${detail}).`,
      );
    }

    const testMode = isOtpTestModeEnabled() || !isTwilioConfigured();
    if (testMode) {
      if (!isTwilioConfigured()) {
        console.warn('[golivra] Twilio non configuré — OTP renvoyé en mode test (code visible dans la réponse).');
      }
      return res.json({
        message: 'Code OTP généré (mode test).',
        testMode: true,
        otpCode: code,
      });
    }

    try {
      await sendSms(
        telephone,
        `GoLivra : votre code de vérification est ${code}. Valide 10 minutes.`,
      );
    } catch (smsError) {
      try {
        await deleteOtpByPhoneAndCode(db, telephone, code);
      } catch (cleanupError) {
        console.warn('Rollback OTP impossible après échec SMS :', cleanupError.message);
      }
      throw createHttpError(
        503,
        `Impossible d’envoyer le SMS de vérification pour le moment. Vérifiez la configuration SMS et réessayez. Détail: ${smsError.message}`,
      );
    }

    return res.json({ message: 'Code OTP envoyé', testMode: false });
  } catch (error) {
    if (error && (error.status || error.statusCode)) {
      return next(error);
    }
    return next(
      createHttpError(
        500,
        `Erreur OTP côté base/configuration. Détail: ${error?.message || 'inconnu'}`,
      ),
    );
  }
}

async function verifyOtp(req, res, next) {
  try {
    const { telephone: telephoneRaw, code } = req.body;
    requireFields(req.body, ['telephone', 'code']);

    const telephone = normalizeCgE164(telephoneRaw);
    if (!telephone) {
      throw createHttpError(
        400,
        'Numéro de téléphone invalide. Indiquez +242 suivi de 9 chiffres (Congo).',
      );
    }

    const db = getDb();
    const { data: otpRow, error } = await findPendingOtp(db, telephone, code);

    if (error) {
      throw createHttpError(
        500,
        `Erreur de lecture OTP (table ${otpTableHint()}). Détail: ${error.message}`,
      );
    }
    if (!otpRow) throw createHttpError(400, 'Code de vérification introuvable ou incorrect');
    if (new Date(otpRow.expire_at) <= new Date()) throw createHttpError(400, 'Le code de vérification a expiré');
    if (String(otpRow.code) !== String(code)) throw createHttpError(400, 'Code de vérification incorrect');

    return res.json({ verified: true });
  } catch (error) {
    if (error && (error.status || error.statusCode)) {
      return next(error);
    }
    return next(
      createHttpError(
        500,
        `Erreur de vérification OTP côté base/configuration. Détail: ${error?.message || 'inconnu'}`,
      ),
    );
  }
}

module.exports = {
  requestOtp,
  verifyOtp,
};
