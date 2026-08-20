/**
 * Service d'envoi de push notifications via l'API Expo Push Service.
 * Fonctionne pour Android (FCM) et iOS (APNs) sans configuration Firebase/APNs manuelle.
 *
 * Prérequis :
 *  - Table `push_tokens` créée en DB (voir sql/push-tokens-migration.sql)
 *  - EXPO_ACCESS_TOKEN défini dans .env (optionnel mais recommandé en prod)
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Enregistre ou met à jour un token push pour un utilisateur.
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {string} userId
 * @param {string} token  - ExponentPushToken[xxx] ou FCM/APNs direct
 * @param {string} platform - 'ios' | 'android' | 'web'
 */
async function registerToken(db, userId, token, platform) {
  const { error } = await db
    .from('push_tokens')
    .upsert(
      { utilisateur_id: userId, token, platform, updated_at: new Date().toISOString() },
      { onConflict: 'utilisateur_id,token' },
    );
  if (error) throw error;
}

/**
 * Supprime un token push (lors du logout).
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {string} userId
 * @param {string} token
 */
async function unregisterToken(db, userId, token) {
  const { error } = await db
    .from('push_tokens')
    .delete()
    .eq('utilisateur_id', userId)
    .eq('token', token);
  if (error) throw error;
}

/**
 * Supprime tous les tokens d'un utilisateur (reset complet).
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {string} userId
 */
async function unregisterAllTokensForUser(db, userId) {
  const { error } = await db
    .from('push_tokens')
    .delete()
    .eq('utilisateur_id', userId);
  if (error) throw error;
}

/**
 * Récupère tous les tokens d'un utilisateur.
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {string} userId
 * @returns {Promise<Array<{token: string, platform: string}>>}
 */
async function getTokensForUser(db, userId) {
  const { data, error } = await db
    .from('push_tokens')
    .select('token, platform')
    .eq('utilisateur_id', userId);
  if (error) throw error;
  return data || [];
}

/**
 * Récupère les tokens de plusieurs utilisateurs en une seule requête.
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {string[]} userIds
 * @returns {Promise<Array<{utilisateur_id: string, token: string, platform: string}>>}
 */
async function getTokensForUsers(db, userIds) {
  if (!userIds.length) return [];
  const { data, error } = await db
    .from('push_tokens')
    .select('utilisateur_id, token, platform')
    .in('utilisateur_id', userIds);
  if (error) throw error;
  return data || [];
}

/**
 * Envoie un message push à l'API Expo.
 * @param {Array<{to: string, title: string, body: string, data?: object, sound?: string, badge?: number}>} messages
 */
/** Tokens Expo jugés invalides par l'API — on les supprime de la DB. */
const INVALID_TOKEN_MESSAGES = new Set([
  'DeviceNotRegistered',
  'InvalidCredentials',
]);

/**
 * Supprime un token push de la DB (appelé quand Expo le déclare invalide).
 * Ne lève jamais d'erreur.
 */
async function removeInvalidToken(db, token) {
  try {
    const { error } = await db.from('push_tokens').delete().eq('token', token);
    if (error) console.warn('[push] impossible de supprimer le token invalide:', error.message);
    else console.log('[push] Token invalide supprimé de la DB:', token.slice(0, 30));
  } catch (err) {
    console.warn('[push] removeInvalidToken error:', err?.message || err);
  }
}

async function sendToExpoApi(messages, db) {
  if (!messages.length) return;

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate',
  };

  const accessToken = process.env.EXPO_ACCESS_TOKEN;
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(messages),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('[push] Expo API erreur:', res.status, text);
      return;
    }

    const result = await res.json();

    // Log des erreurs de ticket + nettoyage des tokens invalides
    if (result?.data && Array.isArray(result.data)) {
      for (let i = 0; i < result.data.length; i++) {
        const ticket = result.data[i];
        if (ticket.status === 'error') {
          const token = messages[i]?.to ?? 'unknown';
          console.warn(`[push] Ticket erreur pour token ${token.slice(0, 30)}:`, ticket.message);
          // Token device désenregistré ou credentials expirés → supprimer de la DB
          // pour éviter de re-télécharger inutilement à chaque push.
          if (db && INVALID_TOKEN_MESSAGES.has(ticket.message) && token) {
            void removeInvalidToken(db, token);
          }
        }
      }
    }
  } catch (err) {
    console.error('[push] Erreur réseau Expo API:', err?.message || err);
  }
}

/**
 * Construit les messages push à envoyer.
 * @param {Array<{utilisateur_id: string, token: string}>} tokenRows
 * @param {{title: string, body: string, data?: object, sound?: string}} payload
 * @returns {Array<object>}
 */
function buildMessages(tokenRows, payload) {
  return tokenRows
    .filter((r) => r.token && r.token.startsWith('ExponentPushToken'))
    .map((r) => ({
      to: r.token,
      title: payload.title,
      body: payload.body,
      data: payload.data || {},
      sound: payload.sound ?? 'default',
      priority: 'high',
      channelId: 'golivra-default',
    }));
}

/**
 * Envoie une push notification à un utilisateur.
 * Fire-and-forget : ne lève pas d'erreur si le push échoue.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {string} userId
 * @param {{title: string, body: string, data?: object}} payload
 */
async function sendPushToUser(db, userId, payload) {
  try {
    const tokens = await getTokensForUser(db, userId);
    const messages = buildMessages(tokens, payload);
    if (messages.length) await sendToExpoApi(messages, db);
  } catch (err) {
    console.warn('[push] sendPushToUser failed:', err?.message || err);
  }
}

/**
 * Envoie une push notification à plusieurs utilisateurs (batch).
 * Fire-and-forget.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {string[]} userIds
 * @param {{title: string, body: string, data?: object}} payload
 */
async function sendPushToUsers(db, userIds, payload) {
  if (!userIds.length) return;
  try {
    const tokenRows = await getTokensForUsers(db, userIds);
    const messages = buildMessages(tokenRows, payload);
    if (messages.length) await sendToExpoApi(messages, db);
  } catch (err) {
    console.warn('[push] sendPushToUsers failed:', err?.message || err);
  }
}

module.exports = {
  registerToken,
  unregisterToken,
  unregisterAllTokensForUser,
  getTokensForUser,
  getTokensForUsers,
  sendPushToUser,
  sendPushToUsers,
};
