/**
 * Tarification livraison par zone — données admin, logique de calcul fixe.
 */

const { createHttpError } = require('../utils/http');
const { getPricingConfig } = require('./pricing.service');

let cachedPublic = null;
let cacheExpiresAt = 0;
const CACHE_MS = 60_000;

function invalidateZonesCache() {
  cachedPublic = null;
  cacheExpiresAt = 0;
}

function mapZoneRow(row) {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    price_base: Math.round(Number(row.price_base)),
    is_active: Boolean(row.is_active),
    sort_order: Number(row.sort_order) || 0,
  };
}

function mapArrondissementRow(row) {
  return {
    id: row.id,
    name: row.name,
    ville_id: row.ville_id ?? null,
    zone_id: row.zone_id ?? null,
    sort_order: Number(row.sort_order) || 0,
  };
}

function zonePriceFcfa(zone) {
  const price = Math.round(Number(zone?.price_base));
  return Number.isFinite(price) && price > 0 ? price : null;
}

async function listZones(db) {
  const { data, error } = await db
    .from('zones')
    .select('id, name, label, price_base, is_active, sort_order')
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return (data || []).map(mapZoneRow);
}

async function listArrondissements(db) {
  const { data, error } = await db
    .from('arrondissements')
    .select('id, name, ville_id, zone_id, sort_order')
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return (data || []).map(mapArrondissementRow);
}

/** Config publique (zones actives + rattachements arrondissements). */
async function getPublicZonesConfig(db) {
  const now = Date.now();
  if (cachedPublic && now < cacheExpiresAt) return cachedPublic;

  const pricing = await getPricingConfig(db);
  const fallback = Math.round(pricing.frais_livraison_base_fcfa);

  let zones = [];
  let arrondissements = [];
  try {
    zones = await listZones(db);
    arrondissements = await listArrondissements(db);
  } catch {
    zones = [];
    arrondissements = [];
  }

  const activeZones = zones.filter((z) => z.is_active);
  const zoneById = new Map(activeZones.map((z) => [z.id, z]));
  const priceByArrondissement = {};
  for (const a of arrondissements) {
    if (!a.zone_id) continue;
    const z = zoneById.get(a.zone_id);
    const price = z ? zonePriceFcfa(z) : null;
    if (price != null) priceByArrondissement[a.name] = price;
  }

  cachedPublic = {
    zones: activeZones,
    arrondissements,
    price_by_arrondissement: priceByArrondissement,
    default_price_fcfa: fallback,
  };
  cacheExpiresAt = now + CACHE_MS;
  return cachedPublic;
}

/**
 * Prix livraison pour un quartier / arrondissement (nom exact).
 * @returns {{ price_fcfa: number, zone: object|null, arrondissement: object|null }}
 */
async function resolveDeliveryPriceForQuartier(db, quartierName) {
  const name = String(quartierName || '').trim();
  const config = await getPublicZonesConfig(db);

  if (!name) {
    return {
      price_fcfa: config.default_price_fcfa,
      zone: null,
      arrondissement: null,
    };
  }

  const fromMap = config.price_by_arrondissement[name];
  if (Number.isFinite(fromMap) && fromMap >= 0) {
    const arr = config.arrondissements.find((a) => a.name === name) || null;
    const zone = arr ? config.zones.find((z) => z.id === arr.zone_id) || null : null;
    return {
      price_fcfa: Math.round(fromMap),
      zone,
      arrondissement: arr,
    };
  }

  const { data: arrRow, error } = await db
    .from('arrondissements')
    .select('id, name, zone_id, zones(id, name, label, price_base, is_active)')
    .eq('name', name)
    .maybeSingle();
  if (error) throw error;

  if (arrRow?.zone_id && arrRow?.zones && arrRow.zones.is_active !== false) {
    const price = zonePriceFcfa(arrRow.zones);
    if (price != null) {
      invalidateZonesCache();
      return {
        price_fcfa: price,
        zone: mapZoneRow(arrRow.zones),
        arrondissement: mapArrondissementRow(arrRow),
      };
    }
  }

  return {
    price_fcfa: config.default_price_fcfa,
    zone: null,
    arrondissement: arrRow ? mapArrondissementRow(arrRow) : null,
  };
}

