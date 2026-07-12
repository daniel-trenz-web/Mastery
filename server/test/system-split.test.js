'use strict';
// Trennung System ↔ Website: Im SYSTEM_ONLY-Modus liefert der Server nur
// App/API/Admin aus; Marketing-Routen leiten auf die externe Website um.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'werkos-split-'));
process.env.WERKOS_DATA_DIR = TMP;
process.env.WERKOS_ADMIN_TOKEN = 'split-admin';
process.env.WERKOS_SYSTEM_ONLY = 'true';
process.env.WERKOS_MARKETING_URL = 'https://example-marketing.test';

const { createServer } = require('../src/server');

let BASE, server;
test.before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => { server.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('SYSTEM_ONLY: Marketing-Routen leiten auf die Website um', async () => {
  for (const p of ['/', '/preise', '/funktionen', '/faq', '/impressum', '/datenschutz']) {
    const r = await fetch(BASE + p, { redirect: 'manual' });
    assert.equal(r.status, 302, p + ' sollte umleiten');
    const loc = r.headers.get('location');
    assert.ok(loc && loc.startsWith('https://example-marketing.test'), p + ' → ' + loc);
  }
});

test('SYSTEM_ONLY: App, Admin und API bleiben erreichbar', async () => {
  const app = await fetch(BASE + '/app');
  assert.equal(app.status, 200);
  assert.ok((await app.text()).includes('saas.js'), '/app = die PWA');
  const admin = await fetch(BASE + '/admin');
  assert.equal(admin.status, 200, 'Admin-Konsole erreichbar');
  // API funktioniert (Registrierung → Demozugang etc.)
  const reg = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company: 'Split GmbH', email: 'split@test.de', name: 'Chef', password: 'passwort-1234' }),
  });
  assert.equal(reg.status, 201, 'API im System-Modus aktiv');
});
