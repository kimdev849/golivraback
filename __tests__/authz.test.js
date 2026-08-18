/**
 * Tests d'autorisation (BOLA / IDOR) — scénarios critiques issus de l'audit.
 *
 * Ces tests exécutent les ROUTES RÉELLES (middlewares + contrôleurs + services)
 * avec la base remplacée par un fake en mémoire : ils verrouillent le
 * comportement de sécurité — une future modification qui casse un filtre par
 * propriétaire fera échouer un test.
 */
const request = require('supertest');
const { buildApp } = require('./helpers/test-app');
const { user, merge } = require('./helpers/seed');

describe('Authentification (middleware)', () => {
  test('sans token → 401', async () => {
    const app = buildApp({});
    const res = await request(app).get('/api/orders');
    expect(res.status).toBe(401);
  });

  test('token invalide → 401', async () => {
    const seed = merge(user('client', 'token-ok', { id: 'uA' }));
    const app = buildApp(seed);
    const res = await request(app).get('/api/orders').set('Authorization', 'Bearer token-faux');
    expect(res.status).toBe(401);
  });

  test('session révoquée → 401', async () => {
    const seed = merge(user('client', 'token-revoque', { id: 'uA' }));
    seed.sessions[0].revoque = true;
    const app = buildApp(seed);
    const res = await request(app).get('/api/orders').set('Authorization', 'Bearer token-revoque');
    expect(res.status).toBe(401);
  });

  test('mauvais rôle → 403 (route vendeur avec un client)', async () => {
    const seed = merge(user('client', 'token-client', { id: 'uA' }));
    const app = buildApp(seed);
    const res = await request(app).get('/api/orders/vendor/mine').set('Authorization', 'Bearer token-client');
    expect(res.status).toBe(403);
  });

  test('admin → accès autorisé (détails d’une livraison quelconque)', async () => {
    const seed = merge(
      user('admin', 'token-admin', { id: 'uAdmin' }),
      {
        livraisons: [{ id: 'livX', statut: 'en_attente', livreur_id: null, sous_commande_id: 'scX' }],
        sous_commandes: [{ id: 'scX', commande_id: 'cmdX', boutique_id: 'boutX' }],
        commandes: [{ id: 'cmdX', client_id: 'uB', statut: 'en_attente' }],
        sous_commande_items: [],
        utilisateurs: [{ id: 'uB', nom: 'Client B', telephone: '0600000099', role_id: 1 }],
        boutiques: [{ id: 'boutX', nom: 'Boutique X', proprietaire_id: 'uV' }],
        paiements: [],
      },
    );
    const app = buildApp(seed);
    const res = await request(app).get('/api/delivery/livX/details').set('Authorization', 'Bearer token-admin');
    expect(res.status).toBe(200);
  });
});

describe('Commandes — client A ne doit pas toucher les commandes de B', () => {
  const base = () =>
    merge(
      user('client', 'token-A', { id: 'uA' }),
      user('client', 'token-B', { id: 'uB' }),
      {
        commandes: [
          { id: 'cmdA', client_id: 'uA', statut: 'en_attente', created_at: '2026-01-01T00:00:00Z' },
          { id: 'cmdB', client_id: 'uB', statut: 'en_attente', created_at: '2026-01-01T00:00:00Z' },
        ],
        sous_commandes: [],
        sous_commande_items: [],
        avis_restaurants: [],
        avis_boutiques: [],
        livraisons: [],
        paiements: [],
      },
    );

  test('A lit SA commande → 200', async () => {
    const app = buildApp(base());
    const res = await request(app).get('/api/orders/cmdA').set('Authorization', 'Bearer token-A');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('cmdA');
  });

  test('A lit la commande de B → 404', async () => {
    const app = buildApp(base());
    const res = await request(app).get('/api/orders/cmdB').set('Authorization', 'Bearer token-A');
    expect(res.status).toBe(404);
  });

  test('A liste ses commandes : uniquement les siennes', async () => {
    const app = buildApp(base());
    const res = await request(app).get('/api/orders').set('Authorization', 'Bearer token-A');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.map((c) => c.id)).toEqual(['cmdA']);
  });

  test('A annule SA commande → 200', async () => {
    const app = buildApp(base());
    const res = await request(app).post('/api/orders/cmdA/cancel').set('Authorization', 'Bearer token-A');
    expect(res.status).toBe(200);
  });

  test('A annule la commande de B → 404', async () => {
    const app = buildApp(base());
    const res = await request(app).post('/api/orders/cmdB/cancel').set('Authorization', 'Bearer token-A');
    expect(res.status).toBe(404);
  });
});

