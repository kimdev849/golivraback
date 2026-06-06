/**
 * Règles de contenu GoLivra — annonces produits / plats.
 * Miroir mobile : `golivra/lib/content-policy.ts`
 */

const { sanitizeText } = require('./validators');

const URL_PATTERNS = [
  /https?:\/\//i,
  /\bwww\./i,
  /\b[\w-]+\.(com|fr|org|net|io|co|cg|info|biz|me|app|link|shop|store|tv|xyz|dev|site|online|pro|live|click|ly)\b/i,
  /\bt\.me\b/i,
  /\bwa\.me\b/i,
  /\bbit\.ly\b/i,
  /\btinyurl\.com\b/i,
  /\binstagram\.com\b/i,
  /\bfacebook\.com\b/i,
  /\btiktok\.com\b/i,
  /\bsnapchat\.com\b/i,
  /\bwhatsapp\.com\b/i,
  /\byoutube\.com\b/i,
  /\blinkedin\.com\b/i,
  /\bx\.com\b/i,
  /\btwitter\.com\b/i,
];

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

const PHONE_PATTERNS = [
  /\+242[\s.-]?\d{2}[\s.-]?\d{2}[\s.-]?\d{2}[\s.-]?\d{2}/,
  /\b0[456]\d[\s.-]?\d{2}[\s.-]?\d{2}[\s.-]?\d{2}\b/,
  /\b\d{3}[\s.-]\d{3}[\s.-]\d{3,4}\b/,
  /\b(?:tel|tél|phone|whatsapp|appel(?:ez)?|contact(?:ez)?)\s*[:\-]?\s*\+?\d/i,
];

const PROHIBITED_TERMS = [
  'porn', 'porno', 'pornograph', 'xxx', 'onlyfans', 'nude', 'nudité', 'nudite', 'nu(e)?\\s+(?:sur|photo|pic)',
  'sexe\\s+(?:gratuit|payant|cam)', 'escort', 'prostitu', 'nudisme',
  'arnaque', 'escroquerie', 'crypto\\s+gratuit', 'double\\s+votre\\s+argent',
  'viagra', 'casino\\s+en\\s+ligne', 'pari\\s+sportif',
];

const PROHIBITED_REGEXES = PROHIBITED_TERMS.map((t) => new RegExp(`\\b${t}`, 'iu'));

function containsExternalLink(text) {
  const v = String(text || '').trim();
  if (!v) return false;
  return URL_PATTERNS.some((re) => re.test(v));
}

function containsEmail(text) {
  return EMAIL_PATTERN.test(String(text || '').trim());
}

function containsPhoneContact(text) {
  const v = String(text || '').trim();
  if (!v) return false;
  return PHONE_PATTERNS.some((re) => re.test(v));
}

function containsProhibitedContent(text) {
  const v = String(text || '').trim().toLowerCase();
  if (!v) return false;
  return PROHIBITED_REGEXES.some((re) => re.test(v));
}

function fail(message) {
  return { ok: false, message };
}

function validateListingText(raw, opts = {}) {
  const {
    fieldLabel = 'Ce champ',
    required = false,
    minLength = 0,
    maxLength = 500,
    allowEmpty = !required,
  } = opts;

  const v = sanitizeText(raw);

  if (v.length === 0) {
    return allowEmpty ? { ok: true, value: '' } : fail(`${fieldLabel} est requis.`);
  }
  if (minLength > 0 && v.length < minLength) {
    return fail(`${fieldLabel} : ${minLength} caractères minimum.`);
  }
  if (v.length > maxLength) {
    return fail(`${fieldLabel} : maximum ${maxLength} caractères.`);
  }
  if (containsExternalLink(v)) {
    return fail('Les liens et réseaux sociaux ne sont pas autorisés dans les annonces.');
  }
  if (containsEmail(v)) {
    return fail('Les adresses e-mail ne sont pas autorisées — utilisez la messagerie GoLivra.');
  }
  if (containsPhoneContact(v)) {
    return fail('Les numéros de téléphone ne sont pas autorisés dans les annonces.');
  }
  if (containsProhibitedContent(v)) {
    return fail('Ce contenu ne respecte pas les règles de la plateforme.');
  }
  return { ok: true, value: v };
}

function validateListingDescription(raw, max = 500) {
  const v = sanitizeText(raw);
  if (v.length === 0) return { ok: true, value: '' };
  return validateListingText(v, {
    fieldLabel: 'La description',
    minLength: 10,
    maxLength: max,
    allowEmpty: true,
  });
}

