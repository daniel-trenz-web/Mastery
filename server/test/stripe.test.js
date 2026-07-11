'use strict';
// Unit-Tests für den Stripe-Client (ohne Netzwerk): Form-Encoding + Webhook-
// Signaturprüfung nach Stripe-Schema.

const test = require('node:test');
const assert = require('node:assert');

// Keys VOR dem Laden setzen, damit isConfigured() greift.
process.env.WERKOS_STRIPE_SECRET = 'sk_test_dummy';
process.env.WERKOS_STRIPE_WEBHOOK_SECRET = 'whsec_dummy';
const stripe = require('../src/stripe');

test('formEncode: verschachtelte Objekte + Arrays im Stripe-Format', () => {
  const enc = stripe.formEncode({
    mode: 'subscription',
    line_items: [{ quantity: 2, price_data: { unit_amount: 4900, recurring: { interval: 'month' } } }],
    metadata: { tenantId: 't_1', kind: 'plan' },
  });
  assert.ok(enc.includes('mode=subscription'));
  assert.ok(enc.includes('line_items%5B0%5D%5Bquantity%5D=2'));
  assert.ok(enc.includes('line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=4900'));
  assert.ok(enc.includes('line_items%5B0%5D%5Bprice_data%5D%5Brecurring%5D%5Binterval%5D=month'));
  assert.ok(enc.includes('metadata%5BtenantId%5D=t_1'));
  // null/undefined werden ausgelassen
  assert.ok(!stripe.formEncode({ a: null, b: undefined, c: 1 }).includes('a='));
});

test('verifyWebhook: gültige Signatur wird akzeptiert, verfälschte/abgelaufene abgelehnt', () => {
  const secret = 'whsec_dummy';
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });
  const t = 1_700_000_000;
  const header = stripe.signPayload(body, secret, t);

  const ev = stripe.verifyWebhook(body, header, { secret, nowSec: t });
  assert.equal(ev.type, 'checkout.session.completed');

  // Manipulierter Body → Mismatch
  assert.throws(() => stripe.verifyWebhook(body + ' ', header, { secret, nowSec: t }), /signature-mismatch/);
  // Falsches Secret → Mismatch
  assert.throws(() => stripe.verifyWebhook(body, header, { secret: 'whsec_other', nowSec: t }), /signature-mismatch/);
  // Außerhalb der Toleranz → abgelehnt
  assert.throws(() => stripe.verifyWebhook(body, header, { secret, nowSec: t + 10_000 }), /tolerance/);
  // Fehlender Header → abgelehnt
  assert.throws(() => stripe.verifyWebhook(body, '', { secret, nowSec: t }), /no-signature/);
});

test('signPayload erzeugt Header, der zu verifyWebhook passt (Round-Trip)', () => {
  const secret = 'whsec_dummy';
  const body = Buffer.from('{"x":1}', 'utf8');
  const header = stripe.signPayload(body, secret, 42);
  assert.match(header, /^t=42,v1=[0-9a-f]{64}$/);
  const ev = stripe.verifyWebhook(body, header, { secret, nowSec: 42 });
  assert.deepEqual(ev, { x: 1 });
});
