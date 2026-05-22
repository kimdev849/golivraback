require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
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
const promoRoutes = require('./routes/promo.routes');
const { getDb } = require('./config/db');

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
app.use(express.json({ limit: '512kb' }));

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 200,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'GET' && req.path === '/health',
  message: { message: 'Trop de requêtes, réessayez plus tard.', code: 'RATE_LIMIT' },
});

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_OTP_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Trop de demandes OTP, réessayez plus tard.', code: 'RATE_LIMIT_OTP' },
});

app.use(generalLimiter);

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'golivra-backend' });
});

app.use('/api/otp', otpLimiter, otpRoutes);
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
app.use('/api/promo', promoRoutes);

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

app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  let message = err.message || 'Erreur interne du serveur';
  let code = httpErrorCode(status, err);

  if (!err.status && !err.statusCode && err.code) {
    if (err.code === 'PGRST116') {
      message =
        'Données en double détectées (plusieurs livraisons pour la même commande). Réessayez ou contactez le support.';
      code = 'DONNEES_DUPLICATES';
    } else if (err.code === '23505') {
      message = 'Cette ressource existe déjà (contrainte d’unicité).';
      code = 'CONFLIT_DONNEES';
    } else if (err.code === '23503') {
      message = 'Référence invalide : enregistrement lié introuvable.';
      code = 'REFERENCE_INVALIDE';
    } else if (String(err.code).startsWith('23')) {
      message = 'Les données envoyées ne respectent pas les contraintes de la base.';
      code = 'DONNEES_INVALIDES';
    } else if (status >= 500) {
      message = 'Erreur lors de l’accès aux données.';
      code = 'ERREUR_BASE';
    }
  }

  res.status(status).json({ message, code });
});

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
  } catch (e) {
    console.warn('[golivra] ensureBaseCategories:', e.message);
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
