'use strict';
// E2E-Tests für die Schnittstellen-/Website-Endpunkte über echtes HTTP.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'werkos-integ-'));
process.env.WERKOS_DATA_DIR = TMP;
process.env.WERKOS_REGISTER_LIMIT = '1000';
process.env.WERKOS_LOGIN_IP_LIMIT = '1000';
process.env.WERKOS_INBOUND_SECRET = 'test-inbound-secret';

const { createServer } = require('../src/server');
const dbm = require('../src/db');
const { sha256, opaqueToken } = require('../src/util');

let BASE, server, token, tenantId;

test.before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = 'http://127.0.0.1:' + server.address().port;
  // Mandant anlegen + Add-on-Module kaufen
  const reg = await api('POST', '/api/auth/register', { body: { company: 'Integ GmbH', email: 'integ@test.de', name: 'Chef', password: 'sicheres-passwort-123' } });
  token = reg.data.accessToken; tenantId = reg.data.tenant.id;
  for (const mod of ['buchhaltung', 'website']) {
    const r = await api('POST', '/api/billing/buy-module', { token, body: { module: mod, acceptTerms: true } });
    assert.equal(r.status, 201, 'buy ' + mod + ': ' + JSON.stringify(r.data));
  }
});
test.after(() => { server.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

async function api(method, p, { body, token, headers, raw } = {}) {
  const h = Object.assign({}, headers);
  if (token) h['Authorization'] = 'Bearer ' + token;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + p, { method, headers: h, body: payload });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json().catch(() => null) : Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, headers: r.headers };
}

test('Integrations-Übersicht + Lexoffice-Konfiguration (Key redigiert)', async () => {
  let r = await api('GET', '/api/t/integrations', { token });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.integrations));
  r = await api('PUT', '/api/t/integrations/lexoffice', { token, body: { config: { apiKey: 'secret-key-123' } } });
  assert.equal(r.status, 200);
  r = await api('GET', '/api/t/integrations', { token });
  const lex = r.data.integrations.find((c) => c.kind === 'lexoffice');
  assert.ok(lex, 'lexoffice gespeichert');
  assert.equal(lex.config.apiKey, '••••', 'API-Key wird redigiert zurückgegeben');
});