describe('Produits — marchand A ne doit pas toucher la boutique B', () => {
  const base = () =>
    merge(
      user('commercant', 'token-MA', { id: 'uMA' }),
      user('commercant', 'token-MB', { id: 'uMB' }),
      {
        boutiques: [
          { id: 'boutA', nom: 'Boutique A', proprietaire_id: 'uMA' },
          { id: 'boutB', nom: 'Boutique B', proprietaire_id: 'uMB' },
        ],
        restaurants: [],
        articles: [{ id: 'prodA', boutique_id: 'boutA', nom: 'Produit A', prix: 1000 }],
        categories_produits: [],
        categories_boutiques: [],
        parametres_systeme: [],
      },
    );

  test('A crée un produit dans SA boutique → 201', async () => {
    const app = buildApp(base());
    const res = await request(app)
      .post('/api/products/enterprise/boutA')
      .set('Authorization', 'Bearer token-MA')
      .send({ nom: 'Nouveau produit', prix: 2500 });
    expect(res.status).toBe(201);
  });

  test('A crée un produit dans la boutique B → 403', async () => {
    const app = buildApp(base());
    const res = await request(app)
      .post('/api/products/enterprise/boutB')
      .set('Authorization', 'Bearer token-MA')
      .send({ nom: 'Intrusion', prix: 500 });
    expect(res.status).toBe(403);
  });

  test('A modifie un produit de la boutique B → 403', async () => {
    const app = buildApp(base());
    const res = await request(app)
      .patch('/api/products/enterprise/boutB/prodB')
      .set('Authorization', 'Bearer token-MA')
      .send({ prix: 1 });
    expect(res.status).toBe(403);
  });

  test('A modifie un produit de SA boutique → 200', async () => {
    const app = buildApp(base());
    const res = await request(app)
      .patch('/api/products/enterprise/boutA/prodA')
      .set('Authorization', 'Bearer token-MA')
      .send({ prix: 1200 });
    expect(res.status).toBe(200);
  });
});

