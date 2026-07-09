'use strict';
// Kontoauszüge einlesen: CAMT.053 (ISO 20022 XML), MT940 (SWIFT) und CSV.
// Liefert eine normalisierte Transaktionsliste. Beträge sind vorzeichenbehaftet:
// Gutschrift (Geld rein) = positiv, Lastschrift (Geld raus) = negativ.
// Reine Funktionen, kein Netzwerk-/Datei-Zugriff.

const xml = require('../xml');

function amt(v) {
  if (v == null) return 0;
  let s = String(v).replace(/\s/g, '');
  // 1.234,56 -> 1234.56 ; 1234.56 bleibt
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
function round2(n) { return Math.round(n * 100) / 100; }

// ---- CAMT.053 ----------------------------------------------------------------
function parseCamt053(xmlStr) {
  const root = xml.parseXml(xmlStr);
  const stmts = xml.findAll(root, 'Stmt');
  const out = [];
  let account = '';
  for (const stmt of stmts) {
    const acct = xml.find(stmt, 'Acct');
    if (acct) account = xml.text(acct, 'IBAN') || account;
    const entries = xml.findAll(stmt, 'Ntry');
    for (const e of entries) {
      const amtEl = xml.firstChild(e, 'Amt') || xml.find(e, 'Amt');
      const ccy = amtEl && amtEl.attrs ? (amtEl.attrs.Ccy || 'EUR') : 'EUR';
      const ind = (xml.text(e, 'CdtDbtInd') || 'CRDT').toUpperCase();
      const sign = ind.startsWith('DBIT') ? -1 : 1;
      const value = sign * amt(amtEl ? amtEl.text : 0);
      const bookg = xml.find(e, 'BookgDt');
      const vald = xml.find(e, 'ValDt');
      const txd = xml.find(e, 'TxDtls');
      let counterparty = '', cpIban = '', reference = '', endToEnd = '';
      if (txd) {
        const parties = xml.find(txd, 'RltdPties');
        if (parties) {
          // Bei Gutschrift ist der Zahler (Dbtr) die Gegenpartei, bei Lastschrift der Cdtr
          const cp = sign > 0 ? (xml.find(parties, 'Dbtr') || xml.find(parties, 'Cdtr'))
                              : (xml.find(parties, 'Cdtr') || xml.find(parties, 'Dbtr'));
          if (cp) counterparty = xml.text(cp, 'Nm');
          const accs = xml.findAll(parties, 'IBAN');
          if (accs.length) cpIban = (accs[0].text || '').trim();
        }
        const rmt = xml.find(txd, 'RmtInf');
        if (rmt) reference = xml.findAll(rmt, 'Ustrd').map((u) => (u.text || '').trim()).join(' ').trim();
        const refs = xml.find(txd, 'Refs');
        if (refs) endToEnd = xml.text(refs, 'EndToEndId');
      }
      if (!reference) reference = xml.text(e, 'AddtlNtryInf');
      out.push({
        date: xml.text(bookg, 'Dt') || xml.text(bookg, 'DtTm').slice(0, 10),
        valueDate: xml.text(vald, 'Dt') || '',
        amount: round2(value),
        currency: ccy,
        counterparty: counterparty || '',
        counterpartyIban: cpIban || '',
        reference: (reference || '').replace(/\s+/g, ' ').trim(),
        endToEndId: endToEnd === 'NOTPROVIDED' ? '' : (endToEnd || ''),
        account: account,
        source: 'camt053',
      });
    }
  }
  return out;
}

// ---- MT940 -------------------------------------------------------------------
function parseMt940(textStr) {
  const raw = String(textStr).replace(/\r\n/g, '\n');
  const out = [];
  let account = '';
  // Felder anhand der :NN: Marker zerlegen
  const lines = raw.split('\n');
  let cur = null;
  const flush = () => { if (cur) { out.push(finalizeMt940(cur, account)); cur = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '-' || line.trim() === '') continue; // Datensatz-Endmarker / Leerzeile
    const tag = line.match(/^:(\d{2}[A-Z]?):(.*)$/);
    if (tag) {
      const code = tag[1], body = tag[2];
      if (code === '25') account = (body.split('/').pop() || body).trim();
      else if (code === '61') { flush(); cur = { l61: body, l86: '', _in86: false }; }
      else if (code === '86' && cur) { cur.l86 = body; cur._in86 = true; }
      else if (cur) cur._in86 = false; // ein anderes Feld beendet die :86:-Fortsetzung
    } else if (cur && cur._in86) {
      cur.l86 += line; // echte Fortsetzungszeile von :86:
    }
  }
  flush();
  return out;
}
function finalizeMt940(cur, account) {
  const b = cur.l61;
  // :61: YYMMDD [MMDD] D/C[funds] amount N...
  const m = b.match(/^(\d{6})(\d{4})?([A-Z]?)([CD])[A-Z]?([\d.,]+)/);
  let date = '', valueDate = '', sign = 1, value = 0;
  if (m) {
    valueDate = yymmdd(m[1]);
    date = m[2] ? (valueDate.slice(0, 4) + '-' + m[2].slice(0, 2) + '-' + m[2].slice(2, 4)) : valueDate;
    sign = m[4] === 'D' ? -1 : 1;
    value = sign * amt(m[5]);
  }
  const info = parseMt940Field86(cur.l86 || '');
  return {
    date, valueDate,
    amount: round2(value),
    currency: 'EUR',
    counterparty: info.counterparty,
    counterpartyIban: info.iban,
    reference: info.purpose,
    endToEndId: info.endToEnd || '',
    account,
    source: 'mt940',
  };
}
function yymmdd(s) {
  const yy = parseInt(s.slice(0, 2), 10);
  const year = yy <= 79 ? 2000 + yy : 1900 + yy;
  return year + '-' + s.slice(2, 4) + '-' + s.slice(4, 6);
}
function parseMt940Field86(s) {
  // Strukturiert: ?00 Buchungstext ?20..?29 Verwendungszweck ?32/?33 Name ?31 IBAN
  const res = { counterparty: '', iban: '', purpose: '', endToEnd: '' };
  if (s.indexOf('?') >= 0) {
    const parts = s.split('?').slice(1);
    let purpose = '', name = '';
    for (const p of parts) {
      const code = p.slice(0, 2), val = p.slice(2);
      if (/^2[0-9]$/.test(code)) purpose += val;
      else if (code === '32' || code === '33') name += val;
      else if (code === '31') res.iban = val.trim();
    }
    res.counterparty = name.trim();
    // SEPA-Subfelder aus dem Verwendungszweck extrahieren (durch feste Tags getrennt)
    const sepa = extractSepa(purpose);
    res.endToEnd = sepa.EREF || '';
    res.purpose = (sepa.SVWZ != null ? sepa.SVWZ : purpose).replace(/\s+/g, ' ').trim();
    if (sepa.IBAN && !res.iban) res.iban = sepa.IBAN;
  } else {
    res.purpose = s.replace(/\s+/g, ' ').trim();
  }
  return res;
}
// SEPA-Verwendungszweck in Subfelder (EREF+, SVWZ+, IBAN+ …) zerlegen
function extractSepa(purpose) {
  const tags = ['EREF', 'KREF', 'MREF', 'CRED', 'DEBT', 'COAM', 'OAMT', 'SVWZ', 'ABWA', 'ABWE', 'IBAN', 'BIC'];
  const re = new RegExp('(' + tags.join('|') + ')\\+', 'g');
  const marks = [];
  let m;
  while ((m = re.exec(purpose)) !== null) marks.push({ tag: m[1], valStart: m.index + m[0].length, tagStart: m.index });
  const out = {};
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].tagStart : purpose.length;
    out[marks[i].tag] = purpose.slice(marks[i].valStart, end).trim();
  }
  return out;
}

