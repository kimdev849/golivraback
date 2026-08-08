const { getDb } = require('../config/db');
const {
  createExternalDelivery,
  listVendorExternalDeliveries,
  getExternalDeliveryPaymentStatus,
} = require('../services/external-delivery.service');

async function createVendorExternalDelivery(req, res, next) {
  try {
    const db = getDb();
    const body = req.body || {};
    const result = await createExternalDelivery(db, req.auth.userId, {
      establishmentId: body.establishmentId,
      establishmentType: body.establishmentType,
      clientNom: body.clientNom,
      clientTelephone: body.clientTelephone,
      adresse: body.adresse,
      adresseText: body.adresseLivraison,
      note: body.note,
      methodePaiement: body.methodePaiement,
      telephonePaiement: body.telephonePaiement,
    });
    return res.status(201).json(result);
  } catch (error) {
    return next(error);
  }
}

async function getExternalDeliveryPaymentStatusHandler(req, res, next) {
  try {
    const db = getDb();
    const status = await getExternalDeliveryPaymentStatus(db, req.params.deliveryId);
    return res.json(status);
  } catch (error) {
    return next(error);
  }
}

async function listVendorExternalDeliveriesHandler(req, res, next) {
  try {
    const db = getDb();
    const activeOnly = req.query.active !== 'false';
    const rows = await listVendorExternalDeliveries(db, req.auth.userId, { activeOnly });
    return res.json(rows);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  createVendorExternalDelivery,
  listVendorExternalDeliveriesHandler,
  getExternalDeliveryPaymentStatusHandler,
};
