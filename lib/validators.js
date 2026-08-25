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
// Rejette le HTML/JS dangereux dans les champs libres (adresse, description) :
// balises (`<script>`, `</div>`, `<!DOCTYPE>`), schémas `javascript:` /
// `data:text/html` et attributs de gestion d'événements (`onerror=`, `onclick=`…).
// Les emojis et accents restent autorisés — seule la vraie « poubelle » est refusée.
const DANGEROUS_MARKUP_REGEX = /<\s*[a-zA-Z\/!]|javascript\s*:|data\s*:\s*text\/html|on(?:error|load|click|mouseover|mouseenter|focus|blur|change|submit|input)\s*=/i;
const NAME_REGEX_PERSON = /^[\p{L}][\p{L}\p{M}\s'’\-.]{0,79}$/u;
// Les emojis restent autorisés dans les noms de commerce / produits (app
// moderne : « Boutique Javer 🛍️ », « 🍕 Pizza spéciale 🔥 ») : le nom doit
// quand même contenir au moins une lettre (EMOJI_ONLY est rejeté plus bas).
const NAME_REGEX_COMMERCE = /^[\p{L}0-9\p{Emoji_Presentation}\p{Extended_Pictographic}@][\p{L}\p{M}0-9\s'’\-.,&()@\p{Emoji_Presentation}\p{Extended_Pictographic}]{0,79}$/u;
const NAME_REGEX_PRODUCT = /^[\p{L}0-9\p{Emoji_Presentation}\p{Extended_Pictographic}@][\p{L}\p{M}0-9\s'’\-.,()/&°@\p{Emoji_Presentation}\p{Extended_Pictographic}]{0,99}$/u;
const EMAIL_REGEX = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const STRICT_PASSWORD_REGEX = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/;
const OTP_REGEX = /^[0-9]{6}$/;

function ok(value) { return { ok: true, value }; }
function fail(message) { return { ok: false, message }; }

function sanitizeText(raw) {
  if (!raw) return '';
  // Retire les caractères de contrôle dangereux / invisibles (hors \n \t \r) :
  // rien d'exécutable ni de « fantôme » ne doit entrer en base.
  const noControl = String(raw).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  const collapsed = noControl.trim().replace(DOUBLE_SPACE_REGEX, ' ');
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
  const s = String(value);
  if (s.length < 8) return fail('Le mot de passe doit contenir au moins 8 caractères.');
  // Plafond de longueur : bcrypt ne prend de toute façon en compte que les
  // 72 premiers octets — on évite les payloads démesurés (anti-DoS).
  if (s.length > 128) return fail('Le mot de passe ne peut pas dépasser 128 caractères.');
  if (!STRICT_PASSWORD_REGEX.test(s)) return fail('Le mot de passe doit contenir au moins 1 lettre et 1 chiffre.');
  return ok(s);
}

function validateAddressLabel(value) {
  const v = sanitizeText(value);
  if (v.length === 0) return ok('');
  if (v.length < 2) return fail("Le nom de l'adresse est trop court (2 caractères minimum).");
  if (v.length > 50) return fail("Le nom de l'adresse ne peut pas dépasser 50 caractères.");
  if (DANGEROUS_MARKUP_REGEX.test(v)) return fail("Le nom de l'adresse contient des caractères non autorisés.");
  if (NUMERIC_ONLY_REGEX.test(v)) return fail("Le nom de l'adresse ne peut pas être uniquement des chiffres.");
  if (PUNCTUATION_ONLY_REGEX.test(v)) return fail("Le nom de l'adresse ne peut pas être uniquement de la ponctuation.");
  if (EMOJI_ONLY_REGEX.test(v)) return fail("Le nom de l'adresse ne peut pas être uniquement des emojis.");
  if (!HAS_LETTER_REGEX.test(v)) return fail("Le nom de l'adresse doit contenir au moins une lettre (ex. Maison, Travail, Chez maman).");
  // Même règle anti-poubelle que l'adresse : pas plus de 2 symboles avant la
  // première lettre (« @$%3ddf » refusé, « 🏠 Maison » accepté).
  const firstLetterIdx = v.search(/\p{L}/u);
  const prefix = firstLetterIdx === -1 ? v : v.slice(0, firstLetterIdx);
  const leadingGarbage = prefix.replace(/[\d\s\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').length;
  if (leadingGarbage > 2) return fail("Le nom de l'adresse est invalide (commencez par une lettre).");
  return ok(v);
}

function validateAddress(value, required = true) {
  const v = sanitizeText(value);
  if (v.length === 0) return required ? fail('Adresse requise.') : ok('');
  if (v.length < 4) return fail('Adresse trop courte (4 caractères minimum).');
  if (v.length > 300) return fail('Adresse trop longue (300 caractères maximum).');
  if (NUMERIC_ONLY_REGEX.test(v)) return fail('Une adresse ne peut pas être uniquement des chiffres.');
  if (PUNCTUATION_ONLY_REGEX.test(v)) return fail('Une adresse ne peut pas être uniquement de la ponctuation.');
  if (DANGEROUS_MARKUP_REGEX.test(v)) return fail('Adresse non autorisée (balises HTML / scripts interdits).');
  // Les adresses de type « @6363 » ou « @Avenue » (repères) sont acceptées.
  const isAtHandle = /^@\p{L}+[\p{L}\d\s'’\-.,&()]*$/u.test(v);
  if (!isAtHandle && !HAS_LETTER_REGEX.test(v)) return fail('L\'adresse doit contenir au moins une lettre (rue, repère ou quartier).');
  // Rejette les saisies de test absurdes du type « @##fff », « 555@#$$kk » :
  // il faut au moins 2 lettres ET pas plus de 2 symboles avant la première
  // lettre (les adresses réelles commencent par une lettre ou un numéro de
  // rue, ex. « PK 45 », « 12 rue de la Paix », « Av. de la Paix »).
  if (!isAtHandle) {
    const letters = (v.match(/\p{L}/gu) || []).length;
    if (letters < 2) return fail('L\'adresse doit contenir au moins 2 lettres.');
    // Poubelle avant la première lettre : seuls les SYMBOLES / ponctuation
    // comptent. Les chiffres (numéro de rue), les espaces et les emojis sont
    // autorisés (« 📍 Avenue de la Paix », « 🏠 Résidence X ») — mais pas
    // « @##fff » ni « 555@#$$kk ».
    const firstLetterIdx = v.search(/\p{L}/u);
    const prefix = firstLetterIdx === -1 ? v : v.slice(0, firstLetterIdx);
    const leadingGarbage = prefix.replace(/[\d\s\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').length;
    if (leadingGarbage > 2) return fail('Adresse invalide (commencez par le quartier, la rue ou un repère).');
  }
  return ok(v);
}

/**
 * Valide un « Point de repère » ou des « Instructions livreur » : champ libre
 * mais pas de poubelle. Mêmes règles anti-symboles que l'adresse — « @#####^ »,
 * « !!! », « 12345 » refusés ; « Face station Puma », « Sonner 2 fois » acceptés.
 * Miroir de `validateLandmark` côté mobile (form-validation.ts).
 */
function validateLandmark(value, max = 300) {
  const v = sanitizeText(value);
  if (v.length === 0) return ok('');
  if (v.length < 2) return fail('Trop court (2 caractères minimum).');
  if (v.length > max) return fail(`Maximum ${max} caractères.`);
  if (NUMERIC_ONLY_REGEX.test(v)) return fail('Ce champ ne peut pas être uniquement des chiffres.');
  if (PUNCTUATION_ONLY_REGEX.test(v)) return fail('Ce champ ne peut pas être uniquement de la ponctuation.');
  if (EMOJI_ONLY_REGEX.test(v)) return fail('Ce champ ne peut pas être uniquement des emojis.');
  if (DANGEROUS_MARKUP_REGEX.test(v)) return fail('Contenu non autorisé (balises HTML / scripts interdits).');
  if (!HAS_LETTER_REGEX.test(v)) return fail('Ce champ doit contenir au moins une lettre.');
  // Même règle anti-poubelle que l'adresse : au moins 2 lettres ET pas plus de
  // 2 symboles avant la première lettre (« @#####^ », « $%&3ddf » refusés ;
  // « Face station Puma », « 12e étage », « 🏠 Portail vert » acceptés).
  const letters = (v.match(/\p{L}/gu) || []).length;
  if (letters < 2) return fail('Ce champ doit contenir au moins 2 lettres.');
  const firstLetterIdx = v.search(/\p{L}/u);
  const prefix = firstLetterIdx === -1 ? v : v.slice(0, firstLetterIdx);
  const leadingGarbage = prefix.replace(/[\d\s\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').length;
  if (leadingGarbage > 2) return fail('Saisie invalide (commencez par une lettre ou un chiffre).');
  return ok(v);
}

function validateDescription(value, max = 500) {
  const v = sanitizeText(value);
  if (v.length > max) return fail(`Maximum ${max} caractères.`);
  if (DANGEROUS_MARKUP_REGEX.test(v)) return fail('Contenu non autorisé (balises HTML / scripts interdits).');
  return ok(v);
}

/**
 * Prix minimal autorisé pour un produit / plat (FCFA).
 * Les montants étant exprimés en FCFA (plus petite unité), aucun produit ne
 * peut être vendu en dessous de 25 FCFA.
 */
const MIN_PRICE = 10;

/**
 * Prix maximal autorisé pour un produit / plat (FCFA).
 * Porté de 10 M à 999 999 999 (près d'un milliard) — la base accepte
 * jusqu'à DECIMAL(12,2) = 9 999 999 999,99. Voir la migration
 * `sql/raise-price-limit.sql` pour les bases encore en DECIMAL(10,2).
 */
const MAX_PRICE = 999_999_999;

function validatePrice(value) {
  const raw = typeof value === 'number' ? String(value) : sanitizeText(String(value));
  const n = Number(String(raw).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) return fail('Prix invalide.');
  if (n < MIN_PRICE) return fail(`Le prix minimum est ${MIN_PRICE} FCFA.`);
  if (n > MAX_PRICE) return fail(`Le prix est trop élevé (maximum ${MAX_PRICE.toLocaleString('fr-FR')} FCFA).`);
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
  validateAddressLabel,
  validateLandmark,
  validateDescription,
  validatePrice,
  validateStock,
  validateOtp,
  validatePromoBlock,
  requireValid,
  requireValidPromo,
  MIN_PRICE,
  MAX_PRICE,
};
