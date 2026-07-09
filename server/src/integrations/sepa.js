'use strict';
// SEPA-Zahlungsdateien erzeugen: pain.001 (Überweisung, Lieferanten bezahlen)
// und pain.008 (Lastschrift, von Kunden einziehen). ISO-20022-XML, das jede
// Bank / jedes Online-Banking importiert. Reine Funktion.

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function amt(v) { return (Math.round((Number(v) || 0) * 100) / 100).toFixed(2); }
function clean(s, n) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9\/\-?:().,'+ ]/g, ' ').trim().slice(0, n || 140); }
function iban(s) { return String(s || '').replace(/\s/g, '').toUpperCase(); }
function isoDate(d) { const m = String(d || '').match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : ''; }
function stampIso(now) {
  const d = now instanceof Date ? now : new Date();
  const p = (x, n) => String(x).padStart(n || 2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function sum(payments) { return amt(payments.reduce(function (s, p) { return s + (Number(p.amount) || 0); }, 0)); }

// pain.001.001.03 — Überweisungen
function buildCreditTransfer(o) {
  const cfg = o || {};
  const pays = cfg.payments || [];
  const now = cfg.now instanceof Date ? cfg.now : new Date();
  const msgId = cfg.msgId || ('WF-CT-' + stampIso(now).replace(/[-:T]/g, ''));
  const exec = isoDate(cfg.executionDate) || isoDate(stampIso(now));
  const dbtr = cfg.debtor || {};
  const tx = pays.map(function (p, i) {
    return '<CdtTrfTxInf>' +
      '<PmtId><EndToEndId>' + esc(clean(p.endToEndId || ('E2E-' + (i + 1)), 35)) + '</EndToEndId></PmtId>' +
      '<Amt><InstdAmt Ccy="EUR">' + amt(p.amount) + '</InstdAmt></Amt>' +
      (p.bic ? '<CdtrAgt><FinInstnId><BIC>' + esc(p.bic) + '</BIC></FinInstnId></CdtrAgt>' : '') +
      '<Cdtr><Nm>' + esc(clean(p.name, 70)) + '</Nm></Cdtr>' +
      '<CdtrAcct><Id><IBAN>' + esc(iban(p.iban)) + '</IBAN></Id></CdtrAcct>' +
      '<RmtInf><Ustrd>' + esc(clean(p.remittance, 140)) + '</Ustrd></RmtInf>' +
      '</CdtTrfTxInf>';
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">' +
    '<CstmrCdtTrfInitn>' +
    '<GrpHdr><MsgId>' + esc(msgId) + '</MsgId><CreDtTm>' + stampIso(now) + '</CreDtTm>' +
    '<NbOfTxs>' + pays.length + '</NbOfTxs><CtrlSum>' + sum(pays) + '</CtrlSum>' +
    '<InitgPty><Nm>' + esc(clean(dbtr.name, 70)) + '</Nm></InitgPty></GrpHdr>' +
    '<PmtInf><PmtInfId>' + esc(msgId) + '</PmtInfId><PmtMtd>TRF</PmtMtd>' +
    '<NbOfTxs>' + pays.length + '</NbOfTxs><CtrlSum>' + sum(pays) + '</CtrlSum>' +
    '<PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>' +
    '<ReqdExctnDt>' + exec + '</ReqdExctnDt>' +
    '<Dbtr><Nm>' + esc(clean(dbtr.name, 70)) + '</Nm></Dbtr>' +
    '<DbtrAcct><Id><IBAN>' + esc(iban(dbtr.iban)) + '</IBAN></Id></DbtrAcct>' +
    '<DbtrAgt><FinInstnId>' + (dbtr.bic ? '<BIC>' + esc(dbtr.bic) + '</BIC>' : '<Othr><Id>NOTPROVIDED</Id></Othr>') + '</FinInstnId></DbtrAgt>' +
    '<ChrgBr>SLEV</ChrgBr>' + tx +
    '</PmtInf></CstmrCdtTrfInitn></Document>';
}

// pain.008.001.02 — Lastschriften (SEPA-Basislastschrift CORE)
function buildDirectDebit(o) {
  const cfg = o || {};
  const pays = cfg.payments || [];
  const now = cfg.now instanceof Date ? cfg.now : new Date();
  const msgId = cfg.msgId || ('WF-DD-' + stampIso(now).replace(/[-:T]/g, ''));
  const coll = isoDate(cfg.collectionDate) || isoDate(stampIso(now));
  const cdtr = cfg.creditor || {};
  const seqTp = cfg.sequenceType || 'OOFF';
  const tx = pays.map(function (p, i) {
    return '<DrctDbtTxInf>' +
      '<PmtId><EndToEndId>' + esc(clean(p.endToEndId || ('E2E-' + (i + 1)), 35)) + '</EndToEndId></PmtId>' +
      '<InstdAmt Ccy="EUR">' + amt(p.amount) + '</InstdAmt>' +
      '<DrctDbtTx><MndtRltdInf><MndtId>' + esc(clean(p.mandateId, 35)) + '</MndtId><DtOfSgntr>' + isoDate(p.mandateDate) + '</DtOfSgntr></MndtRltdInf></DrctDbtTx>' +
      (p.bic ? '<DbtrAgt><FinInstnId><BIC>' + esc(p.bic) + '</BIC></FinInstnId></DbtrAgt>' : '<DbtrAgt><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></DbtrAgt>') +
      '<Dbtr><Nm>' + esc(clean(p.name, 70)) + '</Nm></Dbtr>' +
      '<DbtrAcct><Id><IBAN>' + esc(iban(p.iban)) + '</IBAN></Id></DbtrAcct>' +
      '<RmtInf><Ustrd>' + esc(clean(p.remittance, 140)) + '</Ustrd></RmtInf>' +
      '</DrctDbtTxInf>';
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.008.001.02">' +
    '<CstmrDrctDbtInitn>' +
    '<GrpHdr><MsgId>' + esc(msgId) + '</MsgId><CreDtTm>' + stampIso(now) + '</CreDtTm>' +
    '<NbOfTxs>' + pays.length + '</NbOfTxs><CtrlSum>' + sum(pays) + '</CtrlSum>' +
    '<InitgPty><Nm>' + esc(clean(cdtr.name, 70)) + '</Nm></InitgPty></GrpHdr>' +
    '<PmtInf><PmtInfId>' + esc(msgId) + '</PmtInfId><PmtMtd>DD</PmtMtd>' +
    '<NbOfTxs>' + pays.length + '</NbOfTxs><CtrlSum>' + sum(pays) + '</CtrlSum>' +
    '<PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl><LclInstrm><Cd>CORE</Cd></LclInstrm><SeqTp>' + seqTp + '</SeqTp></PmtTpInf>' +
    '<ReqdColltnDt>' + coll + '</ReqdColltnDt>' +
    '<Cdtr><Nm>' + esc(clean(cdtr.name, 70)) + '</Nm></Cdtr>' +
    '<CdtrAcct><Id><IBAN>' + esc(iban(cdtr.iban)) + '</IBAN></Id></CdtrAcct>' +
    '<CdtrAgt><FinInstnId>' + (cdtr.bic ? '<BIC>' + esc(cdtr.bic) + '</BIC>' : '<Othr><Id>NOTPROVIDED</Id></Othr>') + '</FinInstnId></CdtrAgt>' +
    '<CdtrSchmeId><Id><PrvtId><Othr><Id>' + esc(cdtr.creditorId || '') + '</Id><SchmeNm><Prtry>SEPA</Prtry></SchmeNm></Othr></PrvtId></Id></CdtrSchmeId>' +
    tx + '</PmtInf></CstmrDrctDbtInitn></Document>';
}

module.exports = { buildCreditTransfer, buildDirectDebit };
