'use strict';
// E2E für die sichere PSD2-Bankanbindung gegen einen Mock-Bank-Aggregator.
// Prüft den kompletten Fluss: Banken listen → verbinden (Login-Link) →
// Status (verknüpft) → Sync (Umsätze in die Inbox) → trennen. Plus: die
// gespeicherten Referenzen liegen VERSCHLÜSSELT in der DB.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.WERKOS_DATA_DIR) process.env.WERKOS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'werkos-psd2-'));
process.env.WERKOS_REGISTER_LIMIT = '1000';
process.env.WERKOS_LOGIN_IP_LIMIT = '1000';

const cfg = require('../src/config');
const { createServer } = require('../src/server');
const dbm = require('../src/db');

let BASE, server, mock, token, tenantId;

const GC_TX = { transactions: { booked: [
  { transactionId: 'tx1', bookingDate: '2026-02-16', transactionAmount: { amount: '-142.80', currency: 'EUR' }, creditorName: 'Raab Karcher GmbH', creditorAccount: { iban: 'DE89370400440532013000' }, remittanceInformationUnstructured: 'Rechnung RE-2026-0815' },
  { transactionId: 'tx2', bookingDate: '2026-02-18', transactionAmount: { amount: '2380.00', currency: 'EUR' }, debtorName: 'Familie Schmidt', remittanceInformationUnstructured: 'Ihre Rechnung 2026-0042' },
], pending: [] } };

test.before(async () => {
  // Mock-Aggregator (GoCardless-kompatibel)
  mock = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; }); req.on('end', () => {
      const j = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/api/v2/token/new/' && req.method === 'POST') return j({ access: 'acc-token', refresh: 'ref-token' });
      if (req.url.startsWith('/api/v2/institutions/')) return j([{ id: 'SANDBOX_DE', name: 'Testbank', bic: 'TESTDEFF', logo: '' }]);
      if (req.url === '/api/v2/requisitions/' && req.method === 'POST') return j({ id: 'req_1', link: 'https://bank.example/login/req_1', status: 'CR' });
      if (req.url === '/api/v2/requisitions/req_1/' && req.method === 'GET') return j({ id: 'req_1', status: 'LN', accounts: ['acc_1'], institution_id: 'SANDBOX_DE' });
      if (req.url === '/api/v2/requisitions/req_1/' && req.method === 'DELETE') return j({ ok: true });
      if (req.url === '/api/v2/accounts/acc_1/details/') return j({ account: { iban: 'DE12500105170648489890', name: 'Geschäftskonto', currency: 'EUR' } });
      if (req.url.startsWith('/api/v2/accounts/acc_1/transactions/')) return j(GC_TX);
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  cfg.PSD2_BASE_URL = 'http://127.0.0.1:' + mock.address().port;
  cfg.PSD2_SECRET_ID = 'test-id';
  cfg.PSD2_SECRET_KEY = 'test-key';

  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = 'http://127.0.0.1:' + server.address().port;

  const reg = await api('POST', '/api/auth/register', { body: { company: 'PSD2 GmbH', email: 'psd2@test.de', name: 'Chef', password: 'sicheres-passwort-123' } });
  token = reg.data.accessToken; tenantId = reg.data.tenant.id;
  const buy = await api('POST', '/api/billing/buy-module', { token, body: { module: 'buchhaltung', acceptTerms: true } });
  assert.equal(buy.status, 201);
});
test.after(() => { server.close(); mock.close(); });

async function api(method, p, { body, token } = {}) {
  const h = {}; if (token) h.Authorization = 'Bearer ' + token;
  let payload; if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + p, { method, headers: h, body: payload });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json().catch(() => null) : await r.text() };
}

test('PSD2: Banken listen', async () => {
  const r = await api('GET', '/api/t/bank/psd2/institutions?country=de', { token });
  assert.equal(r.status, 200);
  assert.equal(r.data.configured, true);
  assert.equal(r.data.institutions[0].id, 'SANDBOX_DE');
});

test('PSD2: verbinden liefert Bank-Login-Link (kein Passwort im System)', async () => {
  const r = await api('POST', '/api/t/bank/psd2/connect', { token, body: { institutionId: 'SANDBOX_DE', institutionName: 'Testbank' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.ok(/bank\.example\/login/.test(r.data.link));
});

test('PSD2: gespeicherte Referenzen sind in der DB verschlüsselt', () => {
  const rec = dbm.getIntegration(tenantId, 'bank_psd2');
  assert.ok(rec, 'Datensatz vorhanden');
  const conf = JSON.parse(rec.config_json);
  assert.ok(conf.enc && conf.enc.startsWith('v1:'), 'verschlüsselt (v1:)');
  assert.ok(!rec.config_json.includes('req_1'), 'Requisition-ID nicht im Klartext');
});

test('PSD2: Status = verknüpft, Konto mit IBAN', async () => {
  const r = await api('GET', '/api/t/bank/psd2/status', { token });
  assert.equal(r.status, 200);
  assert.equal(r.data.connected, true);
  assert.equal(r.data.status, 'LN');
  assert.equal(r.data.accounts[0].iban, 'DE12500105170648489890');
});

test('PSD2: Sync holt Umsätze in die Inbox', async () => {
  const r = await api('POST', '/api/t/bank/psd2/sync', { token });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.added, 2);
  const inbox = await api('GET', '/api/t/inbox', { token });
  const item = inbox.data.items.find((i) => i.kind === 'bank-tx' && i.source === 'psd2');
  assert.ok(item, 'Bank-Transaktionen in Inbox');
  assert.equal(item.payload.transactions.length, 2);
  assert.equal(item.payload.transactions[0].amount, -142.8);
  // Zweiter Sync: keine Doppelungen
  const r2 = await api('POST', '/api/t/bank/psd2/sync', { token });
  assert.equal(r2.data.added, 0);
});

test('PSD2: trennen entfernt die Verbindung', async () => {
  const r = await api('POST', '/api/t/bank/psd2/disconnect', { token });
  assert.equal(r.status, 200);
  const st = await api('GET', '/api/t/bank/psd2/status', { token });
  assert.equal(st.data.connected, false);
});
