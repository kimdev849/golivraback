const twilio = require('twilio');

function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    throw new Error('Identifiants Twilio non configurés');
  }

  return twilio(accountSid, authToken);
}

function formatTwilioSendError(err) {
  const code = err && err.code != null ? err.code : null;
  const status = err && err.status != null ? err.status : null;
  const base = (err && err.message) || String(err);
  const parts = [base];
  if (code != null) parts.push(`code Twilio: ${code}`);
  if (status != null) parts.push(`HTTP ${status}`);
  return parts.join(' — ');
}

/**
 * Envoie un SMS. Préférez TWILIO_MESSAGING_SERVICE_SID en prod (meilleure délivrabilité).
 * Sinon utilisez TWILIO_FROM_NUMBER (numéro Twilio en E.164 ou alphanumérique selon règles Twilio).
 */
async function sendSms(to, body) {
  const messagingServiceSid = (process.env.TWILIO_MESSAGING_SERVICE_SID || '').trim();
  const from = (process.env.TWILIO_FROM_NUMBER || '').trim();

  if (!messagingServiceSid && !from) {
    throw new Error('TWILIO_MESSAGING_SERVICE_SID ou TWILIO_FROM_NUMBER requis');
  }

  const client = getTwilioClient();
  const payload = { to, body };

  if (messagingServiceSid) {
    payload.messagingServiceSid = messagingServiceSid;
  } else {
    payload.from = from;
  }

  try {
    return await client.messages.create(payload);
  } catch (err) {
    throw new Error(formatTwilioSendError(err));
  }
}

module.exports = {
  sendSms,
};
