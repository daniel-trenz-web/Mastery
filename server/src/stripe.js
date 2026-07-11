'use strict';
// Schlanker Stripe-REST-Client — ohne npm-SDK, nur fetch + crypto.
// Aktiv nur, wenn STRIPE_SECRET gesetzt ist (sonst manueller Rechnungs-Modus).
//
// Deckt ab, was das Modul×MA-Abo braucht:
//  - Checkout Session (mode=subscription) für Erstkauf (Karte + SEPA-Lastschrift)
//  - dynamische Preise (price_data bzw. Price-Objekt) — 5×3-Matrix ohne Vorab-Anlage
//  - Subscription-Item-Update mit Proration für den Upsell (Modul dazubuchen)
//  - Webhook-Signaturprüfung (HMAC-SHA256, Stripe-Schema `t=…,v1=…`)

const crypto = require('crypto');
const cfg = require('./config');

// Transport ist überschreibbar (Tests injizieren einen Stub statt echtem fetch).
let _transport = null;
function setTransport(fn) { _transport = fn; }
function transport() {
  return _transport || ((url, opts) => fetch(url, opts));
}

function isConfigured() { return !!cfg.STRIPE_SECRET; }

// Stripe erwartet application/x-www-form-urlencoded mit eckigen-Klammer-Pfaden
// für verschachtelte Objekte/Arrays: a[b]=1&items[0][price]=…
function formEncode(obj, prefix, out) {
  out = out || [];
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val === undefined || val === null) continue;
    const k = prefix ? prefix + '[' + key + ']' : key;
    if (Array.isArray(val)) {
      val.forEach((v, i) => {
        if (v !== null && typeof v === 'object') formEncode(v, k + '[' + i + ']', out);
        else out.push(encodeURIComponent(k + '[' + i + ']') + '=' + encodeURIComponent(v));
      });
    } else if (val !== null && typeof val === 'object') {
      formEncode(val, k, out);
    } else {
      out.push(encodeURIComponent(k) + '=' + encodeURIComponent(val));
    }
  }
  return out.join('&');
}

async function request(method, path, params) {
  if (!isConfigured()) throw Object.assign(new Error('stripe-not-configured'), { code: 'not-configured' });
  const url = cfg.STRIPE_API_URL.replace(/\/$/, '') + path;
  const opts = {
    method,
    headers: {
      Authorization: 'Bearer ' + cfg.STRIPE_SECRET,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2024-06-20',
    },
  };
  if (params && method !== 'GET') opts.body = formEncode(params);
  const r = await transport()(url, opts);
  const text = await r.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch (_e) { json = { raw: text }; }
  if (r.status >= 400) {
    const msg = (json && json.error && json.error.message) || ('stripe-http-' + r.status);
    throw Object.assign(new Error(msg), { status: r.status, stripe: json && json.error });
  }
  return json;
}

// --- Objekte -----------------------------------------------------------------
function createCustomer({ email, name, tenantId }) {
  return request('POST', '/v1/customers', {
    email, name,
    metadata: { tenantId: tenantId || '' },
  });
}

// Immutabler Preis (monatlich, EUR) zu einem Betrag — für Subscription-Items,
// da diese eine Price-ID brauchen (price_data geht dort nicht).
function createPrice({ amountEur, productName }) {
  return request('POST', '/v1/prices', {
    currency: cfg.STRIPE_CURRENCY,
    unit_amount: Math.round(Number(amountEur) * 100),
    recurring: { interval: 'month' },
    product_data: { name: productName || 'werkflow Abo' },
  });
}

