'use strict';
// GAEB-Datenaustausch (GAEB DA XML 3.x): Leistungsverzeichnisse von Ausschreibungen
// einlesen (D81/D83) und Angebot mit Preisen exportieren (D84). Reine Funktion.
// GAEB-Feldstrukturen variieren leicht; der Parser deckt die gängige Belegung ab.

const xml = require('../xml');

function deepText(node) {
  if (!node) return '';
  let t = (node.text || '');
  (node.children || []).forEach(function (c) { t += ' ' + deepText(c); });
  return t.replace(/\s+/g, ' ').trim();
}
function numDe(v) {
  if (v == null) return 0;
  let s = String(v).replace(/\s/g, '');
  if (/,\d+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function parseGaeb(xmlStr) {
  const root = xml.parseXml(xmlStr);
  const daType = detectPhase(root);
  const items = [];
  xml.findAll(root, 'Item').forEach(function (it) {
    // Positionsnummer: Element <RNoPart> (ggf. mehrfach) oder Attribut RNoPart/ID
    const rnoParts = xml.children(it, 'RNoPart');
    let pos = rnoParts.length ? rnoParts.map(function (r) { return (r.text || '').trim(); }).filter(Boolean).join('.') : '';
    if (!pos) pos = it.attrs.RNoPart || xml.text(it, 'RNo') || it.attrs.ID || '';
    const qtyEl = xml.firstChild(it, 'Qty') || xml.find(it, 'Qty');
    const qty = qtyEl ? numDe(qtyEl.text) : 0;
    const unit = xml.text(it, 'QU');
    const desc = xml.find(it, 'Description') || xml.find(it, 'OutlineText') || it;
    let text = '';
    const otxt = xml.find(desc, 'OutlineText');
    if (otxt) text = deepText(otxt);
    if (!text) { const ct = xml.find(desc, 'CompleteText') || xml.find(desc, 'DetailTxt'); text = ct ? deepText(ct) : deepText(desc); }
    const up = numDe(xml.text(it, 'UP'));
    const total = numDe(xml.text(it, 'IT')) || Math.round(qty * up * 100) / 100;
    if (!pos && !text && !qty) return;
    items.push({ id: it.attrs.ID || pos, pos: pos, qty: qty, unit: unit || '', text: text.slice(0, 500), up: up, total: total });
  });
  const prjInfo = xml.find(root, 'PrjInfo');
  return { phase: daType, projectName: prjInfo ? xml.text(prjInfo, 'LblPrj') || xml.text(prjInfo, 'NamePrj') : '', itemCount: items.length, items: items };
}
function detectPhase(root) {
  for (const p of ['Award', 'BoQ', 'PrjInfo']) if (xml.find(root, p)) { /* generic */ }
  const award = xml.find(root, 'Award');
  if (award) { const dp = xml.text(award, 'DP'); if (dp) return 'D' + dp; }
  // Heuristik: Preise vorhanden → D84
  return xml.find(root, 'UP') ? 'D84' : 'D83';
}

// D84 (Angebotsabgabe) erzeugen: LV mit eingetragenen Preisen.
function buildGaebD84(items, meta) {
  const m = meta || {};
  const now = m.now instanceof Date ? m.now : new Date();
  const p2 = function (x) { return String(x).padStart(2, '0'); };
  const date = now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate());
  let sum = 0;
  const rows = (items || []).map(function (it) {
    const qty = Number(it.qty) || 0, up = Number(it.up != null ? it.up : it.price) || 0;
    const total = Math.round(qty * up * 100) / 100; sum += total;
    return '<Item ID="' + esc(it.id || it.pos || '') + '">' +
      '<RNoPart>' + esc(it.pos || '') + '</RNoPart>' +
      '<Qty>' + fmt(qty) + '</Qty><QU>' + esc(it.unit || '') + '</QU>' +
      '<Description><CompleteText><DetailTxt><Text><p><span>' + esc(it.text || it.name || '') + '</span></p></Text></DetailTxt></CompleteText></Description>' +
      '<UP>' + fmt(up) + '</UP><IT>' + fmt(total) + '</IT></Item>';
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<GAEB xmlns="http://www.gaeb.de/GAEB_DA_XML/DA84/3.2">' +
    '<GAEBInfo><Version>3.2</Version><Date>' + date + '</Date><ProgSystem>werkflow</ProgSystem></GAEBInfo>' +
    '<PrjInfo><NamePrj>' + esc(m.projectName || '') + '</NamePrj><Cur>EUR</Cur></PrjInfo>' +
    '<Award><DP>84</DP><BoQ><BoQBody><BoQCtgy><BoQBody><Itemlist>' + rows + '</Itemlist>' +
    '<Totals><Total>' + fmt(Math.round(sum * 100) / 100) + '</Total></Totals>' +
    '</BoQBody></BoQCtgy></BoQBody></BoQ></Award></GAEB>';
}
function fmt(n) { return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

module.exports = { parseGaeb, buildGaebD84 };
