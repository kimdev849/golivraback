const sharp = require('sharp');
const path = require('path');

/**
 * Overlay GoLivra watermark sur une image.
 *
 * Le watermark est un texte "GoLivra" en blanc semi-transparent avec
 * un fond sombre, placé dans le coin bas-droit de l'image.
 *
 * @param {Buffer} inputBuffer - Buffer de l'image source (JPEG/PNG/WEBP)
 * @param {Object} [options]
 * @param {number} [options.opacity=0.35] - Opacité du watermark (0-1)
 * @param {number} [options.fontSize=24] - Taille du texte en pixels
 * @returns {Promise<Buffer>} Buffer de l'image avec watermark
 */
async function addWatermark(inputBuffer, options = {}) {
  try {
    const image = sharp(inputBuffer);
    const metadata = await image.metadata();
    const width = metadata.width || 800;
    const height = metadata.height || 600;

    // Taille du watermark proportionnelle à l'image (min 18px, max ~40px)
    const wmFontSize = Math.max(18, Math.min(40, Math.round(width / 18)));
    const wmText = 'GoLivra';

    // Créer le SVG du watermark
    const textWidth = wmText.length * wmFontSize * 0.62;
    const paddingX = 10;
    const paddingY = 6;
    const boxWidth = Math.round(textWidth + paddingX * 2);
    const boxHeight = Math.round(wmFontSize + paddingY * 2);

    const svgWatermark = Buffer.from(`
      <svg width="${boxWidth}" height="${boxHeight}" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="0" width="${boxWidth}" height="${boxHeight}"
              rx="6" ry="6" fill="rgba(0,0,0,0.6)" />
        <text x="${paddingX}" y="${wmFontSize + paddingY - 3}"
              font-family="Arial, Helvetica, sans-serif"
              font-size="${wmFontSize}" font-weight="bold" font-style="italic"
              fill="white">${wmText}</text>
      </svg>
    `);

    // Position : coin bas-droit avec marge (entiers pour Sharp)
    const margin = Math.max(12, Math.round(width / 40));
    const left = Math.round(width - boxWidth - margin);
    const top = Math.round(height - boxHeight - margin);

    const watermarked = await image
      .composite([{
        input: svgWatermark,
        left,
        top,
      }])
      .toBuffer();

    console.log(`[watermark] ✅ Watermark appliqué (${width}x${height}, font=${wmFontSize}px)`);
    return watermarked;
    } catch (err) {
    // En cas d'erreur, retourner le buffer original sans watermark
    console.warn('[watermark] Erreur ajout watermark, image originale conservée:', err?.message);
    return inputBuffer;
  }
}

/**
 * Vérifie si le dossier nécessite un watermark.
 * Seuls les produits et les campagnes sont watermarkés.
 */
function shouldWatermark(folder) {
  return folder === 'products' || folder === 'campagnes';
}

module.exports = { addWatermark, shouldWatermark };
