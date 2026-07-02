# GolivraBack

API Node.js (Express) pour l’application **GoLivra** : authentification (OTP SMS Twilio + sessions), commandes, entreprises, produits, livraisons, administration.

## Écosystème GoLivra

| Composant | Dépôt | Description |
|-----------|-------|-------------|
| **Backend API** (ce dépôt) | [kimdev849/golivraback](https://github.com/kimdev849/golivraback) | API Node.js / Express — logique métier, auth, OTP, commandes, livraisons, paiements |
| **App Mobile** | [kimdev849/golivra](https://github.com/kimdev849/golivra) | Application mobile Expo / React Native — clients, vendeurs, livreurs |
| **Site Admin** | [kimdev849/siteadmingolivra](https://github.com/kimdev849/siteadmingolivra) | Back-office web — TanStack Start, Vite, Tailwind, Radix |

## Workflow Git

Après chaque modification du code : enregistrer les changements puis pousser sur GitHub (`git add -A`, `git commit -m "…"`, `git push origin main`).

## Prérequis

- Node.js **20+** (recommandé : **22**)
- Un projet [Supabase](https://supabase.com/) avec le schéma appliqué (`schema.sql` à la racine du dépôt). Si la base existait avant l’ajout de `entreprises.image_url`, exécuter : `ALTER TABLE entreprises ADD COLUMN IF NOT EXISTS image_url TEXT;`
- Compte [Twilio](https://www.twilio.com/) pour l’envoi des SMS OTP (**optionnel** : sans Twilio, utilisez `OTP_TEST_MODE=1` — voir ci-dessous)

## Installation locale

```bash
npm ci
cp .env.example .env
# Éditer .env avec vos clés
npm run dev
```

Santé de l’API : `GET http://localhost:3000/health`

## Variables d’environnement

| Variable | Description |
|----------|-------------|
| `PORT` | Port d’écoute (défaut : `3000`) |
| `NODE_ENV` | `development` ou `production` |
| `SUPABASE_URL` | URL du projet Supabase |
| `SUPABASE_SECRET_KEY` | Clé **secrète serveur** : `sb_secret_…` ou JWT **service_role**. **Jamais** `sb_publishable_…` (sinon : *permission denied for schema public*). |
| `SUPABASE_SERVICE_KEY` | (Optionnel) Alias historique de `SUPABASE_SECRET_KEY` si votre hébergeur utilise encore ce nom. |
| `TWILIO_ACCOUNT_SID` | SID Twilio |
| `TWILIO_AUTH_TOKEN` | Token Twilio |
| `TWILIO_FROM_NUMBER` | Numéro expéditeur SMS |
| `CORS_ORIGINS` | Origines web autorisées (virgules). En **production**, si vide : les navigateurs (requête avec `Origin`) sont **refusés** par CORS ; sans `Origin` (souvent l’app native) reste autorisé. |
| `RATE_LIMIT_MAX` | (Optionnel, **production uniquement**) Requêtes max / IP / 15 min. Défaut : `1000`. |
| `RATE_LIMIT_OTP_MAX` | (Optionnel, **production uniquement**) Requêtes max sur `/api/otp/*` / IP / 15 min. Défaut : `20`. |
| `OTP_TEST_MODE` | `1` = code OTP renvoyé dans la réponse JSON (pas de SMS). **Recommandé sans Twilio.** Mettre `0` quand Twilio est configuré. |
| `OTP_TABLE` | (Optionnel) Forcer `otp` ou `otp_codes`. Par défaut : détection automatique. |
| `SUPABASE_STORAGE_BUCKET` | Bucket Storage pour les images (`public` par défaut). Créer le bucket via `sql/fix-otp-and-storage.sql`. |
| `ENTERPRISE_AUTO_APPROVE` | `1` = commerces actifs à la création (démo). `0` = modération admin (production). |

## OTP sans Twilio (phase de test)

Tant que vous n’avez **pas encore payé / configuré Twilio** :

1. Sur **Render** → Environment → `OTP_TEST_MODE` = **`1`** (déjà dans `render.yaml`).
2. L’app appelle `POST /api/otp/request` → la réponse contient `testMode: true` et **`otpCode`** (ex. `"482913"`).
3. L’écran d’inscription mobile affiche : *« Mode test actif - code OTP: … »*.
4. Aucune variable `TWILIO_*` n’est requise.

Quand Twilio sera prêt : renseignez `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, et `TWILIO_MESSAGING_SERVICE_SID` ou `TWILIO_FROM_NUMBER`, puis passez **`OTP_TEST_MODE=0`** sur Render.

Exécutez aussi sur Supabase : `sql/fix-otp-and-storage.sql` (tables OTP + bucket images).

## Paiements (PawaPay + escrow + ledger)

Le module `payments/` orchestre :

- **Paiements client** via PawaPay (deposit) — modes `test` (simulation) et `live` (sandbox / prod)
- **Escrow** — l'argent du client est bloqué sur le wallet plateforme jusqu'à la livraison
- **Répartition post-livraison** — marchand (vente nette), livreur / entreprise logistique (frais nets), GoLivra (commission)
- **Retraits** vers Mobile Money (Airtel / MTN) — auto-approuvés pour les commerces, livreurs, gestionnaires_logistique
- **Webhooks PawaPay** signés HMAC — deposit / payout / refund
- **Jobs automatiques** : `payoutJob`, `escrowReleaseJob`
- **Registre comptable** (`ledger_entries`) — un ledger entry par mouvement, pour audit

Voir [`payments/README.md`](./payments/README.md) pour l'architecture complète et [`sql/amendments-payments-refactor.sql`](./sql/amendments-payments-refactor.sql) pour la migration à exécuter dans Supabase.

## Sécurité (production)

- **Helmet** : en-têtes HTTP renforcés ; `Content-Security-Policy` désactivé (API JSON) ; `Cross-Origin-Resource-Policy: cross-origin` pour rester compatible avec CORS / clients mobiles.
- **Rate limiting** : limite globale + limite plus basse sur les routes OTP (anti-spam SMS / brute force).
- **CORS** : en production sans `CORS_ORIGINS`, les appels **depuis un navigateur** (Expo Web, site Vercel, etc.) sont bloqués — renseignez les origines exactes (`https://…`).
- **Corps JSON** : taille plafonnée à **512 ko** par requête.

## Mise en ligne (test création de comptes, etc.)

**Important :** [GitHub](https://github.com/kimdev849/golivraback) héberge uniquement le **code**. Pour une URL publique (`https://…`), il faut un **hébergeur** qui exécute Node.

### Option recommandée — Render (gratuit pour tester)

1. Compte sur [Render](https://render.com/) (possible avec le même e-mail que GitHub, ex. `kimjaver7@gmail.com`).
2. **New** → **Blueprint** → connecter le dépôt **kimdev849/golivraback** (autoriser Render sur GitHub si demandé).
3. Render détecte `render.yaml` : valider le service **golivra-api**.
4. Renseigner les variables d’environnement (Supabase secret, Twilio, etc.) — les mêmes que dans `.env.example`, **sans** commiter de secrets.
5. Après le déploiement, noter l’URL du type `https://golivra-api.onrender.com` et tester :
   - `GET https://…/health`
   - flux OTP : `POST /api/otp/request` puis `POST /api/otp/verify`, puis `POST /api/auth/register`.

Pour l’app Expo / web : `EXPO_PUBLIC_API_BASE_URL=https://golivra-api.onrender.com` (sans `/api` à la fin).

Sur l’offre gratuite Render, le service peut « s’endormir » après inactivité ; le premier appel peut prendre ~1 minute.

## Déploiement sur Internet

### Option A — Docker

Construire et lancer :

```bash
docker build -t golivra-back .
docker run --env-file .env -p 3000:3000 golivra-back
```

Sur un hébergeur (Railway, Fly.io, Render, VPS, etc.), définissez les mêmes variables que dans `.env`, exposez le port **3000** (ou celui défini par `PORT`), et vérifiez que **HTTPS** est terminé devant le conteneur si besoin.

### Option B — Node directement

```bash
npm ci --omit=dev
NODE_ENV=production node server.js
```

Utilisez un gestionnaire de processus (**pm2**, **systemd**) et un reverse proxy (**Caddy**, **nginx**) avec TLS.

### Mobile / Expo

L’app mobile doit pointer vers l’URL publique de l’API, par exemple :

`EXPO_PUBLIC_API_BASE_URL=https://api.votredomaine.com`

(sans chemin `/api` ; les routes `/api/...` sont ajoutées par le client).

## Pousser le code sur GitHub

Dépôt cible : [https://github.com/kimdev849/golivraback](https://github.com/kimdev849/golivraback)

**Identité Git :**

```bash
git config user.email "kimdev849@gmail.com"
git config user.name "GoLivra Dev"
```

**Règle obligatoire :** Après chaque modification, commit + push automatique dans le dépôt du composant modifié :

```bash
git add <fichiers modifiés>
git commit -m "<type>: <description>"
git push origin main
```

**Préfixes de commit :** `feat:`, `fix:`, `security:`, `ui:`, `refactor:`, `docs:`, `chore:`

**Ne commitez jamais** le fichier `.env` (déjà ignoré par `.gitignore`).

## Licence

Projet privé — usage selon les conditions de l’équipe GoLivra.
