/**
 * Fake Supabase client (en mémoire) pour les tests d'autorisation.
 *
 * Implémente les formes de requêtes réellement utilisées par les contrôleurs /
 * services sous test (from → select/eq/in/is/not/order/limit → maybeSingle /
 * single / thenable, update, insert). Les données sont des objets simples
 * fournis par le seed de chaque test.
 *
 * IMPORTANT : ce fake reproduit la SÉMANTIQUE des requêtes, pas la base.
 * Les tests vérifient la logique d'autorisation (filtres par propriétaire),
 * pas la performance ni les contraintes SQL.
 */

function matchValue(actual, op, expected) {
  switch (op) {
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    case 'is':
      return expected === null ? actual == null : actual === expected;
    default:
      return false;
  }
}

function matchRow(row, filters) {
  return filters.every(({ field, op, value, negate }) => {
    const ok = matchValue(row[field], op, value);
    return negate ? !ok : ok;
  });
}

function createFakeDb(seed = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed || {})) {
    tables[name] = (Array.isArray(rows) ? rows : []).map((r) => ({ ...r }));
  }

  function buildChain(table, writeState = null) {
    const state = {
      filters: [],
      orderBy: null,
      limit: null,
      patch: writeState && writeState.patch,
      insertRows: writeState && writeState.insertRows,
      deleteOp: writeState && writeState.deleteOp,
    };

    const run = () => {
      const source = tables[table] || [];

      if (state.patch != null) {
        const matches = source.filter((r) => matchRow(r, state.filters));
        for (const r of matches) Object.assign(r, state.patch);
        return matches.map((r) => ({ ...r }));
      }
      if (state.deleteOp) {
        const kept = source.filter((r) => !matchRow(r, state.filters));
        const removed = source.filter((r) => matchRow(r, state.filters)).map((r) => ({ ...r }));
        tables[table] = kept;
        return removed;
      }
      if (state.insertRows != null) {
        const inserted = (Array.isArray(state.insertRows) ? state.insertRows : [state.insertRows]).map((r) => ({ ...r }));
        tables[table] = source.concat(inserted);
        return inserted.map((r) => ({ ...r }));
      }

      let rows = source.filter((r) => matchRow(r, state.filters));
      if (state.orderBy) {
        const { field, desc } = state.orderBy;
        rows = [...rows].sort((a, b) => {
          const av = a[field];
          const bv = b[field];
          if (av == null && bv == null) return 0;
          if (av == null) return desc ? 1 : -1;
          if (bv == null) return desc ? -1 : 1;
          if (av < bv) return desc ? 1 : -1;
          if (av > bv) return desc ? -1 : 1;
          return 0;
        });
      }
      if (state.limit != null) rows = rows.slice(0, state.limit);
      return rows.map((r) => ({ ...r }));
    };

    const chain = {
      select: () => chain,
      eq: (field, value) => {
        state.filters.push({ field, op: 'eq', value });
        return chain;
      },
      neq: (field, value) => {
        state.filters.push({ field, op: 'neq', value });
        return chain;
      },
      in: (field, values) => {
        state.filters.push({ field, op: 'in', value: values });
        return chain;
      },
      is: (field, value) => {
        state.filters.push({ field, op: 'is', value });
        return chain;
      },
      not: (field, op, value) => {
        state.filters.push({ field, op, value, negate: true });
        return chain;
      },
      order: (field, opts = {}) => {
        state.orderBy = { field, desc: opts.ascending === false };
        return chain;
      },
      limit: (n) => {
        state.limit = n;
        return chain;
      },
      maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
      single: () => {
        const rows = run();
        return Promise.resolve(
          rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: 'Aucune ligne trouvée' } },
        );
      },
      then: (resolve, reject) => Promise.resolve({ data: run(), error: null }).then(resolve, reject),
      update: (patch) => buildChain(table, { patch }),
      insert: (rows) => buildChain(table, { insertRows: rows }),
      delete: () => buildChain(table, { deleteOp: true }),
    };
    return chain;
  }

  return {
    from: (table) => buildChain(table),
    rpc: () => Promise.resolve({ data: null, error: null }),
    storage: {
      from: () => ({
        upload: () => Promise.resolve({ error: null }),
        getPublicUrl: () => ({ data: { publicUrl: 'https://storage.example/object' } }),
      }),
    },
    // Introspection pour les assertions de tests (lecture directe du seed).
    __table: (name) => (tables[name] || []).map((r) => ({ ...r })),
  };
}

module.exports = { createFakeDb };
