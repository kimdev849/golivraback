/**
 * Service de géolocalisation par adresse IP.
 * Utilise geoip-lite (base de données locale, sans API externe).
 * Fallback silencieux vers Congo si échec.
 */

const geoip = require('geoip-lite');

const FALLBACK_PAYS = { nom: 'Congo', code_iso2: 'CG', code_iso3: 'COG' };

/** Détection du pays à partir d'une adresse IP. */
async function detectLocationByIp(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === '::ffff:127.0.0.1') {
    return { pays: FALLBACK_PAYS, ip };
  }

  // Nettoyer l'IP (enlever le port si présent)
  const cleanIp = String(ip).replace(/:\d+$/, '').replace(/^::ffff:/, '');
  
  try {
    const geo = geoip.lookup(cleanIp);
    if (geo && geo.country) {
      return {
        pays: {
          nom: geo.country,  // nom complet dispo via geoip-lite
          code_iso2: geo.country,
          code_iso3: '',  // non fourni par geoip-lite
        },
        ip: cleanIp,
        ville: null,  // geoip-lite ne fournit pas la ville
        latitude: geo.ll ? geo.ll[0] : null,
        longitude: geo.ll ? geo.ll[1] : null,
      };
    }
  } catch {
    // Fallback silencieux
  }

  return { pays: FALLBACK_PAYS, ip: cleanIp };
}

module.exports = { detectLocationByIp };
