const { hashSessionToken } = require('../../utils/token');

const ROLES = [
  { id: 1, nom: 'client' },
  { id: 2, nom: 'restaurateur' },
  { id: 3, nom: 'commercant' },
  { id: 4, nom: 'livreur' },
  { id: 5, nom: 'admin' },
];

let seq = 0;

/**
 * Crée un utilisateur + sa session (token Bearer valide).
 * Renvoie une portion de seed : { roles, utilisateurs, sessions }.
 */
function user(roleNom, token, extra = {}) {
  const role = ROLES.find((r) => r.nom === roleNom) || ROLES[0];
  seq += 1;
  const id = extra.id || `u${seq}`;
  return {
    roles: [role],
    utilisateurs: [
      {
        id,
        nom: extra.nom || roleNom,
        telephone: extra.telephone || `06000000${String(seq).padStart(2, '0')}`,
        role_id: role.id,
      },
    ],
    sessions: [
      {
        id: `s-${id}`,
        utilisateur_id: id,
        token_hash: hashSessionToken(token),
        expire_at: '2099-01-01T00:00:00Z',
        revoque: false,
      },
    ],
  };
}

/** Fusionne plusieurs portions de seed (dédup par table + id). */
function merge(...parts) {
  const out = {};
  for (const part of parts) {
    for (const [table, rows] of Object.entries(part || {})) {
      out[table] = out[table] || [];
      for (const row of rows) {
        if (row && row.id != null && out[table].some((r) => r.id === row.id)) continue;
        out[table].push(row);
      }
    }
  }
  return out;
}

module.exports = { ROLES, user, merge };
