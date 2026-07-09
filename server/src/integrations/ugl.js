'use strict';
// UGL-Schnittstelle (Handwerk ↔ Großhandel, SHK/Elektro): satzbasiertes Flatfile
// für Bestellung (BES), Auftragsbestätigung (AB) und Rechnung (RG).
// Feste Feldbreiten je Satzart (UGL-4.0-Stil). Lieferantenspezifische Abweichungen
// werden über die Feldbreiten-Tabelle konfiguriert. Reine Funktion.
//
// Satzarten:
//   100 Vorlaufsatz   : version, kundenNr, lieferantenNr, datum(YYYYMMDD), uhrzeit(HHMMSS)
//   200 Belegkopf     : belegart(BES/AB/RG), belegNr, belegdatum, kommission
//   300 Positionssatz : posNr, artikelNr, menge(×1000), einheit, preis(Cent), text
//   900 Summensatz    : anzahlPositionen, summeNetto(Cent)

function padR(s, n) { return String(s == null ? '' : s).slice(0, n).padEnd(n, ' '); }
function padL(s, n) { return String(s == null ? '' : s).slice(0, n).padStart(n, '0'); }
function intField(v, n) { return padL(Math.round(Number(v) || 0), n); }

function buildUglOrder(order, meta) {
  const m = meta || {};
  const now = m.now instanceof Date ? m.now : new Date();
  const p2 = (x) => String(x).padStart(2, '0');
  const datum = m.datum || (now.getFullYear() + p2(now.getMonth() + 1) + p2(now.getDate()));
  const uhr = m.uhrzeit || (p2(now.getHours()) + p2(now.getMinutes()) + p2(now.getSeconds()));
  const lines = [];
  // 100 Vorlauf
  lines.push('100' + padR('4.0', 5) + padR(m.kundenNr || '', 15) + padR(m.lieferantenNr || order.lieferantenNr || '', 15) + datum + uhr);
  // 200 Belegkopf
  lines.push('200' + padR('BES', 3) + padR(order.number || '', 15) + datum + padR(order.kommission || '', 30));
  // 300 Positionen
  let net = 0;
  (order.items || []).forEach((it, i) => {
    const priceCent = Math.round((Number(it.price) || 0) * 100);
    net += Math.round((Number(it.qty) || 0) * priceCent);
    lines.push('300' + padL(it.nr != null ? it.nr : i + 1, 6) + padR(it.articleNo || it.artNr || '', 20)
      + intField((Number(it.qty) || 0) * 1000, 10) + padR(it.unit || 'Stk', 4)
      + intField(priceCent, 10) + padR(it.name || '', 40));
  });
  // 900 Summe
  lines.push('900' + padL((order.items || []).length, 6) + intField(net, 12));
  return lines.join('\r\n') + '\r\n';
}

function parseUgl(textStr) {
  const s = String(textStr).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const res = { belegart: '', number: '', date: '', kommission: '', kundenNr: '', lieferantenNr: '', positions: [], netTotal: 0, count: 0 };
  for (const line of s.split('\n')) {
    if (line.length < 3) continue;
    const sa = line.slice(0, 3);
    if (sa === '100') {
      res.kundenNr = line.slice(8, 23).trim();
      res.lieferantenNr = line.slice(23, 38).trim();
      res.date = isoFrom(line.slice(38, 46));
    } else if (sa === '200') {
      res.belegart = line.slice(3, 6).trim();
      res.number = line.slice(6, 21).trim();
      res.date = isoFrom(line.slice(21, 29)) || res.date;
      res.kommission = line.slice(29, 59).trim();
    } else if (sa === '300') {
      res.positions.push({
        nr: parseInt(line.slice(3, 9), 10) || 0,
        articleNo: line.slice(9, 29).trim(),
        qty: (parseInt(line.slice(29, 39), 10) || 0) / 1000,
        unit: line.slice(39, 43).trim(),
        price: (parseInt(line.slice(43, 53), 10) || 0) / 100,
        name: line.slice(53, 93).trim(),
      });
    } else if (sa === '900') {
      res.count = parseInt(line.slice(3, 9), 10) || 0;
      res.netTotal = (parseInt(line.slice(9, 21), 10) || 0) / 100;
    }
  }
  return res;
}
function isoFrom(s) { s = String(s).trim(); return /^\d{8}$/.test(s) ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : ''; }

module.exports = { buildUglOrder, parseUgl };
