/**
 * Calcul d'ETA réel basé sur la position du livreur et la distance.
 *
 * Vitesse moyenne de livraison (moto/vélo en ville africaine) :
 * - Moto : ~25 km/h (trafic moyen, feux, piétons)
 * - Vélo : ~15 km/h
 * - Pied : ~5 km/h
 *
 * On ajoute un facteur de trafic (×1.3) pour tenir compte des embouteillages.
 */

const SPEED_KMH = {
  moto: 25,
  voiture: 30,
  velo: 15,
  pied: 5,
};

const TRAFFIC_FACTOR = 1.3; // 30% de marge pour le trafic

/**
 * Calcule l'ETA en minutes basé sur la distance en km et le type de véhicule.
 * @param {number} distanceKm - Distance en km (haversine)
 * @param {string} vehicleType - 'moto' | 'voiture' | 'velo' | 'pied'
 * @returns {number} Minutes restantes estimées
 */
function etaFromDistance(distanceKm, vehicleType = 'moto') {
  if (distanceKm == null || !Number.isFinite(distanceKm) || distanceKm <= 0) return null;

  const speed = SPEED_KMH[vehicleType] || SPEED_KMH.moto;
  const effectiveSpeed = speed / TRAFFIC_FACTOR;

  // Temps en minutes, minimum 2 min, arrondi au supérieur
  const minutes = Math.max(2, Math.ceil((distanceKm / effectiveSpeed) * 60));
  return minutes;
}

/**
 * Calcule l'ETA réel pour une livraison en cours.
 *
 * @param {Object} params
 * @param {number} params.courierLat - Latitude actuelle du livreur
 * @param {number} params.courierLng - Longitude actuelle du livreur
 * @param {number} params.deliveryLat - Latitude de livraison
 * @param {number} params.deliveryLng - Longitude de livraison
 * @param {string} params.vehicleType - Type de véhicule du livreur
 * @param {string} params.courierPositionAt - Horodatage de la position du livreur
 * @returns {Object} { distanceKm, etaMinutes, arriveeEstimeeAt }
 */
function computeRealTimeEta({
  courierLat,
  courierLng,
  deliveryLat,
  deliveryLng,
  vehicleType = 'moto',
  courierPositionAt,
}) {
  // Vérifier que toutes les coordonnées sont valides
  if (
    courierLat == null || courierLng == null ||
    deliveryLat == null || deliveryLng == null ||
    !Number.isFinite(courierLat) || !Number.isFinite(courierLng) ||
    !Number.isFinite(deliveryLat) || !Number.isFinite(deliveryLng)
  ) {
    return { distanceKm: null, etaMinutes: null, arriveeEstimeeAt: null };
  }

  // Distance haversine
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(deliveryLat - courierLat);
  const dLon = toRad(deliveryLng - courierLng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(courierLat)) *
      Math.cos(toRad(deliveryLat)) *
      Math.sin(dLon / 2) ** 2;
  const distanceKm = Number((R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(2));

  // Si le livreur est très proche (< 200m), ETA = 1-2 min
  if (distanceKm < 0.2) {
    const now = new Date();
    return {
      distanceKm,
      etaMinutes: 2,
      arriveeEstimeeAt: new Date(now.getTime() + 2 * 60_000).toISOString(),
    };
  }

  const etaMinutes = etaFromDistance(distanceKm, vehicleType);

  // Arrivée estimée : maintenant + ETA
  const baseTime = courierPositionAt ? new Date(courierPositionAt) : new Date();
  const arriveeEstimeeAt = new Date(baseTime.getTime() + etaMinutes * 60_000).toISOString();

  return { distanceKm, etaMinutes, arriveeEstimeeAt };
}

module.exports = { etaFromDistance, computeRealTimeEta, SPEED_KMH, TRAFFIC_FACTOR };
