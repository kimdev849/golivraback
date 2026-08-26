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
  const { opacity = 0.35, fontSize = 24 } = options;

  try {
    const image = sharp(inputBuffer);
    const metadata = await image.metadata();
    const width = metadata.width || 800;
    const height = metadata.height || 600;

    // Taille du watermark proportionnelle à l'image
    const wmFontSize = Math.max(14, Math.min(fontSize, Math.round(width / 20)));
    const wmText = 'GoLivra';

    // Créer le SVG du watermark
    const textWidth = wmText.length * wmFontSize * 0.6;
    const padding = 8;
    const boxWidth = textWidth + padding * 2;
    const boxHeight = wmFontSize + padding * 2;

    const svgWatermark = Buffer.from(`
      <svg width="${boxWidth}" height="${boxHeight}" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="0" width="${boxWidth}" height="${boxHeight}"
              rx="4" ry="4" fill="rgba(0,0,0,0.55)" />
        <text x="${padding}" y="${wmFontSize + padding - 4}"
              font-family="Arial, Helvetica, sans-serif"
              font-size="${wmFontSize}" font-weight="bold" font-style="italic"
              fill="white" opacity="0.9">${wmText}</text>
      </svg>
    `);

    // Position : coin bas-droit avec une marge
    const margin = Math.max(8, Math.round(width / 50));
    const left = width - boxWidth - margin;
    const top = height - boxHeight - margin;

    const watermarked = await image
      .composite([{
        input: svgWatermark,
        left,
        top,
      }])
      .toBuffer();

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
