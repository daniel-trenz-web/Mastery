'use strict';
// Lexoffice / Lexware Office – REST-Connector (fetch-basiert, abhängigkeitsfrei).
// Der API-Key gehört dem Mandanten (pro Mandant konfiguriert, nicht global).
// Fehler-Shape wie ai.js: { ok:false, error:'api-http-<status>' | 'network' }.

const cfg = require('../config');

function baseUrl() { return (cfg.LEXOFFICE_API_URL || 'https://api.lexoffice.io').replace(/\/$/, ''); }

async function call(apiKey, method, path, body) {
  if (!apiKey) return { ok: false, error: 'not-configured' };
  try {
    const r = await fetch(baseUrl() + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + apiKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const txt = await r.text();
    let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (_e) { data = txt; }
    if (!r.ok) return { ok: false, error: 'api-http-' + r.status, data };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: 'network', message: String(e && e.message || e) };
  }
}

// Verbindung testen (Profil abrufen)
function testConnection(apiKey) { return call(apiKey, 'GET', '/v1/profile'); }

// Buchhaltungsbeleg anlegen. invoice = normalisierte Rechnung; kind = 'salesinvoice'|'purchaseinvoice'
function pushVoucher(apiKey, invoice, kind) {
  const type = kind === 'purchaseinvoice' ? 'purchaseinvoice' : 'salesinvoice';
  const gross = Number(invoice.gross || invoice.totalGross || 0);
  const net = Number(invoice.net != null ? invoice.net : gross / 1.19);
  const tax = Number(invoice.vat != null ? invoice.vat : gross - net);
  const rate = net > 0 ? Math.round((tax / net) * 100) : 19;
  const voucher = {
    type,
    voucherNumber: invoice.number || invoice.invoiceNumber || '',
    voucherDate: toLexDate(invoice.date || invoice.invoiceDate),
    totalGrossAmount: round2(gross),
    totalTaxAmount: round2(tax),
    taxType: 'gross',
    useCollectiveContact: true,
    voucherItems: [{
      amount: round2(gross),
      taxAmount: round2(tax),
      taxRatePercent: rate,
      categoryId: invoice.categoryId || undefined,
    }],
    remark: (invoice.supplier && invoice.supplier.name) || invoice.party || invoice.kundeName || '',
  };
  return call(apiKey, 'POST', '/v1/vouchers', voucher);
}

// Kontakt (Kunde/Lieferant) anlegen
function pushContact(apiKey, contact, role) {
  const roles = {};
  if (role === 'vendor') roles.vendor = {}; else roles.customer = {};
  const body = {
    version: 0,
    roles,
    company: { name: contact.name || contact.company || '' },
    addresses: contact.address ? { billing: [{ street: contact.address, city: contact.city || '', zip: contact.zip || '', countryCode: 'DE' }] } : undefined,
    emailAddresses: contact.email ? { business: [contact.email] } : undefined,
  };
  return call(apiKey, 'POST', '/v1/contacts', body);
}

function toLexDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] + 'T00:00:00.000+01:00' : new Date().toISOString();
}
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function isConfigured(apiKey) { return !!apiKey; }

module.exports = { testConnection, pushVoucher, pushContact, isConfigured };
