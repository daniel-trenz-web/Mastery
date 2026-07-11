'use strict';
// Integrationstests der Stripe-Zahlung gegen einen gestubbten Transport
// (kein echtes Netzwerk): Checkout-Session, Webhook-Freischaltung, Upsell mit
// Proration. Läuft als eigener Prozess mit gesetzten Stripe-Keys.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'werkos-stripe-'));
process.env.WERKOS_DATA_DIR = TMP;
process.env.WERKOS_ADMIN_TOKEN = 'test-admin-token';
process.env.WERKOS_REGISTER_LIMIT = '1000';
process.env.WERKOS_LOGIN_IP_LIMIT = '1000';
// Stripe „konfiguriert" — echte Calls fängt der Transport-Stub ab.
process.env.WERKOS_STRIPE_SECRET = 'sk_test_dummy';
process.env.WERKOS_STRIPE_WEBHOOK_SECRET = 'whsec_dummy';

const { createServer } = require('../src/server');
const stripe = require('../src/stripe');

// --- Transport-Stub: fängt alle Stripe-REST-Calls ab und protokolliert sie ---
const calls = [];
stripe.setTransport(async (url, opts) => {
  const p = url.replace(/^https?:\/\/[^/]+/, '');
  calls.push({ path: p, method: opts.method, body: opts.body || '' });
  let json = {};
  if (p === '/v1/checkout/sessions') {
    json = { id: 'cs_test_1', url: 'https://checkout.stripe.test/pay/cs_test_1', customer: 'cus_test_1', subscription: 'sub_test_1' };
  } else if (p === '/v1/customers') {
    json = { id: 'cus_test_1' };
  } else if (p === '/v1/prices') {
    json = { id: 'price_test_' + calls.length };
  } else if (/^\/v1\/subscriptions\/[^/]+$/.test(p) && opts.method === 'GET') {
    json = { id: 'sub_test_1', items: { data: [{ id: 'si_test_1' }] } };
  } else if (/^\/v1\/subscriptions\/[^/]+$/.test(p)) {
    json = { id: 'sub_test_1', status: 'active' };
  }
  return { status: 200, text: async () => JSON.stringify(json) };
});

