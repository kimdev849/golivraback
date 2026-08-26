/**
 * Shared user resolution utilities.
 *
 * Ces fonctions sont utilisées par :
 *   - incident.service.js
 *   - incident-workflow.service.js
 *   - delivery-monitor.service.js
 *   - admin-notify.service.js (via notifyUserSafe)
 *
 * Évite la duplication du code et garantit une logique unique.
 */

/**
 * Résout l'utilisateur propriétaire d'un commerce (restaurant ou boutique).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {string|null} restaurantId
 * @param {string|null} boutiqueId
 * @returns {Promise<string|null>} L'ID de l'utilisateur propriétaire, ou null
 */
async function resolveVendorUserId(db, restaurantId, boutiqueId) {
  if (restaurantId) {
    const { data } = await db
      .from('restaurants')
      .select('proprietaire_id')
      .eq('id', restaurantId)
      .maybeSingle();
    return data?.proprietaire_id || null;
  }
  if (boutiqueId) {
    const { data } = await db
      .from('boutiques')
      .select('proprietaire_id')
      .eq('id', boutiqueId)
      .maybeSingle();
    return data?.proprietaire_id || null;
  }
  return null;
}

/**
 * Résout l'utilisateur livreur à partir de son ID livreurs.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {string|null} livreurId
 * @returns {Promise<string|null>} L'ID de l'utilisateur livreur, ou null
 */
async function resolveCourierUserId(db, livreurId) {
  if (!livreurId) return null;
  const { data } = await db
    .from('livreurs')
    .select('utilisateur_id')
    .eq('id', livreurId)
    .maybeSingle();
  return data?.utilisateur_id || null;
}

module.exports = { resolveVendorUserId, resolveCourierUserId };
