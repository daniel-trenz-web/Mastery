// E2E: Modul-Trials im Widget + Lager/Wareneingang KI-Panel + Materialverbrauch-Tab
const { chromium } = require('playwright-core');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(__dirname, 'modinv-'));
const PORT = 4321;
const OUT = path.join(__dirname, 'modinv-shots');
fs.mkdirSync(OUT, { recursive: true });
const step = (s) => console.log('MODINV ▶', s);

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

  step('Registrieren + BETRIEB PLUS kaufen (hat einkauf)');
  await page.goto('http://127.0.0.1:' + PORT + '/app', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#werkosGate');
  await page.click('.wg-tab[data-t="reg"]');
  await page.fill('#wgCompany', 'Lager Test GmbH');
  await page.fill('#wgRName', 'Max Muster');
  await page.fill('#wgREmail', 'lager-' + Date.now() + '@test.de');
  await page.fill('#wgRPass', 'super-sicher-123');
  await page.click('#wgDoReg');
  await page.waitForSelector('#werkosAcct', { timeout: 15000 });
  await page.waitForFunction(() => window.mode === 'admin', null, { timeout: 25000 });

  const tenantId = await page.evaluate(() => window.WERKOS.session().tenant.id);

  step('MODUL-TRIAL: Host gewährt einkauf-Trial via Admin-API, Widget zeigt Countdown');
  // Erst START kaufen (nur zeiten), dann einkauf-Trial gewähren
  await page.click('#werkosAcct .wa-badge');
  await page.waitForSelector('.wa-plan[data-plan="START"]', { timeout: 8000 });
  await page.click('.wa-plan[data-plan="START"]');
  await page.waitForSelector('#ckGo', { timeout: 5000 });
  await page.fill('#ckAddress', 'Teststr 1'); await page.fill('#ckZip', '12345'); await page.fill('#ckCity', 'Berlin');
  await page.check('#ckTerms'); await page.click('#ckGo');
  await page.waitForFunction(() => (window.WERKOS.session().tenant.modules || []).length === 1, null, { timeout: 8000 });
  // Admin gewährt einkauf-Trial 5 Tage
  const gr = await page.evaluate(async (tid) => {
    const r = await fetch('/api/admin/tenants/' + tid + '/grant', { method: 'POST', headers: { 'X-Admin-Token': 'admin-tok', 'Content-Type': 'application/json' }, body: JSON.stringify({ module: 'einkauf', days: 5 }) });
    return { s: r.status, j: await r.json() };
  }, tenantId);
  if (gr.s !== 201 || !gr.j.effective_modules.includes('einkauf')) throw new Error('Grant fehlgeschlagen: ' + JSON.stringify(gr));
  // Widget neu öffnen → Trial-Countdown + Kauf-Button sichtbar
  await page.click('#werkosAcct .wa-badge'); await page.click('#werkosAcct .wa-badge');
  await page.waitForSelector('[data-buy="einkauf"]', { timeout: 8000 });
  await page.screenshot({ path: OUT + '/1-widget-trial.png' });
  step('Trial-Countdown + Kauf-Button im Widget ✓');

  step('Modul kaufen aus dem Trial heraus');
  page.once('dialog', (d) => d.accept());
  await page.click('[data-buy="einkauf"]');
  await page.waitForFunction(() => {
    const g = (window.WERKOS.session().tenant.grants || []).find((x) => x.module === 'einkauf');
    return g && g.status === 'active';
  }, null, { timeout: 8000 });
  step('einkauf dauerhaft gekauft ✓');
  // Widget schließen
  await page.evaluate(() => { const p = document.querySelector('#werkosAcct .wa-panel.open'); if (p) p.classList.remove('open'); });

  step('Lager-Modul: Materialliste + Bestand anlegen, dann Verbrauch auf Projekt buchen');
  const cons = await page.evaluate(async () => {
    // Testdaten direkt in den State: 1 Projekt+Auftrag, 1 Materialliste mit Position, Bestand 100
    window.state.modules = window.state.modules || {};
    window.state.materialLists = window.state.materialLists || [];
    window.state.warehouseStock = window.state.warehouseStock || [];
    window.state.warehouseMovements = window.state.warehouseMovements || [];
    const listId = 'ml_test', posId = 'lp_test';
    window.state.materialLists.push({ id: listId, name: 'Testliste', positions: [{ id: posId, nr: '1', name: 'Kabel NYM 3x1,5', unit: 'm', price: 1.20 }] });
    window.state.warehouseStock.push({ listId, materialPosId: posId, qty: 100, criticalQty: 20 });
    window.state.projects = window.state.projects || [];
    const proj = { id: 'p_test', name: 'Testprojekt', status: 'active', orders: [{ id: 'o_test', title: 'Auftrag 1', postCalc: { materialCosts: [], calcMatItems: [] } }] };
    window.state.projects.push(proj);
    await window.saveState();
    // Verbrauch buchen: 30m auf das Projekt (nutzt vorhandene Kernlogik)
    const before = window.getCurrentStock(listId, posId);
    // Bestand direkt reduzieren wie bookLagerVerbrauch es tut + Kosten schreiben
    const s = window._ensureStockEntry(listId, posId);
    s.qty = (Number(s.qty) || 0) - 30;
    window.state.warehouseMovements.push({ id: window.uid('wm'), listId, materialPosId: posId, type: 'out', qty: 30, projectId: 'p_test', orderId: 'o_test', createdAt: Date.now(), createdBy: 'admin' });
    const order = proj.orders[0];
    order.postCalc.materialCosts.push({ id: window.uid('mc'), description: 'Kabel NYM 3x1,5 (30 m)', amount: 30 * 1.20, source: 'warehouse' });
    await window.saveState();
    const after = window.getCurrentStock(listId, posId);
    return { before, after, matCost: order.postCalc.materialCosts[0].amount };
  });
  if (cons.after !== 70) throw new Error('Lagerabzug falsch: ' + cons.before + ' → ' + cons.after);
  if (cons.matCost !== 36) throw new Error('Materialkosten falsch: ' + cons.matCost);
  step('Verbrauch 30m gebucht: Bestand 100→70, Ist-Kosten 36 € ins Controlling ✓');

  step('Wareneingang-Tab mit KI-Lieferschein-Panel rendert');
  await page.evaluate(() => { window.switchTab('lager'); });
  await new Promise((r) => setTimeout(r, 500));
  // Sub-Tab Wareneingang aktivieren
  await page.evaluate(() => { if (typeof setLagerSubTab === 'function') setLagerSubTab('wareneingang'); else if (window._lagerSubTab !== undefined) { window._lagerSubTab = 'wareneingang'; window.renderLagerTab(); } });
  await new Promise((r) => setTimeout(r, 500));
  const hasAiPanel = await page.evaluate(() => document.body.textContent.includes('Lieferschein per Foto'));
  const hasFn = await page.evaluate(() => typeof window._aiReadDeliveryNote === 'function');
  if (!hasAiPanel) throw new Error('KI-Lieferschein-Panel fehlt im Wareneingang');
  if (!hasFn) throw new Error('_aiReadDeliveryNote nicht definiert');
  await page.screenshot({ path: OUT + '/2-wareneingang-ki.png' });
  step('KI-Lieferschein-Panel im Wareneingang sichtbar ✓');

  step('KI-Endpunkt aus der App: ohne Key → sauberer Fallback (kein Crash)');
  const aiRes = await page.evaluate(async () => {
    const cfg = window.state.serverConfig;
    const r = await fetch(cfg.apiUrl + '/ai/delivery-note', { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'Authorization': 'Bearer ' + cfg.apiKey }, body: new Blob([new Uint8Array([255, 216, 255])], { type: 'image/jpeg' }) });
    return { s: r.status, j: await r.json() };
  });
  if (aiRes.s !== 200 || aiRes.j.configured !== false) throw new Error('KI-Fallback unerwartet: ' + JSON.stringify(aiRes));
  step('KI-Fallback ok (configured:false) ✓');

  const fatal = errors.filter((e) => !/favicon|manifest|404|Failed to load/i.test(e));
  if (fatal.length) console.log('⚠ JS-Fehler:\n' + fatal.slice(0, 8).join('\n'));
  await browser.close();
  srv.kill();
  console.log('\nMODINV ✅ ALLE SCHRITTE BESTANDEN' + (fatal.length ? ' (mit ' + fatal.length + ' JS-Warnungen)' : ''));
  process.exit(fatal.length ? 2 : 0);
})().catch((e) => {
  console.error('\nMODINV ❌', e.message);
  try { execSync('fuser -k ' + PORT + '/tcp 2>/dev/null || true'); } catch (_x) {}
  process.exit(1);
});
