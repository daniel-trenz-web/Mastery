// Sales-Zyklus-E2E: Admin-Zentrale → Vertriebs-Angebot → Online-Abschluss → Kunde in App;
// plus Checkout aus dem Widget (Trial → zahlender Kunde).
const { chromium } = require('playwright-core');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(__dirname, 'sales-data-'));
const PORT = 4266;
const OUT = path.join(__dirname, 'sales-shots');
fs.mkdirSync(OUT, { recursive: true });
const step = (s) => console.log('SALES ▶', s);

(async () => {
  try { execSync('fuser -k ' + PORT + '/tcp 2>/dev/null'); } catch (_e) {}
  const srv = spawn('node', [require('path').join(__dirname, '..', 'server', 'src', 'index.js')], {
    env: Object.assign({}, process.env, { WERKOS_DATA_DIR: DATA, PORT: String(PORT), WERKOS_ADMIN_TOKEN: 'admin-tok' }),
    stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 1200));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });

  // --- 1) Checkout aus dem Widget: Trial-Kunde kauft BETRIEB ---
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:' + PORT + '/app', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#werkosGate');
  await page.click('.wg-tab[data-t="reg"]');
  await page.fill('#wgCompany', 'Checkout Bau GmbH');
  await page.fill('#wgRName', 'Karla Kauf');
  await page.fill('#wgREmail', 'kauf-' + Date.now() + '@test.de');
  await page.fill('#wgRPass', 'super-sicher-123');
  await page.click('#wgDoReg');
  await page.waitForSelector('#werkosAcct', { timeout: 15000 });
  await page.waitForFunction(() => window.mode === 'admin', null, { timeout: 25000 });

  await page.click('#werkosAcct .wa-badge');
  await page.waitForSelector('.wa-plan[data-plan="BETRIEB"]', { timeout: 8000 });
  await page.click('.wa-plan[data-plan="BETRIEB"]');
  await page.waitForSelector('#ckGo', { timeout: 5000 });
  await page.fill('#ckAddress', 'Handwerkerweg 7');
  await page.fill('#ckZip', '80331');
  await page.fill('#ckCity', 'München');
  await page.fill('#ckUst', 'DE123456789');
  await page.screenshot({ path: OUT + '/s1-checkout-form.png' });
  await page.check('#ckTerms');
  await page.click('#ckGo');
  await page.waitForFunction(() => {
    const t = window.WERKOS.session().tenant;
    return t.plan === 'BETRIEB' && t.subscription && t.subscription.priceEur === 35;
  }, null, { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: OUT + '/s2-abo-aktiv.png' });
  step('Widget-Checkout: Trial → zahlender BETRIEB-Kunde (35 €) ✓');

  // --- 2) Admin-Zentrale: KPIs + Vertriebs-Angebot mit Sonderpreis ---
  const admin = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  await admin.goto('http://127.0.0.1:' + PORT + '/admin', { waitUntil: 'domcontentloaded' });
  await admin.fill('#tok', 'admin-tok');
  await admin.click('#go');
  await admin.waitForSelector('.kpi', { timeout: 8000 });
  const kpiTxt = await admin.evaluate(() => document.getElementById('kpis').textContent);
  if (!/35,00/.test(kpiTxt)) throw new Error('MRR-KPI zeigt den Kauf nicht: ' + kpiTxt);
  await admin.screenshot({ path: OUT + '/s3-admin-kpis.png' });
  step('Admin-Zentrale: MRR + zahlender Kunde in KPIs ✓');

  // Mandanten-Detail öffnen (Abo + Rechnungsdaten sichtbar)
  await admin.click('[data-detail]');
  await admin.waitForFunction(() => document.body.textContent.includes('Handwerkerweg 7'), null, { timeout: 6000 });
  await admin.screenshot({ path: OUT + '/s4-admin-tenant-detail.png' });
  step('Admin: Mandanten-Detail mit Abo + Rechnungsadresse ✓');

  // Vertriebs-Angebot erstellen: BETRIEB_PLUS für 39 € statt 59 €
  await admin.click('.tabs button[data-tab="offers"]');
  await admin.waitForSelector('#soCompany', { timeout: 6000 });
  await admin.fill('#soCompany', 'Beratener Dachdecker GmbH');
  await admin.fill('#soName', 'Willi Wunsch');
  await admin.fill('#soEmail', 'willi-' + Date.now() + '@beraten.de');
  await admin.selectOption('#soPlan', 'BETRIEB_PLUS');
  await admin.fill('#soPrice', '39');
  await admin.fill('#soMsg', 'Hallo Herr Wunsch, wie am Telefon besprochen: Sonderpreis für die ersten 12 Monate.');
  await admin.click('#soGo');
  await admin.waitForSelector('.link-out', { timeout: 8000 });
  await admin.screenshot({ path: OUT + '/s5-admin-vertriebsangebot.png' });
  const aboUrl = await admin.evaluate(() => document.querySelector('.link-out').textContent.match(/http[s]?:\/\/[^\s#]+#[A-Za-z0-9_-]+/)[0]);
  step('Vertriebs-Angebot erstellt ✓ ' + aboUrl.slice(0, 55) + '…');

  // --- 3) Interessent schließt online ab (Handy-Viewport) ---
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const kunde = await ctx.newPage();
  await kunde.goto(aboUrl, { waitUntil: 'domcontentloaded' });
  await kunde.waitForSelector('#aGo', { timeout: 8000 });
  const angebotTxt = await kunde.evaluate(() => document.body.textContent);
  if (!angebotTxt.includes('39') || !angebotTxt.includes('Sonderpreis')) throw new Error('Angebotsseite unvollständig');
  await kunde.screenshot({ path: OUT + '/s6-kunde-abo-angebot.png', fullPage: true });
  await kunde.fill('#aPass', 'willis-neues-passwort-1');
  await kunde.check('#aTerms');
  await kunde.check('#aConsent');
  await kunde.click('#aGo');
  await kunde.waitForFunction(() => document.body.textContent.includes('Willkommen bei werkflow'), null, { timeout: 10000 });
  await kunde.screenshot({ path: OUT + '/s7-kunde-abgeschlossen.png', fullPage: true });
  step('Interessent hat online verbindlich abgeschlossen ✓');

  // Kunde landet eingeloggt in der App mit allen Modulen
  await kunde.click('a[href="/app"]');
  await kunde.waitForFunction(() => window.WERKOS && window.WERKOS.session() && window.WERKOS.session().tenant.plan === 'BETRIEB_PLUS', null, { timeout: 20000 });
  step('Neukunde eingeloggt, BETRIEB PLUS aktiv (39 € Sonderpreis) ✓');

  // --- 4) Admin sieht den Abschluss ---
  await admin.click('.tabs button[data-tab="offers"]');
  await admin.waitForFunction(() => document.body.textContent.includes('accepted'), null, { timeout: 8000 });
  await admin.click('.tabs button[data-tab="leads"]');
  await admin.waitForFunction(() => document.body.textContent.includes('Vertriebs-Angebot angenommen'), null, { timeout: 8000 });
  await admin.screenshot({ path: OUT + '/s8-admin-leads.png' });
  step('Admin sieht Abschluss in Angeboten + Leads ✓');

  await browser.close();
  srv.kill();
  console.log('\nSALES ✅ ALLE SCHRITTE BESTANDEN');
  process.exit(0);
})().catch((e) => {
  console.error('\nSALES ❌', e.message);
  try { execSync('fuser -k ' + PORT + '/tcp 2>/dev/null || true'); } catch (_x) {}
  process.exit(1);
});
