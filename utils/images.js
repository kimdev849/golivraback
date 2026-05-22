const { createHttpError } = require('./http');

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    throw createHttpError(400, "Image invalide (attendu: data URL 'data:image/...;base64,...').");
  }
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw createHttpError(400, 'Image invalide (format base64 requis).');
  }
  return { contentType: match[1], base64: match[2] };
}

function byteaToBuffer(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value.length ? value : null;
  if (value instanceof Uint8Array) {
    return value.length ? Buffer.from(value) : null;
  }
  if (typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
    const buf = Buffer.from(value.data);
    return buf.length ? buf : null;
  }
  if (typeof value !== 'string' || !value.length) return null;

  const trimmed = value.trim();
  if (trimmed.startsWith('\\x')) {
    const buf = Buffer.from(trimmed.slice(2), 'hex');
    return buf.length ? buf : null;
  }
  if (trimmed.startsWith('0x')) {
    const buf = Buffer.from(trimmed.slice(2), 'hex');
    return buf.length ? buf : null;
  }

  try {
    const buf = Buffer.from(trimmed, 'base64');
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}

/** URL HTTP(S) ou data URL pour l’app mobile. */
function resolveStoredImage(urlField, byteaField, mimeField) {
  if (typeof urlField === 'string' && urlField.trim()) {
    const u = urlField.trim();
    if (u.startsWith('http://') || u.startsWith('https://')) return u;
  }

  const buf = byteaToBuffer(byteaField);
  if (buf && buf.length > 0) {
    const mime = mimeField && String(mimeField).trim() ? String(mimeField).trim() : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  }

  return null;
}

function logoFieldsFromBody(body) {
  const { imageUrl, imageDataUrl } = body || {};
  if (typeof imageUrl === 'string' && imageUrl.trim().startsWith('http')) {
    return { logo_url: imageUrl.trim(), logo: null, logo_mime: null };
  }
  if (typeof imageDataUrl === 'string' && imageDataUrl.startsWith('data:')) {
    const { contentType, base64 } = parseDataUrl(imageDataUrl);
    const logo = Buffer.from(base64, 'base64');
    if (!logo.length) {
      throw createHttpError(400, 'Fichier image vide.');
    }
    return { logo_url: null, logo, logo_mime: contentType };
  }
  /** Ne pas toucher au logo existant si aucune image n’est envoyée. */
  return {};
}

function productImageFieldsFromBody(body) {
  const { imageUrl, imageDataUrl } = body || {};
  if (typeof imageUrl === 'string' && imageUrl.trim().startsWith('http')) {
    return { image_url: imageUrl.trim(), image: null, image_mime: null };
  }
  if (typeof imageDataUrl === 'string' && imageDataUrl.startsWith('data:')) {
    const { contentType, base64 } = parseDataUrl(imageDataUrl);
    const image = Buffer.from(base64, 'base64');
    if (!image.length) {
      throw createHttpError(400, 'Fichier image vide.');
    }
    return { image_url: null, image, image_mime: contentType };
  }
  return { image_url: null, image: null, image_mime: null };
}

module.exports = {
  parseDataUrl,
  byteaToBuffer,
  resolveStoredImage,
  logoFieldsFromBody,
  productImageFieldsFromBody,
};
