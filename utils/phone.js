/**
 * Normalise un numéro Congo (Brazzaville) en E.164 (+242 + 9 chiffres).
 * Aligné sur la logique `toCgE164` du client Expo.
 */
function normalizeCgE164(input) {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  const digits = raw.replace(/\D/g, '');
  const nationalDigits = digits.startsWith('242') ? digits.slice(3, 12) : digits.slice(0, 9);

  if (nationalDigits.length !== 9) return null;
  return `+242${nationalDigits}`;
}

module.exports = {
  normalizeCgE164,
};