async function getAdminZonesBoard(db) {
  const [zones, arrondissements, paysData] = await Promise.all([
    listZones(db),
    listArrondissements(db),
    db.from('pays').select('id, nom, code_iso2').order('nom', { ascending: true }),
  ]);
  if (paysData.error) throw paysData.error;

  // Récupérer les villes pour chaque pays
  const pays = await Promise.all(
    (paysData.data || []).map(async (p) => {
      const { data: villes, error: vErr } = await db
        .from('villes')
        .select('id, nom, sort_order')
        .eq('pays_id', p.id)
        .order('sort_order', { ascending: true });
      if (vErr) throw vErr;
      return {
        id: p.id,
        nom: p.nom,
        code_iso2: p.code_iso2,
        villes: (villes || []).map((v) => ({
          id: v.id,
          nom: v.nom,
          arrondissements: arrondissements
            .filter((a) => a.ville_id === v.id)
            .map((a) => ({ id: a.id, name: a.name, zone_id: a.zone_id, sort_order: a.sort_order })),
        })),
      };
    }),
  );

  // Arrondissements sans ville rattachée (legacy)
  const unlinked = arrondissements.filter((a) => !a.ville_id);

  return { zones, pays, arrondissements_unlinked: unlinked };
}

async function updateAdminZonesBoard(db, payload, adminUserId) {
  const { zones: zoneUpdates, assignments } = payload || {};
  if (!Array.isArray(zoneUpdates) || zoneUpdates.length === 0) {
    throw createHttpError(400, 'Aucune zone à mettre à jour.');
  }

  for (const z of zoneUpdates) {
    if (!z?.id) continue;
    const { data: current, error: loadErr } = await db
      .from('zones')
      .select('id, price_base, is_active')
      .eq('id', z.id)
      .maybeSingle();
    if (loadErr) throw loadErr;
    if (!current) throw createHttpError(404, `Zone introuvable : ${z.id}`);

    const nextPrice = Math.round(Number(z.price_base));
    if (!Number.isFinite(nextPrice) || nextPrice < 0) {
      throw createHttpError(400, 'Prix de zone invalide.');
    }
    const nextActive = z.is_active !== undefined ? Boolean(z.is_active) : current.is_active;
    const oldPrice = Math.round(Number(current.price_base));

    const patch = {
      price_base: nextPrice,
      is_active: nextActive,
      updated_at: new Date().toISOString(),
    };
    const { error: upErr } = await db.from('zones').update(patch).eq('id', z.id);
    if (upErr) throw upErr;

    if (oldPrice !== nextPrice) {
      const { error: histErr } = await db.from('zone_price_history').insert({
        zone_id: z.id,
        old_price: oldPrice,
        new_price: nextPrice,
        changed_by: adminUserId || null,
      });
      if (histErr) throw histErr;
    }
  }

  if (Array.isArray(assignments)) {
    for (const a of assignments) {
      if (!a?.arrondissement_id) continue;
      const zoneId =
        a.zone_id != null && String(a.zone_id).trim() !== '' ? String(a.zone_id).trim() : null;
      const { error } = await db
        .from('arrondissements')
        .update({ zone_id: zoneId, updated_at: new Date().toISOString() })
        .eq('id', a.arrondissement_id);
      if (error) throw error;
    }
  }

  invalidateZonesCache();
  const { invalidatePricingCache } = require('./pricing.service');
  if (typeof invalidatePricingCache === 'function') invalidatePricingCache();

  return getAdminZonesBoard(db);
}

module.exports = {
  invalidateZonesCache,
  listZones,
  listArrondissements,
  getPublicZonesConfig,
  resolveDeliveryPriceForQuartier,
  getAdminZonesBoard,
  updateAdminZonesBoard,
};
