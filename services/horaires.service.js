/**
 * Service — Horaires d'ouverture des commerces (restaurants / boutiques)
 *
 * Règles :
 *  - Un commerce SANS horaires définis est considéré FERMÉ (strict) : les
 *    commandes sont bloquées et la fiche invite le commerce à les définir.
 *  - Une plage avec fermeture < ouverture chevauche minuit (ex. 22:00 → 02:00).
 *  - Plusieurs plages par jour autorisées (ex. déjeuner + dîner).
 *  - jour : 0 = Dimanche … 6 = Samedi (convention JS getDay()).
 */

const DAY_NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

/** Formate une heure TIME ("10:00:00") en "10h00". */
function formatHour(value) {
  if (value == null || value === '') return '';
  const s = String(value);
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return s;
  return `${Number(m[1])}:${m[2]}`;
}

/** Minutes depuis minuit pour une heure TIME. */
function toMinutes(value) {
  if (value == null || value === '') return null;
  const s = String(value);
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Capitalise la première lettre (« cette boutique » → « Cette boutique »). */
function capitalizeFirst(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Minutes → "HH:MM" (boucle sur 24 h pour les plages qui chevauchent minuit). */
function minutesToTime(total) {
  const m = Math.max(0, Math.floor(Number(total) || 0));
  const hh = Math.floor(m / 60) % 24;
  const mm = m % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function normalizeRows(rows) {
  return (rows || []).map((r) => ({
    jour: Number(r.jour),
    ouverture: r.ouverture ? String(r.ouverture) : null,
    fermeture: r.fermeture ? String(r.fermeture) : null,
  }));
}

/**
 * Heure « murale » de Brazzaville (UTC+1) à partir d'un instant quelconque.
 *
 * Les horaires des commerces sont saisis en heure locale (Brazzaville) et
 * interprétés comme tels. Sans ce décallage, un serveur réglé sur UTC évalue
 * « maintenant » avec 1 h de retard : à 9h30 locales, il croit qu'il est 8h30
 * et bloque les commandes (« Réouverture aujourd'hui à 09h00 ») alors que le
 * commerce est déjà ouvert.
 *
 * Retourne un `Date` décalé pour que `getHours()`, `getMinutes()`, `getDay()`
 * et les accesseurs de date lisent l'heure de Brazzaville.
 */
function nowInBrazzaville(now) {
  // getTimezoneOffset() = minutes à soustraire de l'heure locale pour UTC.
  // Brazzaville = UTC+1 → décalage cible de +60 min ; on décale le timestamp
  // de (60 + getTimezoneOffset()) minutes pour aligner les accesseurs locaux.
  const offsetDiffMin = 60 + now.getTimezoneOffset();
  return new Date(now.getTime() + offsetDiffMin * 60_000);
}

/** Lit les horaires d'un établissement (restaurant ou boutique). */
async function getEtablissementHoraires(db, { kind, id }) {
  if (!id) return [];
  const table = 'horaires_etablissements';
  const col = kind === 'boutique' ? 'boutique_id' : 'restaurant_id';
  try {
    const { data, error } = await db
      .from(table)
      .select('id, jour, ouverture, fermeture')
      .eq(col, id)
      .order('jour', { ascending: true });
    if (error) return [];
    return normalizeRows(data);
  } catch {
    return []; // table absente (migration pas encore exécutée) → comportement strict géré en amont
  }
}

/**
 * Faisabilité d'une commande à l'instant T.
 *
 * Une commande n'est possible que si la préparation (temps de préparation du
 * commerce) peut se TERMINER avant la fermeture de la plage en cours :
 * `heure maintenant + temps de préparation <= heure de fermeture`.
 *
 * Gère les plages qui chevauchent minuit (ex. 22:00 → 02:00) : la fermeture est
 * alors reportée au lendemain quand on est avant minuit.
 *
 * @param {Array<{jour:number, ouverture:string|null, fermeture:string|null}>} horaires
 * @param {number} [prepMinutes] temps de préparation (min)
 * @param {Date} [now]
 * @returns {{ ouvert: boolean, peutCommander: boolean, fermeture: string|null,
 *            derniereCommande: string|null, message: string|null }}
 */
function computeOrderFeasibility(horaires, prepMinutes = 0, now = new Date(), typeNom = 'le commerce') {
  const list = Array.isArray(horaires) ? horaires : [];
  if (list.length === 0) {
    return {
      ouvert: false,
      peutCommander: false,
      fermeture: null,
      derniereCommande: null,
      message: null,
    };
  }

  // Heure locale de Brazzaville (indépendante du fuseau du serveur).
  const localNow = nowInBrazzaville(now);
  const nowMin = localNow.getHours() * 60 + localNow.getMinutes();
  const todayIdx = localNow.getDay();
  const prep = Math.max(0, Math.floor(Number(prepMinutes) || 0));

  // Plage active actuellement (mêmes règles que computeOuverture).
  const active = list.find((w) => {
    if (Number(w.jour) !== todayIdx) return false;
    const start = toMinutes(w.ouverture);
    const end = toMinutes(w.fermeture);
    if (start == null || end == null) return false;
    if (end > start) return nowMin >= start && nowMin < end;
    return nowMin >= start || nowMin < end;
  });

  if (!active) {
    return { ouvert: false, peutCommander: false, fermeture: null, derniereCommande: null, message: null };
  }

  const startMin = toMinutes(active.ouverture);
  let closeMin = toMinutes(active.fermeture);
  // Plage qui chevauche minuit et on est AVANT minuit : la fermeture est demain.
  if (closeMin <= startMin && nowMin >= startMin) closeMin += 1440;

  const peutCommander = nowMin + prep <= closeMin;
  const cutoff = closeMin - prep;

  return {
    ouvert: true,
    peutCommander,
    fermeture: formatHour(active.fermeture),
    derniereCommande: formatHour(minutesToTime(cutoff)),
    message: peutCommander
      ? null
      : `Il est trop tard pour commander : ${typeNom} ferme à ${formatHour(active.fermeture)} et la préparation prend ${prep} min.`,
  };
}

/**
 * Calcule le statut ouvert/fermé à un instant donné.
 *
 * @param {Array<{jour:number, ouverture:string|null, fermeture:string|null}>} horaires
 * @param {Date} [now]
 * @returns {{ ouvert: boolean, prochaineOuverture: string|null, prochaineLabel: string|null }}
 */
function computeOuverture(horaires, now = new Date()) {
  const list = Array.isArray(horaires) ? horaires : [];
  if (list.length === 0) {
    return { ouvert: false, prochaineOuverture: null, prochaineLabel: null };
  }

  // Heure locale de Brazzaville (indépendante du fuseau du serveur).
  const localNow = nowInBrazzaville(now);
  const nowMin = localNow.getHours() * 60 + localNow.getMinutes();
  const todayIdx = localNow.getDay();

  const isInWindow = (win, dayIdx) => {
    if (Number(win.jour) !== dayIdx) return false;
    const start = toMinutes(win.ouverture);
    const end = toMinutes(win.fermeture);
    if (start == null || end == null) return false;
    if (end > start) return nowMin >= start && nowMin < end;
    // Plage qui chevauche minuit (ex. 22:00 → 02:00)
    return nowMin >= start || nowMin < end;
  };

  const ouvert = list.some((w) => isInWindow(w, todayIdx));

  // Prochaine ouverture (recherche sur les 7 prochains jours)
  let prochaine = null;
  let prochaineLabel = null;
  for (let offset = 0; offset <= 7 && !prochaine; offset += 1) {
    // Construit à partir des champs murals de Brazzaville pour rester
    // cohérent avec `todayIdx` (jour local, pas jour serveur).
    const day = new Date(localNow.getFullYear(), localNow.getMonth(), localNow.getDate() + offset);
    const dayIdx = day.getDay();
    const starts = list
      .filter((w) => Number(w.jour) === dayIdx)
      .map((w) => toMinutes(w.ouverture))
      .filter((m) => m != null)
      .sort((a, b) => a - b);
    if (starts.length === 0) continue;
    for (const start of starts) {
      if (offset === 0 && start <= nowMin) continue; // déjà passé aujourd'hui
      prochaine = `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`;
      if (offset === 0) prochaineLabel = 'aujourd\'hui';
      else if (offset === 1) prochaineLabel = 'demain';
      else prochaineLabel = DAY_NAMES[dayIdx];
      break;
    }
  }

  return { ouvert, prochaineOuverture: prochaine, prochaineLabel };
}

function typeRef(kind) {
  // Référence grammaticale complète du commerce (article correct) :
  // « cette boutique » (féminin) / « ce restaurant » (masculin).
  return kind === 'boutique' ? 'cette boutique' : 'ce restaurant';
}

/**
 * Retourne l'état complet d'ouverture + de commande pour un commerce.
 *
 * @param {object} db
 * @param {{ kind: string, id: string, prepMinutes?: number }} opts
 *   `prepMinutes` = temps de préparation : la commande n'est possible que si la
 *   préparation peut finir avant la fermeture.
 * @returns {Promise<{
 *   horaires: object[], ouvert: boolean, peut_commander: boolean,
 *   accepte_commandes: boolean, fermeture: string|null, derniere_commande: string|null,
 *   message_fermeture: string|null, message_commande: string|null,
 *   prochaine_ouverture: string|null }>}
 */
async function getEtablissementOuvertureInfo(db, { kind, id, prepMinutes = 0 }) {
  const typeNom = typeRef(kind);
  const horaires = await getEtablissementHoraires(db, { kind, id });

  if (horaires.length === 0) {
    return {
      horaires: [],
      ouvert: false,
      peut_commander: false,
      accepte_commandes: false,
      fermeture: null,
      derniere_commande: null,
      message_fermeture: `${capitalizeFirst(typeNom)} n'a pas encore défini ses horaires d'ouverture.`,
      message_commande: null,
      prochaine_ouverture: null,
    };
  }

  const feas = computeOrderFeasibility(horaires, prepMinutes, undefined, typeNom);
  const { prochaineOuverture, prochaineLabel } = computeOuverture(horaires);
  const suite =
    prochaineOuverture && prochaineLabel
      ? ` Réouverture ${prochaineLabel} à ${formatHour(prochaineOuverture)}.`
      : '';

  return {
    horaires,
    ouvert: feas.ouvert,
    peut_commander: feas.peutCommander,
    accepte_commandes: true,
    fermeture: feas.fermeture,
    derniere_commande: feas.derniereCommande,
    message_fermeture: feas.ouvert
      ? null
      : `${capitalizeFirst(typeNom)} est actuellement fermé${kind === 'boutique' ? 'e' : ''}.${suite}`,
    message_commande: feas.ouvert && !feas.peutCommander ? feas.message : null,
    prochaine_ouverture: prochaineOuverture ? formatHour(prochaineOuverture) : null,
  };
}

/**
 * Vérifie qu'une commande est possible à l'instant T (commerce ouvert ET
 * préparation finissable avant la fermeture). Lève une 403 avec un message
 * clair sinon. Utilisé à la création de commande.
 */
async function assertEtablissementOuvert(db, { kind, id, nom = null, prepMinutes = 0 }) {
  const info = await getEtablissementOuvertureInfo(db, { kind, id, prepMinutes });
  const prefix = nom ? `${nom} : ` : '';
  if (!info.accepte_commandes) {
    throw createHttpError(403, `${prefix}${info.message_fermeture}`);
  }
  if (!info.peut_commander) {
    throw createHttpError(403, `${prefix}${info.message_commande || info.message_fermeture}`);
  }
  return info;
}

// Import paresseux pour éviter une dépendance circulaire
function createHttpError(...args) {
  // eslint-disable-next-line global-require
  const { createHttpError: fn } = require('../utils/http');
  return fn(...args);
}

module.exports = {
  DAY_NAMES,
  formatHour,
  toMinutes,
  minutesToTime,
  normalizeRows,
  getEtablissementHoraires,
  computeOuverture,
  computeOrderFeasibility,
  getEtablissementOuvertureInfo,
  assertEtablissementOuvert,
};
