const { getDb } = require('../config/db');
const {
  listAdminSettings,
  updateAdminSettings,
  getPublicSettings,
} = require('../services/settings.service');

async function getPublic(req, res, next) {
  try {
    const db = getDb();
    const settings = await getPublicSettings(db);
    return res.json(settings);
  } catch (error) {
    return next(error);
  }
}

async function listAdmin(req, res, next) {
  try {
    const db = getDb();
    const settings = await listAdminSettings(db);
    return res.json({ settings });
  } catch (error) {
    return next(error);
  }
}

async function updateAdmin(req, res, next) {
  try {
    const db = getDb();
    const settings = await updateAdminSettings(db, req.body, req.auth.userId);
    return res.json({ settings, message: 'Paramètres enregistrés.' });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getPublic,
  listAdmin,
  updateAdmin,
};
