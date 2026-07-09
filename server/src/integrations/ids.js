'use strict';
// IDS-Connect (Handwerk↔Großhandel Punchout): das System öffnet den Webshop des
// Händlers mit einem Formular-POST; der Kunde füllt dort den Warenkorb; der Shop
// sendet den Warenkorb an unsere HOOK_URL zurück. Wir wandeln ihn in eine
// Bestellung. Reine Funktionen (keine Netzwerkaufrufe).

// Baut die Formulardaten, um den Shop im Punchout-Modus zu öffnen.
// connection: { shopUrl, kundenNr, username, password, extra? }
// opts: { hookUrl } — Rücksprung-URL für den Warenkorb
function buildPunchout(connection, opts) {
  const c = connection || {}, o = opts || {};
  const fields = {
    action: 'GetShoppingCart',
    HOOK_URL: o.hookUrl || '',
    USERNAME: c.username || '',
    PASSWORD: c.password || '',
    KDNR: c.kundenNr || '',
    // IDS 2.5 Standardfelder; leere werden vom Shop ignoriert
    RETURNTARGET: '_top',
  };
  if (c.extra && typeof c.extra === 'object') Object.assign(fields, c.extra);
  return { url: c.shopUrl || '', method: 'POST', fields };
}

// Parst den zurückgesendeten Warenkorb. Akzeptiert entweder ein bereits geparstes
// Feld-Objekt (application/x-www-form-urlencoded) oder eine IDS/OrderResponse-XML.
function parseBasketReturn(input, contentType) {
  const ct = (contentType || '').toLowerCase();
  if (typeof input === 'string' && (ct.includes('xml') || /<[\w:]*Order|<IDS|<Basket/i.test(input.slice(0, 200)))) {
    return parseBasketXml(input);
  }
  const fields = typeof input === 'string' ? parseUrlencoded(input) : (input || {});
  return parseBasketFields(fields);
}

function parseUrlencoded(body) {
  const out = {};
  const sp = new URLSearchParams(String(body || ''));
  for (const [k, v] of sp.entries()) out[k] = v;
  return out;
}

// Indexierte Felder: ARTNR[1], MENGE[1] … oder ARTNR1 / ARTNR_1
function parseBasketFields(fields) {
  const rows = {};
  const norm = (k) => k.toUpperCase().replace(/[\[\]_.\s]/g, '');
  const keyFor = {
    ARTNR: 'artNr', ARTIKELNR: 'artNr', ARTICLENUMBER: 'artNr', ARTICLE: 'artNr', BESTELLNR: 'artNr',
    MENGE: 'qty', QTY: 'qty', QUANTITY: 'qty', ANZAHL: 'qty',
    PREIS: 'price', PRICE: 'price', EP: 'price', EINZELPREIS: 'price',
    KURZTEXT: 'name', TEXT: 'name', NAME: 'name', BEZEICHNUNG: 'name', DESCRIPTION: 'name',
    ME: 'unit', MENGENEINHEIT: 'unit', UNIT: 'unit', EINHEIT: 'unit',
  };
  for (const rawKey of Object.keys(fields || {})) {
    const nk = norm(rawKey);
    const mIdx = nk.match(/^([A-Z]+?)(\d+)$/);
    if (!mIdx) continue;
    const base = mIdx[1], idx = mIdx[2];
    const target = keyFor[base];
    if (!target) continue;
    (rows[idx] = rows[idx] || {})[target] = fields[rawKey];
  }
  const positions = Object.keys(rows).sort((a, b) => Number(a) - Number(b)).map((idx) => normalizePos(rows[idx]));
  return { ok: positions.length > 0, positions, count: positions.length };
}

function parseBasketXml(xmlStr) {
  const xml = require('../xml');
  const root = xml.parseXml(xmlStr);
  // Gängige Positions-Container in IDS/OrderResponse
  let items = xml.findAll(root, 'ITEM');
  if (!items.length) items = xml.findAll(root, 'Item');
  if (!items.length) items = xml.findAll(root, 'Position');
  if (!items.length) items = xml.findAll(root, 'OrderItem');
  const positions = items.map((it) => normalizePos({
    artNr: xml.text(it, 'ARTNR') || xml.text(it, 'ArticleNumber') || xml.text(it, 'Artikelnummer') || xml.text(it, 'SupplierAID'),
    qty: xml.text(it, 'MENGE') || xml.text(it, 'Quantity') || xml.text(it, 'Menge'),
    unit: xml.text(it, 'ME') || xml.text(it, 'Unit') || xml.text(it, 'Mengeneinheit'),
    price: xml.text(it, 'PREIS') || xml.text(it, 'Price') || xml.text(it, 'Preis'),
    name: xml.text(it, 'KURZTEXT') || xml.text(it, 'Description') || xml.text(it, 'Kurztext') || xml.text(it, 'Name'),
  })).filter((p) => p.artNr || p.name);
  return { ok: positions.length > 0, positions, count: positions.length };
}

function normalizePos(p) {
  return {
    artNr: String(p.artNr == null ? '' : p.artNr).trim(),
    name: String(p.name == null ? '' : p.name).trim(),
    qty: num(p.qty),
    unit: String(p.unit == null ? '' : p.unit).trim() || 'Stk',
    price: num(p.price),
  };
}
function num(v) {
  if (v == null) return 0;
  let s = String(v).replace(/[^\d.,-]/g, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

module.exports = { buildPunchout, parseBasketReturn, parseBasketFields, parseUrlencoded };
