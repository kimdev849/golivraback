require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth.routes');
const otpRoutes = require('./routes/otp.routes');
const orderRoutes = require('./routes/order.routes');
const deliveryRoutes = require('./routes/delivery.routes');
const enterpriseRoutes = require('./routes/enterprise.routes');
const productRoutes = require('./routes/product.routes');
const adminRoutes = require('./routes/admin.routes');
const logisticsRoutes = require('./routes/logistics.routes');
const uploadRoutes = require('./routes/upload.routes');
const reviewRoutes = require('./routes/review.routes');
const addressRoutes = require('./routes/address.routes');
const walletRoutes = require('./routes/wallet.routes');
const notificationRoutes = require('./routes/notification.routes');
const favoritesRoutes = require('./routes/favorites.routes');
const cartRoutes = require('./routes/cart.routes');
const settingsRoutes = require('./routes/settings.routes');
const zonesRoutes = require('./routes/zones.routes');
const locationRoutes = require('./routes/location.routes');
const promoRoutes = require('./routes/promo.routes');
const campaignsRoutes = require('./routes/campaigns.routes');
const observabilityRoutes = require('./routes/observability.routes');
const observabilityAdminRoutes = require('./routes/observability-admin.routes');
const usageAdminRoutes = require('./routes/usage-admin.routes');
const usageTrackingRoutes = require('./routes/usage-tracking.routes');
const pawapayWebhookRoutes = require('./routes/pawapay-webhook.routes');
const paymentRoutes = require('./payments/routes/payment.routes');
const payoutRoutes = require('./payments/routes/payout.routes');
const adminPayoutRoutes = require('./payments/routes/admin-payout.routes');
const sandboxRoutes = require('./payments/routes/sandbox.routes');
const paymentsPawapayWebhookRoutes = require('./payments/routes/pawapay-webhook.routes');
const { requestContextMiddleware } = require('./middlewares/request-context.middleware');
const { getDb } = require('./config/db');
const paymentsScheduler = require('./payments/jobs/scheduler');
const pawapayService = require('./payments/services/pawapay.service');

const app = express();

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false,
  }),
);

function isLocalDevOrigin(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin);
}

/** Apps GoLivra hébergées sur Render (admin, vitrine, etc.). */
function isRenderAppOrigin(origin) {
  return /^https:\/\/[\w-]+\.onrender\.com$/i.test(origin);
}

const corsOptions = {
  credentials: true,
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }
    if (isLocalDevOrigin(origin)) {
      return callback(null, true);
    }
    if (isRenderAppOrigin(origin)) {
      return callback(null, true);
    }
    const raw = process.env.CORS_ORIGINS;
    const isProd = process.env.NODE_ENV === 'production';
    if (!raw || !raw.trim()) {
      if (isProd) {
        return callback(null, false);
      }
      return callback(null, true);
    }
    const allowed = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowed.includes(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  },
};

app.use(cors(corsOptions));
// Compression gzip de toutes les réponses JSON : le feed de produits et les
// listes de commandes sont textuels → payload souvent 3-5× plus léger, latence
// et bande passante réduites (gain visible sur les réseaux mobiles du Congo).
app.use(compression());
// Limite généreuse : les images sont envoyées en base64 (un JPEG 8 Mo ≈ 11 Mo base64).
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ limit: '30mb', extended: true }));
app.use(requestContextMiddleware);

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'golivra-backend' });
});

app.use('/webhooks/pawapay', paymentsPawapayWebhookRoutes);
// Conserve l'ancien routeur pour rétro-compat (certains clients envoient encore dessus)
app.use('/webhooks/pawapay-legacy', pawapayWebhookRoutes);

const isDev = process.env.NODE_ENV !== 'production';

// ── Rate Limiting ──────────────────────────────────────────────────────
// Désactivé complètement en développement pour éviter le blocage.
// En production : 1000 req / 15 min par IP (configurable via RATE_LIMIT_MAX).
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 0 : (Number(process.env.RATE_LIMIT_MAX) || 1000),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    if (req.method === 'GET' && req.path === '/health') return true;
    if (typeof req.path === 'string' && req.path.startsWith('/webhooks/')) return true;
    if (isDev) return true;
    return false;
  },
  message: { message: 'Trop de requêtes, réessayez plus tard.', code: 'RATE_LIMIT' },
});

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 0 : (Number(process.env.RATE_LIMIT_OTP_MAX) || 50),
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isDev,
  message: { message: 'Trop de demandes OTP, réessayez plus tard.', code: 'RATE_LIMIT_OTP' },
});

// Anti brute force connexion : 30 tentatives / 15 min par IP (configurable
// via RATE_LIMIT_LOGIN_MAX). Complète le limiteur OTP — l'authentification
// (client + staff) ne doit pas être testable à l'infini.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 0 : (Number(process.env.RATE_LIMIT_LOGIN_MAX) || 30),
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isDev,
  message: { message: 'Trop de tentatives de connexion, réessayez plus tard.', code: 'RATE_LIMIT_LOGIN' },
});

