// E2E v2: Auto-Unlock, Modul-Gating, Angebots-Link-Flow mit Unterschrift, Overlap-Audit
const { chromium } = require('playwright-core');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(__dirname, 'e2e2-data-'));
const PORT = 4211;
const OUT = path.join(__dirname, 'shots2');
fs.mkdirSync(OUT, { recursive: true });
const step = (s) => console.log('E2E2 ▶', s);

(async () => {
  try { execSync('fuser -k ' + PORT + '/tcp 2>/dev/null'); } catch (_e) {}
  const srv = spawn('node', [require('path').join(__dirname, '..', 'server', 'src', 'index.js')], {
    env: Object.assign({}, process.env, { WERKOS_DATA_DIR: DATA, PORT: String(PORT), WERKOS_ADMIN_TOKEN: 'admin-tok' }),
    stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 1200));

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  step('Registrieren');
  await page.goto('http://127.0.0.1:' + PORT + '/app', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#werkosGate');
  await page.screenshot({ path: OUT + '/01-gate.png' });
  await page.click('.wg-tab[data-t="reg"]');
  await page.fill('#wgCompany', 'Muster Bau GmbH');
  await page.fill('#wgRName', 'Erika Muster');
  await page.fill('#wgREmail', 'e2e2-' + Date.now() + '@test.de');
  await page.fill('#wgRPass', 'super-sicher-123');
  await page.click('#wgDoReg');
  await page.waitForSelector('#werkosAcct', { timeout: 15000 });

  step('AUTO-UNLOCK: App muss ohne zweiten Login in Admin-Modus gehen');
  await page.waitForFunction(() => window.mode === 'admin', null, { timeout: 25000 });
  await new Promise((r) => setTimeout(r, 2000));
  await page.screenshot({ path: OUT + '/02-unlocked-admin.png' });
  const loginBtnVisible = await page.evaluate(() => {
    const b = document.getElementById('unifiedLoginBtn');
    return b && b.offsetParent !== null;
  });
  if (loginBtnVisible) throw new Error('Interner Anmelden-Button noch sichtbar');
  step('Admin-Modus aktiv, interner Login versteckt ✓');

  step('Overlap-Audit: fixe Elemente gegeneinander prüfen');
  const overlaps = await page.evaluate(() => {
    const els = [];
    document.querySelectorAll('body *').forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' && el.offsetWidth > 5 && el.offsetHeight > 5 && cs.visibility !== 'hidden' && cs.pointerEvents !== 'none') {
        const r = el.getBoundingClientRect();
        if (r.width < window.innerWidth * 0.95) els.push({ id: el.id || el.className.toString().slice(0, 30), rect: { x: r.x, y: r.y, w: r.width, h: r.height } });
      }
    });
    const out = [];
    for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
      const a = els[i].rect, b = els[j].rect;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) out.push([els[i].id, els[j].id]);
    }
    return { els, out };
  });
  fs.writeFileSync(OUT + '/overlaps.json', JSON.stringify(overlaps, null, 2));
  step('Fixe Elemente: ' + overlaps.els.length + ', Überdeckungen: ' + overlaps.out.length + (overlaps.out.length ? ' → ' + JSON.stringify(overlaps.out) : ' ✓'));

  step('Modul-Gating: TRIAL zeigt alles, START blendet aus');
  const navTrial = await page.evaluate(() => Array.from(document.querySelectorAll('.sidenav-item .label')).map((x) => x.textContent.trim()));
  if (!navTrial.includes('Rechnungen') || !navTrial.includes('Einkauf & Lager')) throw new Error('TRIAL-Nav unvollständig: ' + navTrial.join(','));
  // Tarif via Widget → START
  await page.click('#werkosAcct .wa-badge');
  await page.waitForSelector('#werkosAcct .wa-panel.open');
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: OUT + '/03-widget.png' });
  page.once('dialog', (d) => d.accept());
  await page.click('.wa-plan[data-plan="START"]');
  await page.waitForFunction(() => (window.WERKOS.session().tenant.modules || []).length === 1, null, { timeout: 8000 });
  await page.evaluate(() => window.render && window.render());
  await new Promise((r) => setTimeout(r, 800));
  const navStart = await page.evaluate(() => Array.from(document.querySelectorAll('.sidenav-item .label')).map((x) => x.textContent.trim()));
  if (navStart.includes('Rechnungen') || navStart.includes('Angebote') || navStart.includes('Einkauf & Lager')) {
    throw new Error('START-Tarif: gesperrte Module noch sichtbar: ' + navStart.join(','));
  }
  if (!navStart.includes('Mitarbeiter')) throw new Error('START-Tarif: zeiten-Modul fehlt');
  await page.screenshot({ path: OUT + '/04-start-nav.png' });
  step('Navigation folgt dem Tarif ✓ (START: ' + navStart.length + ' Einträge statt ' + navTrial.length + ')');

  step('Host-Override: Admin schaltet "geld" zusätzlich frei');
  const tenantId = await page.evaluate(() => window.WERKOS.session().tenant.id);
  const ov = await page.evaluate(async ({ tid }) => {
    const r = await fetch('/api/admin/tenants/' + tid + '/modules', {
      method: 'POST', headers: { 'X-Admin-Token': 'admin-tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: { geld: true } }),
    });
    return { s: r.status, j: await r.json() };
  }, { tid: tenantId });
  if (ov.s !== 200 || !ov.j.effective_modules.includes('geld')) throw new Error('Override fehlgeschlagen: ' + JSON.stringify(ov));
  // Widget neu öffnen → Session aktualisiert Module
  await page.click('#werkosAcct .wa-badge'); // schließen
  await page.click('#werkosAcct .wa-badge'); // öffnen → renderPanel aktualisiert Session
  await page.waitForFunction(() => (window.WERKOS.session().tenant.modules || []).includes('geld'), null, { timeout: 8000 });
  await page.click('#werkosAcct .wa-badge'); // schließen
  await page.evaluate(() => window.render && window.render());
  await new Promise((r) => setTimeout(r, 600));
  const navOv = await page.evaluate(() => Array.from(document.querySelectorAll('.sidenav-item .label')).map((x) => x.textContent.trim()));
  if (!navOv.includes('Angebote')) throw new Error('Host-Override: Angebote-Tab fehlt: ' + navOv.join(','));
  step('Host-Override schaltet Modul live frei ✓');

  step('Angebots-Flow: Angebot anlegen (per State), teilen, Kunde unterschreibt');
  await page.evaluate(async () => {
    window.state.angebote = window.state.angebote || [];
    window.state.angebote.push({
      id: 'ang-e2e', number: 'AN-2026-0099', title: 'Fassadenanstrich EFH',
      date: '2026-07-08', validUntil: '2026-08-08', status: 'draft',
      kundeSnapshot: { name: 'Familie Beispiel' }, vatRate: 19,
      net: 4200, ust: 798, gross: 4998,
      items: [
        { isHeader: true, name: 'Malerarbeiten' },
        { nr: 1, name: 'Fassade streichen, 2 Anstriche', qty: 120, unit: 'm²', price: 28 },
        { nr: 2, name: 'Gerüst stellen', qty: 1, unit: 'psch', price: 840 },
      ],
      description: 'Fassadenanstrich inkl. Vorarbeiten.', notes: 'Angebot 30 Tage gültig.',
    });
    await window.saveState();
    window.openAngebotDetail('ang-e2e');
  });
  await page.waitForSelector('.modal', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: OUT + '/05-angebot-detail.png' });
  await page.click('button:has-text("Kunden-Link")');
  await page.waitForSelector('#wkShareUrl', { timeout: 8000 });
  await page.screenshot({ path: OUT + '/06-share-dialog.png' });
  const offerUrl = await page.evaluate(() => document.getElementById('wkShareUrl').textContent.trim());
  const waHref = await page.evaluate(() => (document.querySelector('#modalContent a[href*="wa.me"]') || {}).href || '');
  if (!waHref.includes('wa.me')) throw new Error('WhatsApp-Button fehlt');
  step('Link erzeugt ✓ ' + offerUrl.slice(0, 60) + '… (WhatsApp-Share vorhanden)');

  // Kunde: öffnet Link im frischen Kontext, unterschreibt, nimmt an
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } }); // Handy!
  const p2 = await ctx2.newPage();
  await p2.goto(offerUrl, { waitUntil: 'domcontentloaded' });
  await p2.waitForSelector('#btnAccept', { timeout: 8000 });
  await p2.screenshot({ path: OUT + '/07-kunde-angebot-mobil.png', fullPage: true });
  await p2.fill('#rName', 'Hans Beispiel');
  await p2.fill('#rComment', 'Bitte Start in KW 33');
  // Unterschrift zeichnen
  const sig = await p2.$('#sig');
  const box = await sig.boundingBox();
  await p2.mouse.move(box.x + 30, box.y + 80);
  await p2.mouse.down();
  for (let i = 0; i < 12; i++) await p2.mouse.move(box.x + 30 + i * 18, box.y + 80 + Math.sin(i) * 30);
  await p2.mouse.up();
  await p2.screenshot({ path: OUT + '/08-kunde-unterschrift.png', fullPage: true });
  await p2.click('#btnAccept');
  await p2.waitForSelector('.done', { timeout: 8000 });
  await p2.screenshot({ path: OUT + '/09-kunde-angenommen.png', fullPage: true });
  step('Kunde hat mobil unterschrieben und angenommen ✓');

  step('Rückfluss zum Mandanten: Status muss auf "Angenommen" springen');
  await page.evaluate(() => { const m = document.getElementById('modal'); if (m) m.style.display = 'none'; });
  await page.evaluate(() => window.WERKOS.syncOfferResponses());
  await page.waitForFunction(() => {
    const a = (window.state.angebote || []).find((x) => x.id === 'ang-e2e');
    return a && a.status === 'accepted' && a.acceptedByCustomer && a.acceptedByCustomer.name === 'Hans Beispiel';
  }, null, { timeout: 10000 });
  await page.evaluate(() => window.openAngebotDetail('ang-e2e'));
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: OUT + '/10-mandant-angenommen.png' });
  step('Antwort inkl. Name + Kommentar beim Mandanten angekommen ✓');

  step('Betreiber-Konsole prüfen');
  const p3 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await p3.goto('http://127.0.0.1:' + PORT + '/admin', { waitUntil: 'domcontentloaded' });
  await p3.fill('#tok', 'admin-tok');
  await p3.click('#go');
  await p3.waitForSelector('table', { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 400));
  await p3.screenshot({ path: OUT + '/11-admin-konsole.png' });
  const adminHasTenant = await p3.evaluate(() => document.body.textContent.includes('Muster Bau GmbH'));
  if (!adminHasTenant) throw new Error('Admin-Konsole zeigt Mandanten nicht');
  step('Betreiber-Konsole zeigt Mandanten + Module ✓');

  const fatal = errors.filter((e) => !/favicon|manifest|404|Failed to load|ServiceWorker/i.test(e));
  if (fatal.length) console.log('⚠ JS-Fehler:\n' + fatal.slice(0, 8).join('\n'));
  await browser.close();
  srv.kill();
  console.log('\nE2E2 ✅ ALLE SCHRITTE BESTANDEN' + (fatal.length ? ' (' + fatal.length + ' JS-Warnungen)' : ''));
  process.exit(0);
})().catch((e) => {
  console.error('\nE2E2 ❌', e.message);
  try { execSync('fuser -k ' + PORT + '/tcp 2>/dev/null || true'); } catch (_x) {}
  process.exit(1);
});
