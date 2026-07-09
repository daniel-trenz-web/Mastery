'use strict';
// GoBD / GDPdU-Prüferexport ("Beschreibungsstandard"): erzeugt index.xml + CSV-
// Dateien, die eine Betriebsprüfung mit IDEA/ACL einlesen kann. Reine Funktion;
// der Aufrufer packt die Rückgabe in ein ZIP.

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return '"' + s.replace(/"/g, '""').replace(/[\r\n]+/g, ' ') + '"';
}
function n2(v) { return (Math.round((Number(v) || 0) * 100) / 100).toFixed(2).replace('.', ','); }
function d(v) { const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : ''; }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

const OUT_COLS = [
  { name: 'Rechnungsnummer', type: 'AlphaNumeric', pk: true, get: function (r) { return r.number; } },
  { name: 'Datum', type: 'Date', get: function (r) { return d(r.date); } },
  { name: 'Kunde', type: 'AlphaNumeric', get: function (r) { return r.party; } },
  { name: 'Netto', type: 'Numeric', get: function (r) { return n2(r.net); } },
  { name: 'USt', type: 'Numeric', get: function (r) { return n2(r.vat); } },
  { name: 'Brutto', type: 'Numeric', get: function (r) { return n2(r.gross); } },
  { name: 'Bezahlt_am', type: 'Date', get: function (r) { return d(r.paidDate); } },
];
const IN_COLS = [
  { name: 'Rechnungsnummer', type: 'AlphaNumeric', pk: true, get: function (r) { return r.number; } },
  { name: 'Datum', type: 'Date', get: function (r) { return d(r.date); } },
  { name: 'Lieferant', type: 'AlphaNumeric', get: function (r) { return r.party; } },
  { name: 'Brutto', type: 'Numeric', get: function (r) { return n2(r.gross); } },
  { name: 'Bezahlt_am', type: 'Date', get: function (r) { return d(r.paidDate); } },
];

function csvFor(cols, rows) {
  const head = cols.map(function (c) { return csvCell(c.name); }).join(';');
  const body = rows.map(function (r) { return cols.map(function (c) { return csvCell(c.get(r)); }).join(';'); }).join('\r\n');
  return head + '\r\n' + body + (body ? '\r\n' : '');
}
function tableXml(file, name, desc, cols, range) {
  return '<Table><URL><File>' + esc(file) + '</File></URL><Name>' + esc(name) + '</Name><Description>' + esc(desc) + '</Description>' +
    '<Validity><Range><From>' + esc(range.from) + '</From><To>' + esc(range.to) + '</To></Range><Format>YYYY-MM-DD</Format></Validity>' +
    '<DecimalSymbol>,</DecimalSymbol><DigitGroupingSymbol>.</DigitGroupingSymbol>' +
    '<VariableLength><ColumnDelimiter>;</ColumnDelimiter><RecordDelimiter>&#13;&#10;</RecordDelimiter><TextEncapsulator>"</TextEncapsulator>' +
    cols.map(function (c) {
      const inner = c.type === 'Numeric' ? '<Numeric><Accuracy>2</Accuracy></Numeric>' : c.type === 'Date' ? '<Date><Format>YYYY-MM-DD</Format></Date>' : '<AlphaNumeric/>';
      return '<VariableColumn><Name>' + esc(c.name) + '</Name>' + (c.pk ? '<VariablePrimaryKey/>' : '') + inner + '</VariableColumn>';
    }).join('') +
    '</VariableLength></Table>';
}

// data: { supplierName, range:{from,to}, outgoing:[{number,date,party,net,vat,gross,paidDate}], incoming:[...] }
function buildGobdExport(data) {
  const dd = data || {};
  const range = dd.range || { from: '', to: '' };
  const outgoing = dd.outgoing || [];
  const incoming = dd.incoming || [];
  const files = {};
  const tables = [];
  files['ausgangsrechnungen.csv'] = csvFor(OUT_COLS, outgoing);
  tables.push(tableXml('ausgangsrechnungen.csv', 'Ausgangsrechnungen', 'Ausgangsrechnungen des Zeitraums', OUT_COLS, range));
  files['eingangsrechnungen.csv'] = csvFor(IN_COLS, incoming);
  tables.push(tableXml('eingangsrechnungen.csv', 'Eingangsrechnungen', 'Eingangsrechnungen des Zeitraums', IN_COLS, range));
  files['index.xml'] = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE DataSet SYSTEM "gdpdu-01-09-2004.dtd">\n' +
    '<DataSet><Version>1.0</Version>' +
    '<DataSupplier><Name>' + esc(dd.supplierName || 'werkflow') + '</Name><Location>Deutschland</Location><Comment>GoBD-Export aus werkflow</Comment></DataSupplier>' +
    '<Media><Name>werkflow-Export ' + esc(range.from) + ' bis ' + esc(range.to) + '</Name>' + tables.join('') + '</Media></DataSet>';
  return files;
}

module.exports = { buildGobdExport };