let BASE, server;
test.before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => { server.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

async function api(method, p, { body, token, headers, rawText } = {}) {
  const h = Object.assign({}, headers);
  if (token) h['Authorization'] = 'Bearer ' + token;
  let payload;
  if (rawText !== undefined) { payload = rawText; }
  else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + p, { method, headers: h, body: payload });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch (_e) { data = { raw: text }; }
  return { status: r.status, data };
}
async function register(company, email) {
  const r = await api('POST', '/api/auth/register', { body: { company, email, name: 'Inhaber', password: 'sicheres-passwort-123' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
const dbm = require('../src/db');

test('Stripe-Checkout: liefert Checkout-URL statt sofortiger Aktivierung', async () => {
  const s = await register('Stripe Plan GmbH', 'stripeplan@test.de');
  const r = await api('POST', '/api/billing/checkout', {
    token: s.accessToken,
    body: { plan: 'BETRIEB', acceptTerms: true, billing: { company: 'Stripe Plan GmbH', address: 'Weg 1', zip: '10115', city: 'Berlin', email: 'pay@test.de', payMethod: 'card' } },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.provider, 'stripe');
  assert.match(r.data.checkoutUrl, /checkout\.stripe\.test/);
  // Noch NICHT aktiv — erst nach Webhook.
  const acc = await api('GET', '/api/account', { token: s.accessToken });
  assert.equal(acc.data.tenant.plan, 'TRIAL', 'vor Zahlung bleibt es Testphase');
  // Checkout-Session mit tenant-Metadata + differenziertem Preis für BETRIEB
  // (zeiten+auftraege+geld, bis5): (20+23+28)×0.82 = 58 € → 5800 Cent.
  const sess = calls.find((c) => c.path === '/v1/checkout/sessions');
  assert.ok(sess);
  assert.ok(sess.body.includes('unit_amount%5D=5800'), 'differenzierter Paketpreis 58,00 €');
  assert.ok(sess.body.includes('sepa_debit'), 'SEPA als Zahlart aktiv');
});

test('Stripe-Webhook: checkout.session.completed (Plan) schaltet frei', async () => {
  const s = await register('Stripe Hook GmbH', 'stripehook@test.de');
  // Checkout starten (setzt pendingCheckout mit Rechnungsdaten)
  await api('POST', '/api/billing/checkout', {
    token: s.accessToken,
    body: { plan: 'BETRIEB', acceptTerms: true, billing: { company: 'Stripe Hook GmbH', address: 'Weg 2', zip: '10115', city: 'Berlin', email: 'hook@test.de', payMethod: 'card' } },
  });
  const event = {
    id: 'evt_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_1', customer: 'cus_test_1', subscription: 'sub_test_1', metadata: { tenantId: s.tenant.id, kind: 'plan', plan: 'BETRIEB' } } },
  };
  const raw = JSON.stringify(event);
  const sig = stripe.signPayload(raw, 'whsec_dummy');
  const wh = await api('POST', '/api/billing/webhook', { rawText: raw, headers: { 'Stripe-Signature': sig, 'Content-Type': 'application/json' } });
  assert.equal(wh.status, 200, JSON.stringify(wh.data));

  const acc = await api('GET', '/api/account', { token: s.accessToken });
  assert.equal(acc.data.tenant.plan, 'BETRIEB', 'nach Webhook aktiv');
  assert.equal(acc.data.tenant.status, 'active');
  // Stripe-IDs gespeichert
  const settings = dbm.getTenantSettings(s.tenant.id);
  assert.equal(settings.stripeSubscriptionId, 'sub_test_1');
  assert.equal(settings.stripeCustomerId, 'cus_test_1');
});

test('Stripe-Webhook: verfälschte Signatur → 400', async () => {
  const raw = JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed', data: { object: {} } });
  const wh = await api('POST', '/api/billing/webhook', { rawText: raw, headers: { 'Stripe-Signature': 't=1,v1=deadbeef', 'Content-Type': 'application/json' } });
  assert.equal(wh.status, 400);
  assert.equal(wh.data.error, 'invalid-signature');
});

test('Upsell mit bestehendem Abo: Modul sofort frei + Subscription-Proration', async () => {
  const s = await register('Stripe Upsell GmbH', 'stripeupsell@test.de');
  // Abo per Webhook aktivieren (wie oben) → Stripe-Sub vorhanden
  await api('POST', '/api/billing/checkout', {
    token: s.accessToken,
    body: { plan: 'START', acceptTerms: true, billing: { company: 'U', address: 'A', zip: '1', city: 'B', email: 'u@test.de', payMethod: 'card' } },
  });
  const ev = { id: 'evt_2', type: 'checkout.session.completed', data: { object: { customer: 'cus_test_1', subscription: 'sub_test_1', metadata: { tenantId: s.tenant.id, kind: 'plan', plan: 'START' } } } };
  const raw = JSON.stringify(ev);
  await api('POST', '/api/billing/webhook', { rawText: raw, headers: { 'Stripe-Signature': stripe.signPayload(raw, 'whsec_dummy'), 'Content-Type': 'application/json' } });

  const before = calls.length;
  // Upsell: geld dazubuchen (START hat nur zeiten)
  const buy = await api('POST', '/api/billing/buy-module', { token: s.accessToken, body: { module: 'geld', acceptTerms: true, employees: 3 } });
  assert.equal(buy.status, 201, JSON.stringify(buy.data));
  assert.ok(buy.data.tenant.modules.includes('geld'), 'Modul sofort freigeschaltet');
  assert.equal(buy.data.tenant.moduleStates.geld, 'on');
  // Es wurde ein neuer Preis + ein Subscription-Update aufgerufen (Proration)
  const newCalls = calls.slice(before);
  assert.ok(newCalls.some((c) => c.path === '/v1/prices' && c.method === 'POST'), 'neuer Preis angelegt');
  const upd = newCalls.find((c) => /^\/v1\/subscriptions\/sub_test_1$/.test(c.path) && c.method === 'POST');
  assert.ok(upd, 'Subscription aktualisiert');
  assert.ok(upd.body.includes('proration_behavior=create_prorations'), 'anteilige Abrechnung');
  // zeiten+geld, bis5: (20+28)×0.9 = 43 €
  assert.equal(buy.data.newMonthlyEur, 43);
});

test('Upsell ohne Abo: leitet zur Checkout-Seite (Modul erst nach Zahlung frei)', async () => {
  const s = await register('Stripe First GmbH', 'stripefirst@test.de');
  // Host setzt START (nur zeiten) ohne Stripe-Abo → einkauf ist nicht im Plan.
  await api('POST', '/api/admin/tenants/' + s.tenant.id + '/plan', { headers: { 'X-Admin-Token': 'test-admin-token' }, body: { plan: 'START' } });
  // Kein Abo → buy-module soll Checkout-URL liefern, Modul NICHT sofort freischalten
  const buy = await api('POST', '/api/billing/buy-module', { token: s.accessToken, body: { module: 'einkauf', acceptTerms: true, employees: 2 } });
  assert.equal(buy.status, 200, JSON.stringify(buy.data));
  assert.match(buy.data.checkoutUrl, /checkout\.stripe\.test/);
  const acc = await api('GET', '/api/account', { token: s.accessToken });
  assert.ok(!acc.data.tenant.modules.includes('einkauf'), 'noch nicht frei (Zahlung ausstehend)');

  // Webhook (kind=module) schaltet nach Zahlung frei
  const ev = { id: 'evt_3', type: 'checkout.session.completed', data: { object: { customer: 'cus_test_1', subscription: 'sub_test_2', metadata: { tenantId: s.tenant.id, kind: 'module', module: 'einkauf' } } } };
  const raw = JSON.stringify(ev);
  await api('POST', '/api/billing/webhook', { rawText: raw, headers: { 'Stripe-Signature': stripe.signPayload(raw, 'whsec_dummy'), 'Content-Type': 'application/json' } });
  const acc2 = await api('GET', '/api/account', { token: s.accessToken });
  assert.ok(acc2.data.tenant.modules.includes('einkauf'), 'nach Webhook freigeschaltet');
});
