/**
 * Validateurs backend — source de vérité (anti-injection de données sales).
 * DOIT être cohérent avec `golivra/lib/form-validation.ts` (mobile).
 *
 * Utiliser `validatePersonName`, `validateCommerceName`, `validateProductName`…
 * à l'entrée de chaque route de création / mise à jour.
 */

const NUMERIC_ONLY_REGEX = /^[0-9\s]+$/;
const PUNCTUATION_ONLY_REGEX = /^[\s\.\-_/\\,;:'"!?@#$%^&*()+=<>[\]{}|`~*]+$/;
const EMOJI_ONLY_REGEX = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u;
const HAS_LETTER_REGEX = /\p{L}/u;
const HAS_DIGIT_REGEX = /\d/;
const DOUBLE_SPACE_REGEX = /\s{2,}/;
const NAME_REGEX_PERSON = /^[\p{L}][\p{L}\p{M}\s'’\-.]{0,79}$/u;
const NAME_REGEX_COMMERCE = /^[\p{L}0-9][\p{L}\p{M}\s'’\-.,&()]{0,79}$/u;
const NAME_REGEX_PRODUCT = /^[\p{L}0-9][\p{L}\p{M}0-9\s'’\-.,()/&°]{0,99}$/u;
const EMAIL_REGEX = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const STRICT_PASSWORD_REGEX = /^(?=.*[A-Za-z])(?=.*\d).{6,}$/;
const OTP_REGEX = /^[0-9]{6}$/;

function ok(value) { return { ok: true, value }; }
function fail(message) { return { ok: false, message }; }

function sanitizeText(raw) {
  if (!raw) return '';
  const collapsed = String(raw).trim().replace(DOUBLE_SPACE_REGEX, ' ');
  return collapsed.split(' ').filter((w) => w.length > 0).join(' ');
}

function titleCase(s) {
  if (!s) return '';
  return s.toLowerCase().split(' ').map((w) => (w.length === 0 ? w : w[0].toLocaleUpperCase() + w.slice(1))).join(' ');
}

function smartTitleCase(s) {
  if (!s) return '';
  if (s === s.toUpperCase() && /[A-Z]{2,}/.test(s)) return s;
  return titleCase(s);
}

function validatePersonName(value) {
  const v = sanitizeText(value);
  if (v.length === 0) return fail('Indiquez votre nom.');
  if (v.length < 2) return fail('Le nom doit contenir au moins 2 caractères.');
  if (NUMERIC_ONLY_REGEX.test(v)) return fail('Un nom ne peut pas être uniquement des chiffres.');
  if (PUNCTUATION_ONLY_REGEX.test(v)) return fail('Un nom ne peut pas être uniquement de la ponctuation.');
  if (EMOJI_ONLY_REGEX.test(v)) return fail('Un nom ne peut pas être uniquement des emojis.');
  if (!HAS_LETTER_REGEX.test(v)) return fail('Le nom doit contenir au moins une lettre.');
  if (!NAME_REGEX_PERSON.test(v)) return fail('Caractères non autorisés (lettres, espaces, tirets et apostrophes seulement).');
  return ok(titleCase(v));
}

function validateCommerceName(value) {
  const v = sanitizeText(value);
  if (v.length === 0) return fail('Indiquez le nom du commerce.');
  if (v.length < 2) return fail('Le nom du commerce doit contenir au moins 2 caractères.');
  if (NUMERIC_ONLY_REGEX.test(v)) return fail('Un nom de commerce ne peut pas être uniquement des chiffres.');
  if (PUNCTUATION_ONLY_REGEX.test(v)) return fail('Un nom de commerce ne peut pas être uniquement de la ponctuation.');
  if (EMOJI_ONLY_REGEX.test(v)) return fail('Un nom de commerce ne peut pas être uniquement des emojis.');
  if (!HAS_LETTER_REGEX.test(v)) return fail('Le nom du commerce doit contenir au moins une lettre.');
  if (!NAME_REGEX_COMMERCE.test(v)) return fail('Caractères non autorisés.');
  return ok(smartTitleCase(v));
}

function validateProductName(value) {
  const v = sanitizeText(value);
  if (v.length === 0) return fail('Indiquez le nom du produit.');
  if (v.length < 2) return fail('Le nom du produit doit contenir au moins 2 caractères.');
  if (NUMERIC_ONLY_REGEX.test(v)) return fail('Un nom de produit ne peut pas être uniquement des chiffres.');
  if (PUNCTUATION_ONLY_REGEX.test(v)) return fail('Un nom de produit ne peut pas être uniquement de la ponctuation.');
  if (EMOJI_ONLY_REGEX.test(v)) return fail('Un nom de produit ne peut pas être uniquement des emojis.');
  if (!HAS_LETTER_REGEX.test(v)) return fail('Le nom du produit doit contenir au moins une lettre.');
  if (!NAME_REGEX_PRODUCT.test(v)) return fail('Caractères non autorisés.');
  return ok(smartTitleCase(v));
}

function validatePhoneCg(value) {
  const v = sanitizeText(value);
  if (v.length === 0) return fail('Numéro de téléphone requis.');
  if (!HAS_DIGIT_REGEX.test(v)) return fail('Le numéro doit contenir des chiffres.');
  // Retire tous les espaces et vérifie le format E164 : +242 + 9 chiffres
  const plain = v.replace(/\s/g, '');
  if (!/^\+242[0-9]{9}$/.test(plain)) {
    return fail('Format attendu : +242 06 XXX XX XX.');
  }
  return ok(v);
}

function validateEmailOptional(value) {
  const v = sanitizeText(value);
  if (v.length === 0) return ok('');
  if (!EMAIL_REGEX.test(v)) return fail('Email invalide (ex. exemple@domaine.com).');
  return ok(v.toLowerCase());
}

function validateEmailRequired(value) {
  const v = sanitizeText(value);
  if (v.length === 0) return fail('Email requis.');
  if (!EMAIL_REGEX.test(v)) return fail('Email invalide (ex. exemple@domaine.com).');
  return ok(v.toLowerCase());
}

function validatePassword(value) {
  if (!value) return fail('Mot de passe requis.');
  if (String(value).length < 6) return fail('Le mot de passe doit contenir au moins 6 caractères.');
  if (!STRICT_PASSWORD_REGEX.test(String(value))) return fail('Le mot de passe doit contenir au moins 1 lettre et 1 chiffre.');
  return ok(String(value));
}

function validateAddress(value, required = true) {
  const v = sanitizeText(value);
  if (v.length === 0) return required ? fail('Adresse requise.') : ok('');
  if (v.length < 5) return fail('Adresse trop courte (5 caractères minimum).');
  if (NUMERIC_ONLY_REGEX.test(v)) return fail('Une adresse ne peut pas être uniquement des chiffres.');
  if (PUNCTUATION_ONLY_REGEX.test(v)) return fail('Une adresse ne peut pas être uniquement de la ponctuation.');
  if (!HAS_LETTER_REGEX.test(v)) return fail('L\'adresse doit contenir au moins une lettre (rue, repère ou quartier).');
  return ok(v);
}

function validateDescription(value, max = 500) {
  const v = sanitizeText(value);
  if (v.length > max) return fail(`Maximum ${max} caractères.`);
  return ok(v);
}

function validatePrice(value) {
  const raw = typeof value === 'number' ? String(value) : sanitizeText(String(value));
  const n = Number(String(raw).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) return fail('Prix invalide.');
  if (n <= 0) return fail('Le prix doit être supérieur à 0.');
  if (n > 10_000_000) return fail('Le prix est trop élevé.');
  return ok(String(n));
}

function validateStock(value, required = false) {
  if (value === '' || value === null || value === undefined) {
    return required ? fail('Stock requis.') : ok('');
  }
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fail('Stock invalide (entier attendu).');
  if (n < 0) return fail('Le stock ne peut pas être négatif.');
  if (n > 999_999) return fail('Le stock est trop élevé.');
  return ok(String(n));
}

function validateOtp(value) {
  if (!OTP_REGEX.test(sanitizeText(value))) return fail('Le code doit comporter 6 chiffres.');
  return ok(sanitizeText(value));
}

const MAX_PROMO_MONTHS = 12;

/**
 * Règles métier du bloc promo (miroir de `validatePromoBlock` côté mobile).
 * - prixPromo vide → dates forcément vides
 * - prixPromo strictement inférieur au prix normal
 * - dates début et fin obligatoires si prixPromo saisi
 * - date début >= aujourd'hui (pas dans le passé)
 * - date fin > date début
 * - durée <= 12 mois calendaires
 * Retourne `null` si OK, ou un message d'erreur (qui sera wrappé en 400 par `requireValidPromo`).
 */
function validatePromoBlock({ prixNormal, prixPromo, promoDebutAt, promoFinAt }) {
  const normal = Number(prixNormal);
  const hasPromo = prixPromo !== undefined && prixPromo !== null && String(prixPromo).trim() !== '';

  if (!hasPromo) {
    const d = promoDebutAt;
    const f = promoFinAt;
    const hasDate = (v) => v !== undefined && v !== null && String(v).trim() !== '';
    if (hasDate(d) || hasDate(f)) return { message: 'Aucune promo en cours : retirez les dates.', field: 'prixPromo' };
    return null;
  }

  const priceCheck = validatePrice(prixPromo);
  if (!priceCheck.ok) return { message: priceCheck.message, field: 'prixPromo' };
  const promoNum = Number(priceCheck.value);

  if (!Number.isFinite(normal) || normal <= 0) return { message: 'Prix normal invalide.', field: 'prixPromo' };
  if (promoNum >= normal) return { message: 'Le prix promo doit être inférieur au prix normal.', field: 'prixPromo' };

  if (promoDebutAt === undefined || promoDebutAt === null || String(promoDebutAt).trim() === '') {
    return { message: 'Date de début de promo requise.', field: 'promoDebutAt' };
  }
  if (promoFinAt === undefined || promoFinAt === null || String(promoFinAt).trim() === '') {
    return { message: 'Date de fin de promo requise.', field: 'promoFinAt' };
  }

  const start = new Date(String(promoDebutAt).slice(0, 10) + 'T00:00:00Z');
  const end = new Date(String(promoFinAt).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(start.getTime())) return { message: 'Date de début invalide.', field: 'promoDebutAt' };
  if (Number.isNaN(end.getTime())) return { message: 'Date de fin invalide.', field: 'promoFinAt' };

  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (start.getTime() < todayUtc.getTime()) {
    return { message: 'La date de début ne peut pas être dans le passé.', field: 'promoDebutAt' };
  }
  if (end.getTime() <= start.getTime()) {
    return { message: 'La date de fin doit être après la date de début.', field: 'promoFinAt' };
  }

  const oneYearLater = new Date(start);
  oneYearLater.setUTCFullYear(oneYearLater.getUTCFullYear() + 1);
  if (end.getTime() > oneYearLater.getTime()) {
    return { message: `La promo ne peut pas dépasser ${MAX_PROMO_MONTHS} mois.`, field: 'promoFinAt' };
  }

  return null;
}

function requireValidPromo({ prixNormal, prixPromo, promoDebutAt, promoFinAt }) {
  const err = validatePromoBlock({ prixNormal, prixPromo, promoDebutAt, promoFinAt });
  if (err) {
    const e = new Error(err.message);
    e.status = 400;
    e.field = err.field;
    throw e;
  }
}

/**
 * Helper : applique un validateur et throw une `ApiError 400` si invalide.
 * À utiliser dans les routes Express.
 */
function requireValid(value, validator, fieldName) {
  const r = validator(value);
  if (!r.ok) {
    const err = new Error(r.message);
    err.status = 400;
    err.field = fieldName;
    throw err;
  }
  return r.value;
}

module.exports = {
  sanitizeText,
  validatePersonName,
  validateCommerceName,
  validateProductName,
  validatePhoneCg,
  validateEmailOptional,
  validateEmailRequired,
  validatePassword,
  validateAddress,
  validateDescription,
  validatePrice,
  validateStock,
  validateOtp,
  validatePromoBlock,
  requireValid,
  requireValidPromo,
};