function validateListingTagsText(raw) {
  const v = sanitizeText(raw);
  if (v.length === 0) return { ok: true, value: '' };

  const tags = v.split(',').map((t) => t.trim()).filter(Boolean);
  if (tags.length > 10) return fail('Maximum 10 tags.');

  for (const tag of tags) {
    if (tag.length < 2) return fail(`Tag trop court : « ${tag} ».`);
    if (tag.length > 30) return fail(`Tag trop long : « ${tag.slice(0, 20)}… ».`);
    const check = validateListingText(tag, { fieldLabel: `Le tag « ${tag} »`, maxLength: 30 });
    if (!check.ok) return check;
  }
  return { ok: true, value: v };
}

function validateListingBrand(raw) {
  const v = sanitizeText(raw);
  if (v.length === 0) return { ok: true, value: '' };
  return validateListingText(v, { fieldLabel: 'La marque', minLength: 2, maxLength: 60, allowEmpty: true });
}

function validateListingOptionGroups(groups) {
  if (!Array.isArray(groups) || groups.length === 0) return { ok: true, value: '' };

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i] || {};
    const nom = sanitizeText(g.nom ?? '');
    if (!nom) return fail(`Nom manquant pour le groupe d'options ${i + 1}.`);
    const nomCheck = validateListingText(nom, { fieldLabel: `Le groupe « ${nom} »`, minLength: 2, maxLength: 40 });
    if (!nomCheck.ok) return nomCheck;

    const choix = (Array.isArray(g.choix) ? g.choix : []).filter((c) => sanitizeText(c?.label ?? '').length > 0);
    if (choix.length === 0) return fail(`Ajoutez au moins un choix pour « ${nom} ».`);
    for (const c of choix) {
      const labelCheck = validateListingText(c.label, {
        fieldLabel: `L'option « ${c.label} »`,
        minLength: 1,
        maxLength: 60,
      });
      if (!labelCheck.ok) return labelCheck;
    }
  }
  return { ok: true, value: '' };
}

/**
 * Valide tous les champs textuels d'une annonce avant insert/update.
 * Throw ApiError 400 via requireValid pattern.
 */
function assertListingContent(body) {
  const validators = require('./validators');

  if (body.nom !== undefined && body.nom !== null) {
    const nomClean = validators.requireValid(body.nom, validators.validateProductName, 'nom');
    const nomPolicy = validateListingText(nomClean, { fieldLabel: 'Le nom', maxLength: 100 });
    if (!nomPolicy.ok) {
      const e = new Error(nomPolicy.message);
      e.status = 400;
      e.field = 'nom';
      throw e;
    }
  }

  if (body.description !== undefined && body.description !== null && String(body.description).trim()) {
    validators.requireValid(body.description, (v) => validators.validateDescription(v, 500), 'description');
    const descPolicy = validateListingDescription(body.description);
    if (!descPolicy.ok) {
      const e = new Error(descPolicy.message);
      e.status = 400;
      e.field = 'description';
      throw e;
    }
  }

  if (body.marque !== undefined && body.marque !== null && String(body.marque).trim()) {
    const brandPolicy = validateListingBrand(body.marque);
    if (!brandPolicy.ok) {
      const e = new Error(brandPolicy.message);
      e.status = 400;
      e.field = 'marque';
      throw e;
    }
  }

  if (body.tags !== undefined) {
    const tagsRaw = Array.isArray(body.tags) ? body.tags.join(', ') : String(body.tags ?? '');
    const tagsPolicy = validateListingTagsText(tagsRaw);
    if (!tagsPolicy.ok) {
      const e = new Error(tagsPolicy.message);
      e.status = 400;
      e.field = 'tags';
      throw e;
    }
  }

  if (body.options !== undefined && body.options !== null) {
    const optPolicy = validateListingOptionGroups(body.options);
    if (!optPolicy.ok) {
      const e = new Error(optPolicy.message);
      e.status = 400;
      e.field = 'options';
      throw e;
    }
  }
}

module.exports = {
  containsExternalLink,
  containsEmail,
  containsPhoneContact,
  containsProhibitedContent,
  validateListingText,
  validateListingDescription,
  validateListingTagsText,
  validateListingBrand,
  validateListingOptionGroups,
  assertListingContent,
};