// Erstkauf: gehostete Checkout-Seite (mode=subscription). Preis dynamisch via
// price_data — keine Vorab-Anlage der 15 Matrix-Preise nötig.
function createCheckoutSession({ amountEur, productName, quantity, tenantId, customerEmail, customerId, successUrl, cancelUrl, metadata }) {
  const params = {
    mode: 'subscription',
    payment_method_types: cfg.STRIPE_PAYMENT_METHODS,
    line_items: [{
      quantity: quantity || 1,
      price_data: {
        currency: cfg.STRIPE_CURRENCY,
        unit_amount: Math.round(Number(amountEur) * 100),
        recurring: { interval: 'month' },
        product_data: { name: productName || 'werkflow Abo' },
      },
    }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    subscription_data: { metadata: Object.assign({ tenantId: tenantId || '' }, metadata || {}) },
    metadata: Object.assign({ tenantId: tenantId || '' }, metadata || {}),
    allow_promotion_codes: false,
  };
  if (customerId) params.customer = customerId;
  else if (customerEmail) params.customer_email = customerEmail;
  return request('POST', '/v1/checkout/sessions', params);
}

function retrieveSubscription(subId) {
  return request('GET', '/v1/subscriptions/' + encodeURIComponent(subId));
}

// Upsell: das (einzige) Item der Subscription auf einen neuen Preis heben,
// anteilig (Proration) — Stripe rechnet die Restlaufzeit gut/nach.
async function updateSubscriptionPrice({ subscriptionId, amountEur, productName }) {
  const sub = await retrieveSubscription(subscriptionId);
  const item = sub && sub.items && sub.items.data && sub.items.data[0];
  if (!item) throw new Error('subscription-item-missing');
  const price = await createPrice({ amountEur, productName });
  return request('POST', '/v1/subscriptions/' + encodeURIComponent(subscriptionId), {
    items: [{ id: item.id, price: price.id }],
    proration_behavior: 'create_prorations',
    payment_behavior: 'allow_incomplete',
  });
}

function cancelSubscription(subId) {
  return request('DELETE', '/v1/subscriptions/' + encodeURIComponent(subId));
}

// --- Webhook-Signaturprüfung (Stripe-Schema) --------------------------------
// Header: `t=<unix>,v1=<hexsig>[,v0=…]`; signiert wird `${t}.${rawBody}` mit
// dem Endpoint-Secret (whsec_…) als HMAC-SHA256-Schlüssel.
function verifyWebhook(rawBody, sigHeader, opts) {
  const secret = (opts && opts.secret) || cfg.STRIPE_WEBHOOK_SECRET;
  const tolerance = (opts && opts.toleranceSec != null) ? opts.toleranceSec : cfg.STRIPE_WEBHOOK_TOLERANCE_SEC;
  const nowSec = (opts && opts.nowSec != null) ? opts.nowSec : Math.floor(Date.now() / 1000);
  if (!secret) throw Object.assign(new Error('no-webhook-secret'), { code: 'no-secret' });
  if (!sigHeader) throw Object.assign(new Error('no-signature'), { code: 'bad-sig' });
  const parts = {};
  for (const kv of String(sigHeader).split(',')) {
    const i = kv.indexOf('=');
    if (i > 0) { const k = kv.slice(0, i).trim(); (parts[k] = parts[k] || []).push(kv.slice(i + 1).trim()); }
  }
  const t = parts.t && parts.t[0];
  const sigs = parts.v1 || [];
  if (!t || !sigs.length) throw Object.assign(new Error('bad-signature-header'), { code: 'bad-sig' });
  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const expected = crypto.createHmac('sha256', secret).update(t + '.' + payload, 'utf8').digest('hex');
  const expBuf = Buffer.from(expected, 'hex');
  const match = sigs.some((s) => {
    let sBuf; try { sBuf = Buffer.from(s, 'hex'); } catch (_e) { return false; }
    return sBuf.length === expBuf.length && crypto.timingSafeEqual(sBuf, expBuf);
  });
  if (!match) throw Object.assign(new Error('signature-mismatch'), { code: 'bad-sig' });
  if (tolerance > 0 && Math.abs(nowSec - Number(t)) > tolerance) {
    throw Object.assign(new Error('timestamp-out-of-tolerance'), { code: 'expired' });
  }
  try { return JSON.parse(payload); } catch (_e) {
    throw Object.assign(new Error('invalid-json'), { code: 'bad-json' });
  }
}

// Testhilfe: signierten Header zu einem Payload erzeugen (nur für Tests/Tooling).
function signPayload(rawBody, secret, tSec) {
  const t = tSec != null ? tSec : Math.floor(Date.now() / 1000);
  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const sig = crypto.createHmac('sha256', secret).update(t + '.' + payload, 'utf8').digest('hex');
  return 't=' + t + ',v1=' + sig;
}

module.exports = {
  isConfigured, request, formEncode,
  createCustomer, createPrice, createCheckoutSession,
  retrieveSubscription, updateSubscriptionPrice, cancelSubscription,
  verifyWebhook, signPayload, setTransport,
};