test('Bank-Import (CAMT.053) + Zahlungsabgleich', async () => {
  const camt = `<Document><BkToCstmrStmt><Stmt><Acct><Id><IBAN>DE12500105170648489890</IBAN></Id></Acct>
   <Ntry><Amt Ccy="EUR">2380.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-02-18</Dt></BookgDt>
    <NtryDtls><TxDtls><RltdPties><Dbtr><Nm>Familie Schmidt</Nm></Dbtr></RltdPties><RmtInf><Ustrd>Rechnung 2026-0042</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
   </Stmt></BkToCstmrStmt></Document>`;
  let r = await api('POST', '/api/t/bank/import', { token, raw: camt, headers: { 'Content-Type': 'application/xml' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.format, 'camt053');
  assert.equal(r.data.transactions[0].amount, 2380);
  r = await api('POST', '/api/t/bank/reconcile', { token, body: { transactions: r.data.transactions, openItems: [{ id: 'inv42', kind: 'outgoing', number: '2026-0042', amount: 2380, party: 'Familie Schmidt' }] } });
  assert.equal(r.status, 200);
  assert.equal(r.data.autoCount, 1);
  assert.equal(r.data.matches[0].itemId, 'inv42');
});

test('DATEV-Export liefert EXTF-Buchungsstapel-CSV', async () => {
  const r = await api('POST', '/api/t/datev/export', { token, body: { items: [{ kind: 'outgoing', number: '2026-0042', date: '2026-02-01', gross: 2380, party: 'Schmidt', debitor: 10001 }], cfg: { skr: '03' }, meta: { beraterNr: '1', mandantNr: '2' } } });
  assert.equal(r.status, 200);
  const csv = r.data.toString('utf8');
  assert.ok(csv.startsWith('"EXTF";700;21;"Buchungsstapel"'));
  assert.ok(csv.includes('2380,00'));
});

test('E-Rechnung parsen (XRechnung/UBL Upload)', async () => {
  const ubl = `<Invoice xmlns:cac="c" xmlns:cbc="b"><cbc:ID>XR-9</cbc:ID><cbc:IssueDate>2026-02-01</cbc:IssueDate>
   <cac:AccountingSupplierParty><cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>Wuerth</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
   <cac:LegalMonetaryTotal><cbc:TaxExclusiveAmount>200.00</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount>238.00</cbc:TaxInclusiveAmount></cac:LegalMonetaryTotal></Invoice>`;
  const r = await api('POST', '/api/t/invoices/parse', { token, raw: ubl, headers: { 'Content-Type': 'application/xml' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.data.invoiceNumber, 'XR-9');
  assert.equal(r.data.data.gross, 238);
});

test('Katalog-Import (CSV) + UGL-Bestelldatei', async () => {
  const csv = 'Artikelnummer;Bezeichnung;Einheit;Preis\nA-100;Kabel NYM;m;1,20';
  let r = await api('POST', '/api/t/purchasing/catalog', { token, raw: csv, headers: { 'Content-Type': 'text/csv' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.articles[0].artNr, 'A-100');
  r = await api('POST', '/api/t/purchasing/ugl', { token, body: { order: { number: 'B-1', items: [{ nr: 1, articleNo: 'A-100', qty: 10, unit: 'm', price: 1.2, name: 'Kabel' }] } } });
  assert.equal(r.status, 200);
  assert.ok(r.data.toString('utf8').includes('200BES'));
});

test('Modul-Gate: ohne buchhaltung kein Zugriff', async () => {
  const reg = await api('POST', '/api/auth/register', { body: { company: 'Ohne AddOn', email: 'noaddon@test.de', name: 'Ohne Chef', password: 'sicheres-passwort-123' } });
  const r = await api('POST', '/api/t/datev/export', { token: reg.data.accessToken, body: { items: [] } });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'module-not-active');
});

test('Website generieren, veröffentlichen und öffentlich ausliefern', async () => {
  let r = await api('POST', '/api/t/sites/generate', { token, body: { useAi: false, template: 'modern', business: { companyName: 'Elektro Integ', city: 'Stuttgart', email: 'info@integ.de', vatId: 'DE1', address: 'Weg 1', zip: '70173' }, input: { companyName: 'Elektro Integ', branche: 'Elektro', city: 'Stuttgart', services: ['Installation', 'Smart Home'] } } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const siteId = r.data.id; const slug = r.data.slug;
  assert.ok(slug);
  // vor Veröffentlichung: 404 öffentlich
  let pub = await api('GET', '/api/public/site/' + slug + '/index.html');
  assert.equal(pub.status, 404);
  // veröffentlichen
  r = await api('POST', '/api/t/sites/' + siteId + '/publish', { token, body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'published');
  // jetzt öffentlich abrufbar
  pub = await api('GET', '/api/public/site/' + slug + '/index.html');
  assert.equal(pub.status, 200);
  const html = pub.data.toString('utf8');
  assert.ok(html.includes('<!doctype html>'));
  assert.ok(html.includes('Elektro Integ'));
  assert.ok(html.includes('id="cc"'));
  // Rechtsseiten + Sitemap
  assert.equal((await api('GET', '/api/public/site/' + slug + '/impressum.html')).status, 200);
  const sm = await api('GET', '/api/public/site/' + slug + '/sitemap.xml');
  assert.equal(sm.status, 200);
  assert.ok(sm.data.toString('utf8').includes('<urlset'));
});

test('Eingehende Rechnungs-Webhook: Signatur + Inbox-Ablage + Abruf', async () => {
  // Inbox-Token direkt setzen (in echt via PUT integrations mit regenerateInboxToken)
  const t = opaqueToken();
  dbm.setIntegration(tenantId, 'invoice_inbox', { forwardTo: '' }, sha256(t.token));
  const ubl = `<Invoice xmlns:cbc="b"><cbc:ID>ER-77</cbc:ID><cac:LegalMonetaryTotal xmlns:cac="c"><cbc:TaxInclusiveAmount>119.00</cbc:TaxInclusiveAmount></cac:LegalMonetaryTotal></Invoice>`;
  // falsche Signatur -> 401
  let r = await api('POST', '/api/public/inbound/invoice/' + t.token, { raw: ubl, headers: { 'Content-Type': 'application/xml', 'X-Werkflow-Signature': 'wrong' } });
  assert.equal(r.status, 401);
  // richtige Signatur -> abgelegt
  r = await api('POST', '/api/public/inbound/invoice/' + t.token, { raw: ubl, headers: { 'Content-Type': 'application/xml', 'X-Werkflow-Signature': 'test-inbound-secret' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  // App holt Inbox ab
  const inbox = await api('GET', '/api/t/inbox', { token });
  assert.equal(inbox.status, 200);
  const item = inbox.data.items.find((i) => i.kind === 'invoice');
  assert.ok(item, 'Rechnung in Inbox');
  // übernehmen
  const imp = await api('POST', '/api/t/inbox/' + item.id + '/import', { token });
  assert.equal(imp.status, 200);
});

test('IDS-Warenkorb-Rückgabe landet als Bestellung in der Inbox', async () => {
  const t = opaqueToken();
  dbm.setIntegration(tenantId, 'ids', { shopUrl: 'https://shop.example' }, sha256(t.token));
  const body = 'ARTNR[1]=123&MENGE[1]=5&PREIS[1]=2,50&KURZTEXT[1]=Rohr';
  const r = await api('POST', '/api/public/ids/return/' + t.token, { raw: body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.positions, 1);
  const inbox = await api('GET', '/api/t/inbox', { token });
  assert.ok(inbox.data.items.some((i) => i.kind === 'order'));
});
