// E2E-Smoke-Test: Registrierung → App lädt → Auto-Sync → Reload → Login-Persistenz
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRATCH = __dirname;
const DATA = fs.mkdtempSync(path.join(SCRATCH, 'e2e-data-'));
const PORT = 4123;
const EMAIL = 'e2e-' + Date.now() + '@test.de';

async function main() {
  const srv = spawn('node', [require('path').join(__dirname, '..', 'server', 'src', 'index.js')], {
    env: Object.assign({}, process.env, { WERKOS_DATA_DIR: DATA, PORT: String(PORT) }),
    stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 1200));

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const step = (s) => console.log('E2E ▶', s);

  step('Seite laden');
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#werkosGate', { timeout: 10000 });
  step('Login-Gate sichtbar ✓');

  step('Betrieb registrieren');
  await page.click('.wg-tab[data-t="reg"]');
  await page.fill('#wgCompany', 'E2E Malerbetrieb GmbH');
  await page.fill('#wgRName', 'Erika Muster');
  await page.fill('#wgREmail', EMAIL);
  await page.fill('#wgRPass', 'super-sicher-123');
  await page.click('#wgDoReg');
  try {
    await page.waitForSelector('#werkosAcct', { timeout: 15000 });
  } catch (e) {
    const gateErr = await page.evaluate(() => (document.querySelector('#wgErr') || {}).textContent || '(kein Gate-Fehler)');
    throw new Error('Registrierung → Widget fehlgeschlagen. Gate-Meldung: ' + gateErr);
  }
  step('Registriert, Konto-Widget sichtbar ✓');

  // App-Kern geladen?
  await page.waitForFunction(() => window.state && window.__appLoadedAt, null, { timeout: 20000 });
  const cfg = await page.evaluate(() => window.state.serverConfig);
  if (!cfg || cfg.apiUrl !== 'http://127.0.0.1:' + PORT + '/api/t' || cfg.auth !== 'apikey' || !cfg.apiKey) {
    throw new Error('serverConfig nicht erzwungen: ' + JSON.stringify(cfg));
  }
  step('serverConfig aus SaaS-Session erzwungen ✓ (' + cfg.apiUrl + ')');

  step('Änderung anstoßen und Sync auslösen');
  await page.evaluate(async () => {
    window.state.projects = window.state.projects || [];
    window.state.projects.push({ id: 'e2e1', name: 'E2E Testprojekt' });
    if (typeof window.saveState === 'function') await window.saveState();
    if (typeof window.syncToServer === 'function') await window.syncToServer({ silent: true });
  });
  // Server-seitig prüfen
  const chk = await page.evaluate(async () => {
    const r = await fetch('/api/t/state', { headers: { Authorization: 'Bearer ' + window.state.serverConfig.apiKey } });
    return { status: r.status, rev: r.headers.get('X-State-Rev'), body: await r.json() };
  });
  if (chk.status !== 200 || !(chk.body.projects || []).some((p) => p.name === 'E2E Testprojekt')) {
    throw new Error('State kam nicht auf dem Server an: ' + JSON.stringify(chk).slice(0, 300));
  }
  step('State auf Server gespeichert ✓ (Revision ' + chk.rev + ')');

  step('Konto-Widget öffnen: Tarif + GoBD-Prüfung');
  await page.click('#werkosAcct .wa-badge');
  await page.waitForSelector('#werkosAcct .wa-panel.open', { timeout: 5000 });
  await page.waitForSelector('#waVerify', { timeout: 5000 });
  await page.click('#waVerify');
  await page.waitForFunction(() => document.querySelector('#waVerify') && document.querySelector('#waVerify').textContent.includes('intakt'), null, { timeout: 5000 });
  step('GoBD-Prüfkette im UI verifiziert ✓');

  step('Mitarbeiter-Einladung erzeugen');
  await page.click('#waInvite');
  await page.waitForSelector('#waInviteOut .wa-link', { timeout: 5000 });
  const inviteUrl = await page.evaluate(() => document.querySelector('#waInviteOut .wa-link').textContent.match(/http\S+/)[0]);
  step('Einladungslink: ' + inviteUrl.slice(0, 60) + '…');

  step('Reload: Session bleibt bestehen, kein Gate');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#werkosAcct', { timeout: 15000 });
  const gateAfter = await page.$('#werkosGate');
  if (gateAfter) throw new Error('Gate erschien trotz aktiver Session');
  step('Session-Persistenz ✓');

  step('Mitarbeiter tritt per Magic-Link bei (frischer Kontext)');
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await p2.goto(inviteUrl, { waitUntil: 'domcontentloaded' });
  await p2.waitForSelector('#wgJoin', { timeout: 10000 });
  await p2.fill('#wgName', 'Azubi Tim');
  await p2.click('#wgJoin');
  await p2.waitForSelector('#werkosAcct', { timeout: 15000 });
  const role = await p2.evaluate(() => JSON.parse(localStorage.getItem('werkos_session_v1')).user.role);
  if (role !== 'employee') throw new Error('Falsche Rolle: ' + role);
  // Mitarbeiter sieht die Betriebsdaten (gemeinsamer Mandant)
  await p2.waitForFunction(() => window.state && window.__appLoadedAt, null, { timeout: 20000 });
  const empSees = await p2.evaluate(async () => {
    const r = await fetch('/api/t/state', { headers: { Authorization: 'Bearer ' + JSON.parse(localStorage.getItem('werkos_session_v1')).accessToken } });
    const j = await r.json();
    return (j.projects || []).some((p) => p.name === 'E2E Testprojekt');
  });
  if (!empSees) throw new Error('Mitarbeiter sieht Betriebsdaten nicht');
  step('Mitarbeiter-Beitritt + gemeinsame Datenbasis ✓');

  const fatal = errors.filter((e) => !/favicon|manifest|apple-touch|net::ERR|404|Failed to load resource|ServiceWorker|sw\.js/i.test(e));
  if (fatal.length) console.log('⚠ JS-Fehler auf der Seite:\n' + fatal.slice(0, 10).join('\n'));

  await browser.close();
  srv.kill();
  console.log('\nE2E ✅ ALLE SCHRITTE BESTANDEN' + (fatal.length ? ' (mit ' + fatal.length + ' JS-Warnungen, siehe oben)' : ''));
  process.exit(0);
}

main().catch((e) => {
  console.error('\nE2E ❌', e.message);
  try { require('child_process').execSync('fuser -k ' + PORT + '/tcp 2>/dev/null || true'); } catch (_x) {}
  process.exit(1);
});
