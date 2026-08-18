const { createHttpError, requireFields } = require('../utils/http');
const { parseDataUrl } = require('../utils/images');
const { getSupabaseClient } = require('../services/supabase.service');

const ALLOWED_FOLDERS = new Set(['profiles', 'enterprises', 'products', 'campagnes', 'deliveries']);

function extFromContentType(contentType) {
  if (contentType === 'image/jpeg') return 'jpg';
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/webp') return 'webp';
  return null;
}

/**
 * Vérifie les MAGIC BYTES du buffer contre le contentType déclaré dans le
 * data URL. Le client peut déclarer n'importe quel contentType — seul le
 * contenu réel du fichier fait foi (anti-extension falsifiée / polyglotte).
 */
function imageMagicMatches(buffer, contentType) {
  if (!buffer || buffer.length < 12) return false;
  if (contentType === 'image/jpeg') {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (contentType === 'image/png') {
    return (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    );
  }
  if (contentType === 'image/webp') {
    // RIFF....WEBP
    return (
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    );
  }
  return false;
}

function storageErrorMessage(error) {
  const msg = String(error?.message || error || 'Erreur storage');
  if (msg.toLowerCase().includes('bucket') || msg.toLowerCase().includes('not found')) {
    return "Bucket Supabase Storage introuvable. Créez le bucket 'public' (voir sql/fix-otp-and-storage.sql) et définissez SUPABASE_STORAGE_BUCKET=public sur Render.";
  }
  return msg;
}

async function uploadBase64Image(req, res, next) {
  try {
    requireFields(req.body, ['dataUrl', 'folder']);
    const { dataUrl, folder } = req.body;

    if (!ALLOWED_FOLDERS.has(folder)) {
      throw createHttpError(400, 'Dossier invalide (profiles, enterprises, products, campagnes ou deliveries).');
    }

    const { contentType, base64 } = parseDataUrl(dataUrl);
    const ext = extFromContentType(contentType);
    if (!ext) {
      throw createHttpError(400, 'Format non supporté (jpeg, png, webp).');
    }

    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length || buffer.length < 32) {
      throw createHttpError(400, 'Fichier image vide.');
    }
    if (buffer.length > 8_000_000) {
      throw createHttpError(413, 'Image trop lourde (max 8MB). Réduisez la résolution ou convertissez en JPEG.');
    }
    // Le contentType du data URL est déclaré par le client : on vérifie que le
    // contenu réel du fichier correspond (magic bytes).
    if (!imageMagicMatches(buffer, contentType)) {
      throw createHttpError(400, "Format d'image invalide : le contenu ne correspond pas au type déclaré (jpeg, png, webp).");
    }

    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'public';
    const supabase = getSupabaseClient();
    const ownerKey = req.auth?.userId || 'public';
    const fileName = `${Date.now()}-${ownerKey}.${ext}`;
    const objectPath = `${folder}/${fileName}`;

    const { error: uploadError } = await supabase.storage.from(bucket).upload(objectPath, buffer, {
      contentType,
      upsert: true,
    });

    if (uploadError) {
      throw createHttpError(503, storageErrorMessage(uploadError));
    }

    const { data } = supabase.storage.from(bucket).getPublicUrl(objectPath);
    if (!data?.publicUrl) {
      throw createHttpError(500, "Impossible d'obtenir l'URL publique.");
    }

    return res.status(201).json({
      url: data.publicUrl,
      path: objectPath,
      contentType,
      size: buffer.length,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { uploadBase64Image };
