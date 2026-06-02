const fs = require('fs');
const path = require('path');

/**
 * Parse une stack trace Node.js en frames structurées.
 * Format de retour : { frames: [{ file, line, column, function, abs_path, in_app, source }],
 *                      top_frame, github_url }
 *
 * Heuristique "in_app" : une frame est considérée applicative si elle pointe
 * dans le dossier du backend (configurable via BACKEND_ROOT) et pas dans
 * node_modules / node:internal / natif.
 */

const BACKEND_ROOT = process.env.BACKEND_ROOT
  ? path.resolve(process.env.BACKEND_ROOT)
  : path.resolve(__dirname, '..');

const GITHUB_REPO_URL = (process.env.BACKEND_GITHUB_REPO_URL || '').replace(/\/+$/, '');
const GITHUB_BRANCH = process.env.BACKEND_GITHUB_BRANCH || 'main';
const GITHUB_SRC_PREFIX = process.env.BACKEND_GITHUB_SRC_PREFIX || 'golivra-backendcd';

const NATIVE_PREFIXES = ['node:', 'node_modules/', 'internal/'];
const FRAME_REGEX = /^\s*at\s+(?:(.+?)\s+\()?(.*?):(\d+):(\d+)\)?\s*$/;

function isNativeFrame(absPath) {
  if (!absPath) return false;
  if (absPath.startsWith('node:')) return true;
  if (absPath.includes(`node_modules${path.sep}`)) return true;
  if (absPath.includes(`${path.sep}node_modules`)) return true;
  if (absPath.startsWith('node_modules/')) return true;
  if (absPath.startsWith('internal/')) return true;
  return false;
}

function relativize(absPath) {
  if (!absPath) return null;
  if (absPath.startsWith(BACKEND_ROOT)) {
    return absPath.slice(BACKEND_ROOT.length + 1).replace(/\\/g, '/');
  }
  return absPath.replace(/\\/g, '/');
}

function inApp(absPath) {
  if (!absPath) return false;
  if (isNativeFrame(absPath)) return false;
  if (absPath.startsWith(BACKEND_ROOT)) return true;
  // Chemin absolu mais hors backend (autre disque / projet voisin) → pas applicatif.
  if (path.isAbsolute(absPath)) return false;
  // Chemin relatif (stack Node au runtime d'un script) → on l'estime applicatif.
  if (absPath.startsWith('./') || absPath.startsWith('../')) return true;
  // Chemin relatif plat du type "controllers/foo.js" → applicatif.
  if (/^[\w-]+(\/[\w.-]+)+$/.test(absPath)) return true;
  return false;
}

function buildGithubUrl(relFile, line) {
  if (!GITHUB_REPO_URL || !relFile) return null;
  const safeFile = relFile.replace(/^\.\//, '');
  const filePath = safeFile.startsWith(GITHUB_SRC_PREFIX + '/')
    ? safeFile
    : `${GITHUB_SRC_PREFIX}/${safeFile}`;
  return `${GITHUB_REPO_URL}/blob/${GITHUB_BRANCH}/${filePath}${line ? `#L${line}` : ''}`;
}

/**
 * Lit N lignes de contexte autour d'une ligne donnée.
 * Retourne { pre: string[], line: string, post: string[], startLine } ou null
 * si le fichier n'est pas lisible.
 */
function readContext(absPath, lineNumber, before = 5, after = 5) {
  try {
    if (!absPath || !fs.existsSync(absPath)) return null;
    const content = fs.readFileSync(absPath, 'utf8');
    const lines = content.split(/\r?\n/);
    if (lineNumber < 1 || lineNumber > lines.length) return null;
    const start = Math.max(1, lineNumber - before);
    const end = Math.min(lines.length, lineNumber + after);
    return {
      start_line: start,
      lines: lines.slice(start - 1, end).map((text, i) => ({
        line: start + i,
        text,
        highlight: start + i === lineNumber,
      })),
    };
  } catch {
    return null;
  }
}

function parseStack(stack) {
  if (!stack || typeof stack !== 'string') return [];
  const lines = stack.split(/\r?\n/);
  const frames = [];
  for (const raw of lines) {
    const m = raw.match(FRAME_REGEX);
    if (!m) continue;
    const fnName = m[1] || '<anonyme>';
    const absPath = m[2];
    const line = Number(m[3]) || 0;
    const column = Number(m[4]) || 0;
    const relPath = relativize(absPath);
    frames.push({
      function: fnName,
      file: relPath,
      abs_path: absPath,
      line,
      column,
      in_app: inApp(absPath),
    });
  }
  return frames;
}

function pickTopFrame(frames) {
  if (!frames || frames.length === 0) return null;
  return frames.find((f) => f.in_app) || frames[0];
}

function buildGithubUrlForFrame(frame) {
  if (!frame) return null;
  return buildGithubUrl(frame.file, frame.line);
}

/**
 * Parse complet : retourne frames + top_frame + github_url + code_context.
 * `stack` est une stack trace brute (Error.stack).
 */
function analyzeStack(stack) {
  const frames = parseStack(stack);
  const top = pickTopFrame(frames);
  let context = null;
  if (top && top.in_app && top.abs_path) {
    context = readContext(top.abs_path, top.line, 5, 5);
  }
  return {
    frames,
    top_frame: top,
    github_url: buildGithubUrlForFrame(top),
    code_context: context,
  };
}

/**
 * Variante : pour les erreurs capturées via req/res côté admin (côté navigateur),
 * on n'a pas toujours accès au filesystem. On accepte un payload "frames" déjà
 * extrait par le client (admin web ou mobile) et on ne fait que compléter avec
 * le github_url.
 */
function normalizeClientFrames(frames, defaultFileRoot = '') {
  if (!Array.isArray(frames)) return [];
  return frames.map((f) => {
    const relFile = f.file || f.abs_path || null;
    return {
      function: f.function || f.fn || '<anonyme>',
      file: relFile,
      abs_path: f.abs_path || null,
      line: Number(f.line) || 0,
      column: Number(f.column) || 0,
      in_app: f.in_app !== false,
      source: f.source || null,
      github_url: f.github_url || buildGithubUrl(relFile, Number(f.line) || null),
    };
  });
}

module.exports = {
  parseStack,
  pickTopFrame,
  readContext,
  buildGithubUrl,
  buildGithubUrlForFrame,
  analyzeStack,
  normalizeClientFrames,
  BACKEND_ROOT,
  GITHUB_REPO_URL,
  GITHUB_BRANCH,
};
