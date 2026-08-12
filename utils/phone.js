/**
 * Normalise un numéro Congo (Brazzaville) en E.164 (+242 + 9 chiffres).
 * Aligné sur la logique `toCgE164` du client Expo.
 *
 * STRICT : refuse tout numéro qui ne correspond pas EXACTEMENT au format
 * attendu. En particulier, un numéro avec plus de 9 chiffres nationaux
 * (collage, numéro faux, etc.) ou contenant des lettres est rejeté au lieu
 * d'être tronqué silencieusement (corrige l'envoi d'OTP vers un numéro
 * tronqué).
 */
function normalizeCgE164(input) {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  // Seuls chiffres, espaces et un éventuel « + » sont acceptés (E.164).
  if (!/^\+?[\d\s]+$/.test(raw)) return null;

  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('242')) {
    // +242 + 9 chiffres = 12 chiffres exactement.
    if (digits.length !== 12) return null;
    return `+242${digits.slice(3)}`;
  }
  // Format sans indicatif : 9 chiffres exactement.
  if (digits.length !== 9) return null;
  return `+242${digits}`;
}

module.exports = {
  normalizeCgE164,
};