describe('Livraisons — livreur A ne doit pas toucher les courses de B', () => {
  const base = () =>
    merge(
      user('livreur', 'token-LA', { id: 'uLA' }),
      user('livreur', 'token-LB', { id: 'uLB' }),
      user('client', 'token-C', { id: 'uC' }),
      {
        livreurs: [
          {
            id: 'livA',
            utilisateur_id: 'uLA',
            est_disponible: true,
            est_approuve: true,
            entreprise_logistique_id: null,
            disponibilite_bloquee_entreprise: false,
          },
          {
            id: 'livB',
            utilisateur_id: 'uLB',
            est_disponible: true,
            est_approuve: true,
            entreprise_logistique_id: null,
            disponibilite_bloquee_entreprise: false,
          },
        ],
        livraisons: [
          { id: 'livA1', statut: 'attribuee', livreur_id: 'livA', sous_commande_id: 'scA' },
          { id: 'livB1', statut: 'attribuee', livreur_id: 'livB', sous_commande_id: 'scB' },
          { id: 'livOpen', statut: 'en_attente', livreur_id: null, sous_commande_id: 'scOpen' },
        ],
        sous_commandes: [
          { id: 'scA', commande_id: 'cmdA', boutique_id: 'boutA' },
          { id: 'scB', commande_id: 'cmdB', boutique_id: 'boutB' },
          { id: 'scOpen', commande_id: 'cmdC', boutique_id: 'boutA' },
        ],
        commandes: [
          { id: 'cmdA', client_id: 'uC', statut: 'en_attente' },
          { id: 'cmdB', client_id: 'uC', statut: 'en_attente' },
          { id: 'cmdC', client_id: 'uC', statut: 'en_attente' },
        ],
        sous_commande_items: [],
        boutiques: [{ id: 'boutA', nom: 'Boutique A', proprietaire_id: 'uMA' }],
        utilisateurs: [{ id: 'uC', nom: 'Client', telephone: '0600000001', role_id: 1 }],
        paiements: [],
      },
    );

  test('A avance SA course (attribuee → en_collecte) → 200', async () => {
    const app = buildApp(base());
    const res = await request(app)
      .post('/api/delivery/courier/advance/livA1')
      .set('Authorization', 'Bearer token-LA');
    expect(res.status).toBe(200);
  });

  test('A avance la course de B → 404', async () => {
    const app = buildApp(base());
    const res = await request(app)
      .post('/api/delivery/courier/advance/livB1')
      .set('Authorization', 'Bearer token-LA');
    expect(res.status).toBe(404);
  });

  test('double acceptation d’une même course : une seule réussit', async () => {
    // Seed dédié : les deux livreurs n'ont AUCUNE mission active (sinon le
    // garde « terminez votre course » renvoie 409 — comportement voulu, mais
    // ce test cible la course atomique à l'acceptation).
    const seed = merge(
      user('livreur', 'token-LA', { id: 'uLA' }),
      user('livreur', 'token-LB', { id: 'uLB' }),
      {
        livreurs: [
          {
            id: 'livA',
            utilisateur_id: 'uLA',
            est_disponible: true,
            est_approuve: true,
            entreprise_logistique_id: null,
            disponibilite_bloquee_entreprise: false,
          },
          {
            id: 'livB',
            utilisateur_id: 'uLB',
            est_disponible: true,
            est_approuve: true,
            entreprise_logistique_id: null,
            disponibilite_bloquee_entreprise: false,
          },
        ],
        livraisons: [{ id: 'livOpen', statut: 'en_attente', livreur_id: null, sous_commande_id: 'scOpen' }],
        sous_commandes: [{ id: 'scOpen', commande_id: 'cmdC', boutique_id: 'boutA' }],
        commandes: [{ id: 'cmdC', client_id: 'uC', statut: 'en_attente' }],
        sous_commande_items: [],
        boutiques: [{ id: 'boutA', nom: 'Boutique A', proprietaire_id: 'uMA' }],
        utilisateurs: [{ id: 'uC', nom: 'Client', telephone: '0600000001', role_id: 1 }],
        paiements: [],
      },
    );
    const app = buildApp(seed);

    const first = await request(app)
      .post('/api/delivery/courier/accept/livOpen')
      .set('Authorization', 'Bearer token-LA');
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/api/delivery/courier/accept/livOpen')
      .set('Authorization', 'Bearer token-LB');
    expect(second.status).toBe(409);
  });

describe('Export RGPD (data-export) — uniquement SES données, jamais de secrets', () => {
  const base = () =>
    merge(
      user('client', 'token-A', { id: 'uA' }),
      {
        adresses: [
          { id: 'addrA', utilisateur_id: 'uA', libelle: 'Maison', quartier: 'Moungali' },
          { id: 'addrB', utilisateur_id: 'uB', libelle: 'Bureau', quartier: 'Poto-Poto' },
        ],
        commandes: [{ id: 'cmdA', client_id: 'uA', statut: 'livree' }],
        sous_commandes: [],
        paiements: [],
        favoris_produits: [],
        avis_restaurants: [],
        avis_boutiques: [],
        notifications: [],
        sessions: [],
        roles: [{ id: 1, nom: 'client' }],
        restaurants: [],
        boutiques: [],
        articles: [],
        plats: [],
        livreurs: [],
        livraisons: [],
      },
    );

  test('sans token → 401', async () => {
    const app = buildApp(base());
    const res = await request(app).get('/api/auth/data-export');
    expect(res.status).toBe(401);
  });

  test('renvoie SES données (adresses et commandes de A uniquement)', async () => {
    const app = buildApp(base());
    const res = await request(app).get('/api/auth/data-export').set('Authorization', 'Bearer token-A');
    expect(res.status).toBe(200);
    expect(res.body.profil.id).toBe('uA');
    expect(res.body.adresses.map((a) => a.id)).toEqual(['addrA']);
    expect(res.body.commandes.map((c) => c.id)).toEqual(['cmdA']);
  });

  test('n’exporte jamais de secret (hash, token, ip)', async () => {
    const app = buildApp(base());
    const res = await request(app).get('/api/auth/data-export').set('Authorization', 'Bearer token-A');
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/mot_de_passe_hash|token_hash|ip_address/);
  });
});

  test('un client ne peut pas accepter de course → 403', async () => {
    const app = buildApp(base());
    const res = await request(app)
      .post('/api/delivery/courier/accept/livOpen')
      .set('Authorization', 'Bearer token-C');
    expect(res.status).toBe(403);
  });
});