// ---- CSV (bankneutral, mit Spalten-Mapping) ----------------------------------
// mapping: { date, amount, counterparty, reference, iban, debit, credit, decimal }
function parseBankCsv(textStr, mapping) {
  const map = mapping || {};
  const rows = parseCsvRows(textStr);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  const idx = (name) => {
    if (name == null) return -1;
    if (typeof name === 'number') return name;
    return header.findIndex((h) => h.toLowerCase() === String(name).toLowerCase());
  };
  const iDate = idx(map.date != null ? map.date : firstMatch(header, ['buchungstag', 'datum', 'date', 'buchung']));
  const iAmount = idx(map.amount != null ? map.amount : firstMatch(header, ['betrag', 'amount', 'umsatz']));
  const iDebit = idx(map.debit != null ? map.debit : firstMatch(header, ['soll', 'debit', 'auszahlung']));
  const iCredit = idx(map.credit != null ? map.credit : firstMatch(header, ['haben', 'credit', 'einzahlung']));
  const iCp = idx(map.counterparty != null ? map.counterparty : firstMatch(header, ['auftraggeber', 'empfänger', 'empfaenger', 'beguenstigter', 'name', 'zahlungspflichtiger']));
  const iRef = idx(map.reference != null ? map.reference : firstMatch(header, ['verwendungszweck', 'reference', 'zweck', 'buchungstext']));
  const iIban = idx(map.iban != null ? map.iban : firstMatch(header, ['iban', 'kontonummer']));
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row.length || row.every((c) => !String(c).trim())) continue;
    let value = 0;
    if (iAmount >= 0 && String(row[iAmount] || '').trim()) value = amt(row[iAmount]);
    else {
      const d = iDebit >= 0 ? amt(row[iDebit]) : 0;
      const c = iCredit >= 0 ? amt(row[iCredit]) : 0;
      value = c - Math.abs(d);
    }
    out.push({
      date: normDate(iDate >= 0 ? row[iDate] : ''),
      valueDate: '',
      amount: round2(value),
      currency: 'EUR',
      counterparty: iCp >= 0 ? String(row[iCp] || '').trim() : '',
      counterpartyIban: iIban >= 0 ? String(row[iIban] || '').trim() : '',
      reference: iRef >= 0 ? String(row[iRef] || '').replace(/\s+/g, ' ').trim() : '',
      endToEndId: '',
      account: '',
      source: 'csv',
    });
  }
  return out;
}
function firstMatch(header, names) {
  const low = header.map((h) => h.toLowerCase());
  for (const n of names) { const i = low.findIndex((h) => h.includes(n)); if (i >= 0) return i; }
  return null;
}
function normDate(s) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{2})\.(\d{2})\.(\d{2,4})/);
  if (m) { let y = m[3].length === 2 ? '20' + m[3] : m[3]; return y + '-' + m[2] + '-' + m[1]; }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : s;
}
// CSV-Zeilen tolerant parsen (Trennzeichen automatisch: ; , oder Tab)
function parseCsvRows(textStr) {
  const s = String(textStr).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!s) return [];
  const firstLine = s.split('\n')[0];
  const delim = countChar(firstLine, ';') >= countChar(firstLine, ',') ? (countChar(firstLine, ';') >= countChar(firstLine, '\t') ? ';' : '\t') : (countChar(firstLine, ',') >= countChar(firstLine, '\t') ? ',' : '\t');
  const rows = [];
  let field = '', row = [], inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  row.push(field); rows.push(row);
  return rows;
}
function countChar(s, c) { let n = 0; for (const ch of s) if (ch === c) n++; return n; }

// Auto-Erkennung des Formats anhand von Inhalt/MIME
function parseStatement(buffer, mediaType, csvMapping) {
  const s = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  const mt = (mediaType || '').toLowerCase();
  const head = s.slice(0, 500);
  if (mt.includes('xml') || /<Document|<BkToCstmrStmt|CdtDbtInd/.test(head)) return { format: 'camt053', transactions: parseCamt053(s) };
  if (/^:\d{2}[A-Z]?:/m.test(s) || /:61:/.test(s)) return { format: 'mt940', transactions: parseMt940(s) };
  return { format: 'csv', transactions: parseBankCsv(s, csvMapping) };
}

module.exports = { parseCamt053, parseMt940, parseBankCsv, parseStatement, parseCsvRows };
