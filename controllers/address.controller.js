const { getDb } = require('../config/db');
const {
  listUserAddresses,
  createUserAddress,
  updateUserAddress,
  deleteUserAddress,
  setPrincipalAddress,
} = require('../services/address.service');

async function listAddresses(req, res, next) {
  try {
    const db = getDb();
    const rows = await listUserAddresses(db, req.auth.userId);
    return res.json(rows);
  } catch (error) {
    return next(error);
  }
}

async function createAddress(req, res, next) {
  try {
    const db = getDb();
    const row = await createUserAddress(db, req.auth.userId, req.body || {});
    return res.status(201).json(row);
  } catch (error) {
    return next(error);
  }
}

async function updateAddress(req, res, next) {
  try {
    const db = getDb();
    const row = await updateUserAddress(db, req.auth.userId, req.params.addressId, req.body || {});
    return res.json(row);
  } catch (error) {
    return next(error);
  }
}

async function removeAddress(req, res, next) {
  try {
    const db = getDb();
    const result = await deleteUserAddress(db, req.auth.userId, req.params.addressId);
    return res.json(result);
  } catch (error) {
    return next(error);
  }
}

async function markPrincipal(req, res, next) {
  try {
    const db = getDb();
    const row = await setPrincipalAddress(db, req.auth.userId, req.params.addressId);
    return res.json(row);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listAddresses,
  createAddress,
  updateAddress,
  removeAddress,
  markPrincipal,
};
