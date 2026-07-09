'use strict';
// Katalog-Import: DATANORM (v4/v5, Artikel-Satz 'A') und generisches CSV.
// Liefert Artikel für den Material-/Artikelstamm. Reine Funktion.
// Hinweis: DATANORM-Feldpositionen variieren je Lieferant leicht; der Importer
// bildet die gängige Belegung ab und lässt sich per Mapping übersteuern.

function toEur(cents, priceUnit) {
  const c = parseInt(String(cents).replace(/[^\d-]/g, ''), 10);
  if (isNaN(c)) return 0;
  const pu = priceUnit && priceUnit > 0 ? priceUnit : 1;
  return Math.round((c / 100 / pu) * 10000) / 10000;
}

// DATANORM 4/5 – Artikel-Hauptsatz 'A':
// A;<VerarbKz>;<ArtNr>;<TextKz>;<Kurztext1>;<Kurztext2>;<PreisKz>;<Preis>;<Rabattgr>;<ME>;<Preiseinheit?>;...
function parseDatanorm(textStr, mapping) {
  const map = mapping || {};
  const pos = Object.assign({ artNr: 2, text1: 4, text2: 5, priceKz: 6, price: 7, unit: 9, priceUnit: 10 }, map);
  const s = String(textStr).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const out = [];
  for (const line of s.split('\n')) {
    if (!line || line[0] !== 'A') continue;
    const f = line.split(';');
    if (f[0] !== 'A') continue;
    const artNr = (f[pos.artNr] || '').trim();
    if (!artNr) continue;
    const name = [(f[pos.text1] || '').trim(), (f[pos.text2] || '').trim()].filter(Boolean).join(' ').trim();
    const priceUnit = parseInt(f[pos.priceUnit], 10);
    out.push({
      artNr,
      name: name || artNr,
      unit: (f[pos.unit] || '').trim() || 'Stk',
      priceEur: toEur(f[pos.price], isNaN(priceUnit) ? 1 : priceUnit),
      priceKind: (f[pos.priceKz] || '').trim() === '1' ? 'brutto' : 'netto',
      source: 'datanorm',
    });
  }
  return out;
}

// Generisches CSV mit Spalten-Erkennung/-Mapping.
function parseCatalogCsv(textStr, mapping) {
  const map = mapping || {};
  const rows = parseRows(textStr);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (spec, names) => {
    if (spec != null) return typeof spec === 'number' ? spec : header.indexOf(String(spec).toLowerCase());
    for (const n of names) { const i = header.findIndex((h) => h.includes(n)); if (i >= 0) return i; }
    return -1;
  };
  const iArt = idx(map.artNr, ['artikelnummer', 'artnr', 'art-nr', 'artikel-nr', 'nummer', 'sku']);
  const iName = idx(map.name, ['bezeichnung', 'name', 'kurztext', 'text', 'beschreibung']);
  const iUnit = idx(map.unit, ['einheit', 'me', 'mengeneinheit', 'unit']);
  const iPrice = idx(map.price, ['preis', 'ek', 'einkaufspreis', 'price', 'nettopreis']);
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row.length || row.every((c) => !String(c).trim())) continue;
    const artNr = iArt >= 0 ? String(row[iArt] || '').trim() : '';
    const name = iName >= 0 ? String(row[iName] || '').trim() : '';
    if (!artNr && !name) continue;
    out.push({
      artNr: artNr || '',
      name: name || artNr,
      unit: iUnit >= 0 ? (String(row[iUnit] || '').trim() || 'Stk') : 'Stk',
      priceEur: iPrice >= 0 ? parsePrice(row[iPrice]) : 0,
      priceKind: 'netto',
      source: 'csv',
    });
  }
  return out;
}
function parsePrice(v) {
  let s = String(v == null ? '' : v).replace(/[^\d.,-]/g, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : Math.round(n * 10000) / 10000;
}
function parseRows(textStr) {
  const s = String(textStr).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!s) return [];
  const first = s.split('\n')[0];
  const delim = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ',';
  return s.split('\n').map((line) => splitCsvLine(line, delim));
}
function splitCsvLine(line, delim) {
  const out = []; let f = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { out.push(f); f = ''; }
    else f += ch;
  }
  out.push(f);
  return out;
}

function parseCatalog(buffer, mediaType) {
  const s = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer);
  const head = s.slice(0, 300);
  if (/^V;|^A;A;|\nA;/.test(head) || /DATANORM/i.test(head)) return { format: 'datanorm', articles: parseDatanorm(s) };
  return { format: 'csv', articles: parseCatalogCsv(s) };
}

module.exports = { parseDatanorm, parseCatalogCsv, parseCatalog };
