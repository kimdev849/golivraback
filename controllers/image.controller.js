const { getDb } = require('../config/db');
const { byteaToBuffer } = require('../utils/images');

// Simple in-memory LRU-ish cache: { key → { buf, mime, at } }
const IMAGE_CACHE_TTL_MS = 60_000; // 1 min
const IMAGE_CACHE_MAX = 200;
const imageCache = new Map();

function cacheGet(key) {
  const hit = imageCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > IMAGE_CACHE_TTL_MS) {
    imageCache.delete(key);
    return null;
  }
  return hit;
}

function cacheSet(key, value) {
  if (imageCache.size >= IMAGE_CACHE_MAX) {
    // Evict oldest
    const oldest = imageCache.keys().next().value;
    imageCache.delete(oldest);
  }
  imageCache.set(key, value);
}

/**
 * GET /api/images/products/:id
 * Serves the image for a plat or article by ID.
 * Tries plats first, then articles. Returns the raw bytea as the correct
 * content-type. If the product has an image_url (HTTP), redirects to it.
 * Falls back to 404 if no image is found.
 */
async function serveProductImage(req, res, next) {
  try {
    const { id } = req.params;
    if (!id || typeof id !== 'string') return res.status(400).json({ message: 'ID invalide' });

    const cacheKey = `product:${id}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.setHeader('Content-Type', cached.mime);
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      return res.send(cached.buf);
    }

    const db = getDb();

    // Try plats first — request only lightweight columns + bytea image.
    // Supabase PostgREST may silently drop bytea on large payloads, so we
    // also request image_mime as a "flag": if image_mime is truthy but
    // image is null, we know an image EXISTS but PostgREST dropped the blob.
    const { data: plat, error: platErr } = await db
      .from('plats')
      .select('image_url, image, image_mime')
      .eq('id', id)
      .maybeSingle();

    if (platErr) {
      console.error(`[Image] Error fetching plat ${id}:`, platErr.message || platErr);
    }

    if (plat) {
      const served = serveImageRow(res, plat, cacheKey);
      if (served) return served;
    }

    // Try articles
    const { data: article, error: artErr } = await db
      .from('articles')
      .select('image_url, image, image_mime')
      .eq('id', id)
      .maybeSingle();

    if (artErr) {
      console.error(`[Image] Error fetching article ${id}:`, artErr.message || artErr);
    }

    if (article) {
      const served = serveImageRow(res, article, cacheKey);
      if (served) return served;
    }

    // Fallback: try fetching just image_url + image_mime (no bytea) to check
    // if a redirect URL exists. This handles the case where PostgREST drops
    // the bytea column but the product has an HTTP image_url.
    if (!plat && !article) {
      // Try fetching the product from the product list endpoint to get image_url
      const { data: platLight } = await db
        .from('plats')
        .select('image_url, image_mime')
        .eq('id', id)
        .maybeSingle();
      if (platLight?.image_url && typeof platLight.image_url === 'string' && platLight.image_url.startsWith('http')) {
        return res.redirect(platLight.image_url);
      }

      const { data: artLight } = await db
        .from('articles')
        .select('image_url, image_mime')
        .eq('id', id)
        .maybeSingle();
      if (artLight?.image_url && typeof artLight.image_url === 'string' && artLight.image_url.startsWith('http')) {
        return res.redirect(artLight.image_url);
      }

      // If image_mime exists but we couldn't serve the image, log it for debugging
      if ((platLight?.image_mime || artLight?.image_mime) && !platLight?.image_url && !artLight?.image_url) {
        console.warn(`[Image] Product ${id} has image_mime but no image data or URL — bytea may not be accessible via PostgREST`);
      }
    }

    return res.status(404).json({ message: 'Image introuvable' });
  } catch (error) {
    console.error(`[Image] Unexpected error for product ${req.params?.id}:`, error?.message || error);
    return next(error);
  }
}

/**
 * GET /api/images/enterprises/:id
 * Serves the logo/banner image for a restaurant or boutique.
 */
async function serveEnterpriseImage(req, res, next) {
  try {
    const { id } = req.params;
    if (!id || typeof id !== 'string') return res.status(400).json({ message: 'ID invalide' });

    const cacheKey = `enterprise:${id}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.setHeader('Content-Type', cached.mime);
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      return res.send(cached.buf);
    }

    const db = getDb();

    // Try restaurants first
    const { data: restaurant, error: restErr } = await db
      .from('restaurants')
      .select('image_url, logo, logo_mime')
      .eq('id', id)
      .maybeSingle();

    if (restErr) {
      console.error(`[Image] Error fetching restaurant ${id}:`, restErr.message || restErr);
    }

    if (restaurant) {
      // If image_url is an HTTP URL, redirect
      if (restaurant.image_url && typeof restaurant.image_url === 'string' && restaurant.image_url.startsWith('http')) {
        return res.redirect(restaurant.image_url);
      }
      // Try logo bytea
      const buf = byteaToBuffer(restaurant.logo);
      if (buf && buf.length > 0) {
        const mime = restaurant.logo_mime || 'image/jpeg';
        cacheSet(cacheKey, { buf, mime, at: Date.now() });
        res.setHeader('Content-Type', mime);
        res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
        return res.send(buf);
      }
    }

    // Try boutiques
    const { data: boutique, error: boutErr } = await db
      .from('boutiques')
      .select('image_url, logo, logo_mime')
      .eq('id', id)
      .maybeSingle();

    if (boutErr) {
      console.error(`[Image] Error fetching boutique ${id}:`, boutErr.message || boutErr);
    }

    if (boutique) {
      if (boutique.image_url && typeof boutique.image_url === 'string' && boutique.image_url.startsWith('http')) {
        return res.redirect(boutique.image_url);
      }
      const buf = byteaToBuffer(boutique.logo);
      if (buf && buf.length > 0) {
        const mime = boutique.logo_mime || 'image/jpeg';
        cacheSet(cacheKey, { buf, mime, at: Date.now() });
        res.setHeader('Content-Type', mime);
        res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
        return res.send(buf);
      }
    }

    return res.status(404).json({ message: 'Image introuvable' });
  } catch (error) {
    console.error(`[Image] Unexpected error for enterprise ${req.params?.id}:`, error?.message || error);
    return next(error);
  }
}

/**
 * Serve an image row (plat or article). If image_url is an HTTP URL, redirect.
 * Otherwise, resolve bytea and serve as raw binary.
 * Returns true if a response was sent, false otherwise.
 */
function serveImageRow(res, row, cacheKey) {
  // If image_url is an HTTP URL, redirect (fast path — no DB blob needed)
  if (row.image_url && typeof row.image_url === 'string' && row.image_url.startsWith('http')) {
    res.redirect(row.image_url);
    return true;
  }

  // If image_url is a data URL, serve it directly
  if (row.image_url && typeof row.image_url === 'string' && row.image_url.startsWith('data:')) {
    const match = row.image_url.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      const mime = match[1];
      const buf = Buffer.from(match[2], 'base64');
      if (buf.length > 0) {
        cacheSet(cacheKey, { buf, mime, at: Date.now() });
        res.setHeader('Content-Type', mime);
        res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
        res.send(buf);
        return true;
      }
    }
  }

  // Resolve bytea image
  const buf = byteaToBuffer(row.image);
  if (buf && buf.length > 0) {
    const mime = row.image_mime || 'image/jpeg';
    cacheSet(cacheKey, { buf, mime, at: Date.now() });
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.send(buf);
    return true;
  }

  // No image data available
  return false;
}

module.exports = { serveProductImage, serveEnterpriseImage };
