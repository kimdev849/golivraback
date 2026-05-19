const { getDb } = require('../config/db');
const {
  getCartForUser,
  replaceCartFromSegments,
  clearCartForUser,
} = require('../services/cart.service');

async function getMine(req, res, next) {
  try {
    const db = getDb();
    const cart = await getCartForUser(db, req.auth.userId);
    return res.json(cart);
  } catch (error) {
    return next(error);
  }
}

async function replace(req, res, next) {
  try {
    const { segments } = req.body;
    const db = getDb();
    const cart = await replaceCartFromSegments(db, req.auth.userId, segments);
    return res.json(cart);
  } catch (error) {
    return next(error);
  }
}

async function clear(req, res, next) {
  try {
    const db = getDb();
    const cart = await clearCartForUser(db, req.auth.userId);
    return res.json(cart);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getMine,
  replace,
  clear,
};
