/**
 * Harnais de test : construit une app Express réelle (routes + middlewares du
 * projet) mais avec la couche Supabase remplacée par le fake-db en mémoire.
 *
 * getDb() (config/db) est mocké pour renvoyer l'instance du seed courant :
 * les contrôleurs et services réels sont donc exécutés tels quels — seules les
 * requêtes base sont simulées.
 */
jest.mock('../../config/db', () => {
  const { createFakeDb } = require('./fake-db');
  let instance = createFakeDb({});
  return {
    getDb: () => instance,
    __resetDb: (seed) => {
      instance = createFakeDb(seed || {});
    },
  };
});

const express = require('express');
const { __resetDb } = require('../../config/db');

/** Monte les routers réellement utilisés par les tests d'autorisation. */
function buildApp(seed) {
  __resetDb(seed);
  const app = express();
  app.use(express.json());
  app.use('/api/orders', require('../../routes/order.routes'));
  app.use('/api/products', require('../../routes/product.routes'));
  app.use('/api/delivery', require('../../routes/delivery.routes'));
  app.use('/api/auth', require('../../routes/auth.routes'));
  return app;
}

module.exports = { buildApp };