// N'appliquer le limiter global qu'en production
if (!isDev) {
  app.use(generalLimiter);
} else {
  console.log('[golivra] Mode développement : rate limiting désactivé.');
}

app.use('/api/otp', otpLimiter, otpRoutes);
// Rate limiting dédié sur la connexion (client + back-office) :
// 30 tentatives / 15 min par IP, indépendant du limiteur général.
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/staff/login', loginLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/delivery', deliveryRoutes);
app.use('/api/enterprises', enterpriseRoutes);
app.use('/api/products', productRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/logistics', logisticsRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/favorites', favoritesRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/zones', zonesRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/promo', promoRoutes);
app.use('/api/campaigns', campaignsRoutes);
app.use('/api/observability', observabilityRoutes);
app.use('/api/admin/observability', observabilityAdminRoutes);
app.use('/api/admin/usage', usageAdminRoutes);
app.use('/api/track', usageTrackingRoutes);

// ── Module Paiements (escrow, ledger, payouts, webhooks) ────────────────────
// Note : la route POST /api/orders/:orderId/pay reste dans order.routes.js
// et délègue désormais au nouveau service via le wrapper payment.service.
app.use('/api', payoutRoutes);
app.use('/api/admin', adminPayoutRoutes);
app.use('/api/admin', sandboxRoutes);

function httpErrorCode(status, err) {
  const raw = err.code;
  if (raw && typeof raw === 'string' && !/^\d/.test(raw)) {
    return raw;
  }
  if (status === 400) return 'REQUETE_INVALIDE';
  if (status === 401) return 'NON_AUTORISE';
  if (status === 403) return 'INTERDIT';
  if (status === 404) return 'INTROUVABLE';
  if (status === 409) return 'CONFLIT';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'ERREUR_SERVEUR';
  return 'ERREUR';
}

app.use((err, req, res, _next) => {
  const { normalizeSupabaseError } = require('./utils/supabase-errors');
  const { recordIncidentAsync, incidentFromHttpError } = require('./services/observability.service');
  const normalized = normalizeSupabaseError(err);
  const status = normalized.status;
  const message = normalized.message;
  const code = normalized.code || httpErrorCode(status, err);

  if (process.env.NODE_ENV !== 'production' && err?.code) {
    console.error('[API]', err.code, err.message, err.details || '');
  }

  // Un 503 « règle métier » (feature flag coupé par l'admin, kill switch…) est
  // volontaire : on ne crée pas d'incident technique dessus.
  const isBusinessRule = err?.business === true || err?.code === 'FEATURE_DISABLED';
  const shouldRecord =
    !isBusinessRule &&
    (status >= 500 || (status >= 400 && status !== 401 && !String(req.originalUrl || '').includes('/observability/report')));

  if (shouldRecord) {
    recordIncidentAsync(
      incidentFromHttpError(
        { ...err, message, code, status },
        req,
        { source: 'backend', metadata: { code, details: err.details || null } },
      ),
    );
  }

  res.status(status).json({
    message,
    code,
    ...(normalized.details ? { details: normalized.details } : {}),
    requestId: req.requestId || null,
  });
});

const GLOBAL_PRODUIT_CATEGORIES = [
  ['Vêtements', 1],
  ['Véhicules', 2],
  ['Appareils électroniques', 3],
  ['Maison', 4],
  ['Rénovation intérieure', 5],
  ['Sports', 6],
  ['Jeux et jouets', 7],
  ['Beauté et soins', 8],
  ['Alimentation', 9],
  ['Boissons', 10],
  ['Fournitures de bureau', 11],
  ['Jardin et extérieur', 12],
  ['Instruments de musique', 13],
  ['Articles gratuits', 14],
  ['Autres', 99],
];

const GLOBAL_MENU_CATEGORIES = [
  ['Pizzas & Pâtes', 1],
  ['Burgers & Fast-food', 2],
  ['Grillades & Brochettes', 3],
  ['Poulet', 4],
  ['Poissons & Fruits de mer', 5],
  ['Plats africains', 6],
  ['Sandwichs', 7],
  ['Desserts & Pâtisseries', 8],
  ['Boissons & Jus', 9],
  ['Soupes', 10],
  ['Autres', 99],
];

const RESTAURANT_CATEGORIES = [
  ['Restaurant africain', 1],
  ['Fast Food', 2],
  ['Grillades & Brochettes', 3],
  ['Pizza & Pasta', 4],
  ['Boulangerie & Pâtisserie', 5],
  ['Jus & Boissons', 6],
  ['Cuisine asiatique', 7],
  ['Végétarien', 8],
  ['Autre', 99],
];

const BOUTIQUE_CATEGORIES = [
  ['Épicerie & Alimentation', 1],
  ['Pharmacie', 2],
  ['Supermarché', 3],
  ['Mode & Vêtements', 4],
  ['Électronique', 5],
  ['Beauté & Soins', 6],
  ['Maison & Déco', 7],
  ['Librairie & Papeterie', 8],
  ['Sport', 9],
  ['Autre', 99],
];

async function ensureCategoryRows(db, table, rows) {
  for (const [nom, ordre] of rows) {
    const { data } = await db.from(table).select('id').eq('nom', nom).maybeSingle();
    if (!data) {
      const { error } = await db.from(table).insert({ nom, ordre, est_active: true });
      if (error) console.warn(`[golivra] Impossible d'insérer la catégorie ${nom} (${table}):`, error.message);
    }
  }
}

async function ensureBaseCategories() {
  const db = getDb();
  try {
    await ensureCategoryRows(db, 'categories_restaurants', RESTAURANT_CATEGORIES);
    await ensureCategoryRows(db, 'categories_boutiques', BOUTIQUE_CATEGORIES);
    // Référentiel global du catalogue : GoLivra organise, le vendeur choisit.
    // Idempotent — la migration amendments-categories-globales.sql crée les
    // tables sur les bases existantes avant tout appel à ce seed.
    await ensureCategoryRows(db, 'categories_produits', GLOBAL_PRODUIT_CATEGORIES);
    await ensureCategoryRows(db, 'categories_menus', GLOBAL_MENU_CATEGORIES);
  } catch (e) {
    const msg = String(e?.message || e);
    console.warn('[golivra] ensureBaseCategories:', msg);
    // Si les tables globales n'existent pas, la liste des catégories est vide
    // côté vendeur : on guide vers la migration au lieu d'échouer en silence.
    if (/categories_produits|categories_menus|relation .* does not exist/i.test(msg)) {
      console.warn(
        '[golivra] ⚠️ Tables de catégories globales absentes en base. ' +
          'Lancez : cd golivraback && npm run migrate:categories ' +
          '(ou collez sql/amendments-categories-globales.sql dans Supabase SQL Editor).',
      );
    }
  }
}

async function ensureBaseRoles() {
  const db = getDb();
  try {
    const { error } = await db.rpc('ensure_base_roles');
    if (!error) return;
    console.warn('[golivra] RPC ensure_base_roles indisponible, insertion manuelle des rôles :', error.message);
  } catch (e) {
    console.warn('[golivra] RPC ensure_base_roles exception :', e.message);
  }

  const requiredRoles = [
    'client',
    'restaurateur',
    'commercant',
    'admin',
    'livreur',
    'gestionnaire_logistique',
  ];
  for (const roleName of requiredRoles) {
    const { data } = await db.from('roles').select('id').eq('nom', roleName).maybeSingle();
    if (!data) {
      const { error: insErr } = await db.from('roles').insert({
        nom: roleName,
        description: roleName,
      });
      if (insErr) {
        console.warn(`[golivra] Impossible d'insérer le rôle ${roleName}:`, insErr.message);
        if (roleName === 'gestionnaire_logistique' && /enum|invalid input value/i.test(insErr.message || '')) {
          console.error(
            '[golivra] Migration v4 requise : exécutez sql/amendments-v4-logistics-tenant.sql (étape 1 seule) dans Supabase SQL Editor, puis amendments-v4-logistics-tenant-step2.sql.',
          );
        }
      }
    }
  }

  const { data: gestRole } = await db
    .from('roles')
    .select('id')
    .eq('nom', 'gestionnaire_logistique')
    .maybeSingle();
  if (!gestRole) {
    console.error(
      '[golivra] Rôle gestionnaire_logistique manquant — création d\'entreprise de livraison impossible tant que la migration v4 n\'est pas appliquée (voir sql/amendments-v4-logistics-tenant.sql).',
    );
  }
}

async function startServer() {
  if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGINS?.trim()) {
    console.warn(
      '[golivra] CORS_ORIGINS vide : localhost et *.onrender.com restent autorisés. Ajoutez d’autres domaines si besoin (ex. app mobile web).',
    );
  }
  await ensureBaseRoles();
  await ensureBaseCategories();
  const observabilityScheduler = require('./services/observability-scheduler.service');
  observabilityScheduler.start();
  pawapayService.logConfig();
  paymentsScheduler.start();
  // ── Delivery incident monitor (every 5 min) ──────────────────────────────
  const { monitorActiveDeliveries } = require('./services/delivery-monitor.service');
  const MONITOR_INTERVAL_MS = 5 * 60 * 1000;
  setInterval(() => {
    monitorActiveDeliveries().catch((err) => {
      console.error('[delivery-monitor] Error:', err?.message || err);
    });
  }, MONITOR_INTERVAL_MS);
  // Run once on startup (after 30s to let DB connect)
  setTimeout(() => {
    monitorActiveDeliveries().catch((err) => {
      console.error('[delivery-monitor] Startup run error:', err?.message || err);
    });
  }, 30_000);

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    const env = process.env.NODE_ENV || 'development';
    console.log(`API démarrée sur le port ${PORT} (NODE_ENV=${env})`);
  });
}

startServer().catch((error) => {
  console.error('Impossible de démarrer le serveur :', error.message);
  process.exit(1);
});
