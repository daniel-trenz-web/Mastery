/* WERKOS SaaS-Bootstrap (v2)
 * Macht aus der Einzelplatz-PWA einen Mandanten-Client:
 *  - Login / Betriebs-Registrierung / Magic-Link-Beitritt (Overlay vor App-Start)
 *  - AUTO-UNLOCK: WERKOS-Rolle steuert den App-Modus — kein zweiter Login mehr
 *    (owner/office → Admin, external → Lese-Modus, employee → Mitarbeiter/Lese-Modus)
 *  - MODUL-FREISCHALTUNG: Tarif + Host-Overrides steuern state.modules der App
 *  - ANGEBOTS-LINKS: Angebot per Link/WhatsApp teilen, Kunde unterschreibt,
 *    Antwort fließt automatisch in den Angebots-Status der App zurück
 *  - Konto-Widget: Team-Einladungen (Link + QR), Tarifwahl, DSGVO-Export
 *  - Token-Refresh (beim Start + alle 4 h)
 */
(function () {
  'use strict';
  var API = location.origin + '/api';
  var SKEY = 'werkos_session_v1';
  // Statischer Demo-Modus (z. B. GitHub Pages): kein Backend — App läuft als
  // Einzelplatz-Demo, Daten bleiben im Browser (localStorage/IndexedDB).
  var STATIC = !!window.WERKOS_STATIC;

  function getSession() {
    try { return JSON.parse(localStorage.getItem(SKEY) || 'null'); } catch (e) { return null; }
  }
  function setSession(s) { try { localStorage.setItem(SKEY, JSON.stringify(s)); } catch (e) {} }
  function clearSession() { try { localStorage.removeItem(SKEY); } catch (e) {} }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toast(msg) {
    if (typeof window.mToast === 'function') { try { window.mToast(msg); return; } catch (e) {} }
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#16324e;color:#fff;' +
      'padding:11px 18px;border-radius:10px;font-size:13px;z-index:2147483200;box-shadow:0 6px 20px rgba(0,0,0,.3);max-width:90vw;';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 4200);
  }

  function req(method, path, body, token) {
    var h = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = 'Bearer ' + token;
    return fetch(API + path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, data: j }; }); });
  }
  function authed(method, path, body) {
    var s = getSession();
    return req(method, path, body, s && s.accessToken);
  }

  // --------------------------------------------------------------------------
  // 1) Server-Konfiguration + Modul-Freischaltung in die App drücken
  //    (wird aus app.html nach loadState() aufgerufen)
  // --------------------------------------------------------------------------
  function applyServerConfig() {
    var s = getSession();
    if (!s || !window.state) return;
    var cfg = window.state.serverConfig || (window.state.serverConfig = {});
    cfg.apiUrl = location.origin + '/api/t';
    cfg.auth = 'apikey';
    cfg.apiKey = s.accessToken;
    cfg.tenantKey = s.tenant && s.tenant.id;
    cfg.autoSync = true;
    if (!cfg.syncIntervalSec || cfg.syncIntervalSec < 30) cfg.syncIntervalSec = 60;
    applyModules();
  }

  // WERKOS-Module (Tarif + Host-Override) → App-Funktionsbereiche (state.modules).
  // Nicht freigeschaltete Bereiche verschwinden aus der Navigation der App.
  function applyModules() {
    var s = getSession();
    if (!s || !window.state || !s.tenant || !s.tenant.moduleCatalog) return;
    var allowed = s.tenant.modules || [];
    var states = s.tenant.moduleStates || {};       // {werkKey: 'on'|'locked'|'off'}
    var mods = window.state.modules || (window.state.modules = {});
    var vis = window.state.moduleStates || (window.state.moduleStates = {}); // appKey -> Tri-State
    var werk = (window.state.moduleWerk = {});      // appKey -> werkKey (für Upsell-Preis)
    Object.keys(s.tenant.moduleCatalog).forEach(function (wk) {
      var st = states[wk] || (allowed.indexOf(wk) >= 0 ? 'on' : 'locked');
      var on = st === 'on';
      (s.tenant.moduleCatalog[wk].appModules || []).forEach(function (appKey) {
        mods[appKey] = on;          // nutzbar?
        vis[appKey] = st;           // sichtbar/gesperrt/aus
        werk[appKey] = wk;          // welches verkaufbare Modul steckt dahinter
      });
    });
    // Preisbild (Modul×MA) für den Self-Service-Upsell verfügbar machen.
    window.state.pricing = s.tenant.pricing || null;
  }

  function refreshSession() {
    var s = getSession();
    if (!s || !s.refreshToken) return Promise.resolve(false);
    return req('POST', '/auth/refresh', { refreshToken: s.refreshToken }).then(function (r) {
      if (r.status !== 200) {
        if (r.status === 401) { clearSession(); location.reload(); }
        return false;
      }
      setSession(r.data);
      applyServerConfig();
      return true;
    }).catch(function () { return false; });
  }

  function logout() {
    if (!confirm('Von werkflow abmelden?')) return;
    var s = getSession();
    var done = function () { clearSession(); location.reload(); };
    if (s) req('POST', '/auth/logout', {}, s.accessToken).then(done, done); else done();
  }

  // --------------------------------------------------------------------------
  // 2) AUTO-UNLOCK — die WERKOS-Rolle steuert den App-Modus (kein Doppel-Login)
  // --------------------------------------------------------------------------
  function desiredAppMode() {
    var s = getSession();
    if (!s) return null;
    var role = s.user && s.user.role;
    if (role === 'owner' || role === 'office') return { mode: 'admin' };
    if (role === 'external') return { mode: 'guest' };
    if (role === 'employee') {
      // Mitarbeiter-Profil in der App per Namen zuordnen (Chef legt es unter „Mitarbeiter" an)
      var emp = (window.state && window.state.employees || []).find(function (e) {
        return e && e.name && s.user.name && e.name.trim().toLowerCase() === s.user.name.trim().toLowerCase();
      });
      if (emp) return { mode: 'employee', empId: emp.id };
      return { mode: 'guest', hint: 'ℹ Du bist im Lese-Modus. Der Chef kann dir unter „Mitarbeiter" ein Profil mit deinem Namen („' + (s.user.name || '') + '") anlegen — dann bekommst du deine Mitarbeiter-Ansicht.' };
    }
    return { mode: 'guest' };
  }

  var _unlockHinted = false;
  function autoUnlock() {
    if (!getSession()) return;
    if (!window.__appLoadedAt || typeof window.setMode !== 'function') return;
    if (window.mode !== 'locked') { tidyHeader(); return; }
    var want = desiredAppMode();
    if (!want) return;
    try {
      window.setMode(want.mode, want.empId || null);
      tidyHeader();
      if (want.hint && !_unlockHinted) { _unlockHinted = true; setTimeout(function () { toast(want.hint); }, 800); }
    } catch (e) { /* App noch nicht bereit — nächster Tick */ }
  }

  // Interne Login-/Logout-Knöpfe der App aufräumen: WERKOS besitzt die Anmeldung.
  function tidyHeader() {
    var s = getSession();
    if (!s) return;
    var lb = document.getElementById('unifiedLoginBtn');
    if (lb) lb.style.display = 'none';
    var lock = document.getElementById('lockBtn');
    if (lock && !lock._werkos) {
      lock._werkos = true;
      lock.textContent = 'Abmelden';
      lock.title = 'Von werkflow abmelden';
      lock.addEventListener('click', function (e) {
        e.stopImmediatePropagation(); e.preventDefault();
        logout();
      }, true);
    }
  }

  // --------------------------------------------------------------------------
  // 3) ANGEBOTS-LINKS — teilen per WhatsApp, Kunde unterschreibt, Status zurück
  // --------------------------------------------------------------------------
  function buildOfferPayload(ang) {
    var k = ang.kundeSnapshot || {};
    return {
      number: ang.number, title: ang.title || '', date: ang.date, validUntil: ang.validUntil,
      kunde: k.name || '', description: ang.description || '', notes: ang.notes || '',
      vatRate: ang.vatRate != null ? ang.vatRate : 19,
      net: ang.net, ust: ang.ust, gross: ang.gross,
      items: (ang.items || []).map(function (it) {
        return {
          isHeader: !!it.isHeader, nr: it.nr, name: it.name || '',
          qty: it.qty, unit: it.unit || '', price: it.price, discount: it.discount || 0,
        };
      }),
    };
  }

  function shareAngebot(angId) {
    if (STATIC) { toast('🧪 Demo-Modus: Kunden-Links brauchen den werkflow-Server (siehe Anleitung).'); return; }
    var st = window.state || {};
    var ang = (st.angebote || []).find(function (a) { return a.id === angId; });
    if (!ang) { toast('Angebot nicht gefunden.'); return; }
    authed('POST', '/t/offers/share', { angebotId: ang.id, payload: buildOfferPayload(ang) })
      .then(function (r) {
        if (r.status === 403 && r.data.error === 'module-not-active') { toast('Modul „Angebote & Rechnungen" ist in deinem Tarif nicht aktiv.'); return; }
        if (r.status !== 201) { toast('Fehler beim Erstellen des Links (' + (r.data.error || r.status) + ')'); return; }
        ang.werkosLinkId = r.data.linkId;
        if (ang.status === 'draft' || !ang.status) { ang.status = 'sent'; ang.sentAt = Date.now(); }
        if (typeof window.saveState === 'function') window.saveState();
        showShareDialog(ang, r.data.url, r.data.expiresAt);
      });
  }

  function showShareDialog(ang, url, expiresAt) {
    var k = (ang.kundeSnapshot || {}).name || '';
    var waText = 'Guten Tag' + (k ? ' ' + k : '') + ',\n\nhier ist unser Angebot ' + ang.number +
      (ang.title ? ' („' + ang.title + '")' : '') + ' zum Ansehen und direkten Annehmen per Unterschrift:\n\n' + url +
      '\n\nBei Fragen gerne melden!\n' + ((getSession() || {}).tenant || {}).name;
    var wa = 'https://wa.me/?text=' + encodeURIComponent(waText);
    var html = '<h2>📲 Angebot ' + esc(ang.number) + ' teilen</h2>' +
      '<p style="font-size:13px;color:#567;">Der Kunde öffnet den Link, sieht das Angebot und kann es <b>direkt digital unterschreiben und annehmen</b>. Die Antwort erscheint automatisch hier im System.</p>' +
      '<div style="background:#f4f7fa;border:1px solid #e0e7ee;border-radius:9px;padding:10px;font-size:12px;word-break:break-all;" id="wkShareUrl">' + esc(url) + '</div>' +
      '<div style="font-size:11px;color:#889;margin-top:4px;">Gültig bis ' + esc(new Date(expiresAt).toLocaleDateString('de-DE')) + ' · jederzeit widerrufbar (werkflow-Menü unten links)</div>' +
      '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">' +
      '<a href="' + esc(wa) + '" target="_blank" rel="noopener" style="text-decoration:none;"><button class="success" style="background:#25D366;">🟢 Per WhatsApp senden</button></a>' +
      '<button class="secondary" id="wkCopyBtn">📋 Link kopieren</button>' +
      '<button class="secondary" id="wkQrBtn">🔳 QR-Code</button>' +
      '</div><div id="wkQrOut" style="margin-top:12px;"></div>' +
      '<div class="modal-buttons"><button class="secondary" onclick="closeModal()">Schließen</button></div>';
    if (typeof window.showModal === 'function') window.showModal(html);
    else { prompt('Angebots-Link (kopieren):', url); return; }
    var cp = document.getElementById('wkCopyBtn');
    if (cp) cp.onclick = function () {
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(
        function () { cp.textContent = '✓ Kopiert'; },
        function () { prompt('Link kopieren:', url); }
      );
    };
    var qb = document.getElementById('wkQrBtn');
    if (qb) qb.onclick = function () {
      var out = document.getElementById('wkQrOut');
      out.innerHTML = '';
      try { new QRCode(out, { text: url, width: 180, height: 180 }); qb.style.display = 'none'; }
      catch (e) { out.textContent = 'QR-Bibliothek nicht geladen.'; }
    };
  }

  // Kundenantworten abholen und in die App zurückspielen (Status + Toast)
  function syncOfferResponses(opts) {
    var s = getSession();
    if (!s || !window.state) return Promise.resolve([]);
    var role = s.user && s.user.role;
    if (role !== 'owner' && role !== 'office') return Promise.resolve([]);
    return authed('GET', '/t/offers/links').then(function (r) {
      if (r.status !== 200) return [];
      var links = r.data.links || [];
      var st = window.state;
      var changed = false;
      links.forEach(function (l) {
        if (l.status !== 'accepted' && l.status !== 'declined') return;
        var ang = (st.angebote || []).find(function (a) {
          return a.werkosLinkId === l.id || (l.number && a.number === l.number);
        });
        if (!ang || ang._werkosApplied === l.id) return;
        ang._werkosApplied = l.id;
        ang.werkosLinkId = l.id;
        if (l.status === 'accepted' && ang.status !== 'accepted' && ang.status !== 'converted') {
          ang.status = 'accepted'; ang.acceptedAt = Date.parse(l.responded_at) || Date.now();
          ang.acceptedByCustomer = { name: l.responder_name, at: l.responded_at, comment: l.responder_comment || '', linkId: l.id };
          changed = true;
          if (!opts || !opts.silent) toast('🎉 Angebot ' + (ang.number || '') + ' wurde von ' + (l.responder_name || 'Kunde') + ' angenommen & unterschrieben!');
        } else if (l.status === 'declined' && ang.status !== 'rejected') {
          ang.status = 'rejected'; ang.rejectedAt = Date.parse(l.responded_at) || Date.now();
          ang.declinedByCustomer = { name: l.responder_name, at: l.responded_at, comment: l.responder_comment || '', linkId: l.id };
          changed = true;
          if (!opts || !opts.silent) toast('Angebot ' + (ang.number || '') + ' wurde abgelehnt' + (l.responder_comment ? ': „' + l.responder_comment + '"' : '.'));
        }
      });
      if (changed) {
        if (typeof window.saveState === 'function') window.saveState();
        if (typeof window.render === 'function') { try { window.render(); } catch (e) {} }
      }
      return links;
    });
  }

  // --------------------------------------------------------------------------
  // 4) UI: Login-Gate + Konto-Widget
  // --------------------------------------------------------------------------
  var CSS = '\n' +
    '#werkosGate{position:fixed;inset:0;z-index:2147483000;background:linear-gradient(160deg,#12293f,#1a3a5c 55%,#24507c);display:flex;align-items:flex-start;justify-content:center;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;overflow:auto}' +
    '#werkosGate .wg-card{background:#fff;border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.4);max-width:430px;width:100%;padding:28px;margin:auto 0}' +
    '#werkosGate .wg-logo{width:44px;height:44px;border-radius:11px;background:#1a3a5c;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:20px;margin-bottom:12px}' +
    '#werkosGate h1{font-size:24px;color:#16324e;margin:0 0 2px}' +
    '#werkosGate .wg-sub{color:#667;font-size:13px;margin-bottom:18px;line-height:1.5}' +
    '#werkosGate .wg-tabs{display:flex;gap:6px;margin-bottom:16px;background:#eef1f5;border-radius:10px;padding:4px}' +
    '#werkosGate .wg-tab{flex:1;padding:9px;border:none;border-radius:8px;background:transparent;color:#345;font-weight:600;font-size:13px;cursor:pointer}' +
    '#werkosGate .wg-tab.on{background:#fff;color:#16324e;box-shadow:0 1px 4px rgba(0,0,0,.12)}' +
    '#werkosGate label{display:block;font-size:12px;font-weight:600;color:#456;margin:12px 0 4px}' +
    '#werkosGate input{width:100%;padding:11px;border:1px solid #cdd4dc;border-radius:9px;font-size:15px;box-sizing:border-box}' +
    '#werkosGate input:focus{outline:2px solid #2a5080;border-color:#2a5080}' +
    '#werkosGate .wg-btn{width:100%;margin-top:18px;padding:13px;border:none;border-radius:9px;background:#1a3a5c;color:#fff;font-size:15px;font-weight:700;cursor:pointer}' +
    '#werkosGate .wg-btn:hover{background:#2a5080}' +
    '#werkosGate .wg-btn:disabled{background:#9fb0c2}' +
    '#werkosGate .wg-err{color:#c0392b;font-size:13px;margin-top:10px;min-height:16px;font-weight:600}' +
    '#werkosGate .wg-foot{margin-top:14px;font-size:11px;color:#889;text-align:center;line-height:1.6}' +
    '#werkosGate .wg-trial{background:#eafaf1;color:#1e8449;border-radius:9px;padding:9px 10px;font-size:12px;margin-top:12px;text-align:center;font-weight:600}' +
    '#werkosGate .wg-buy{background:#fff5df;color:#8a6d1a;border:1px solid #f0dca8;border-radius:9px;padding:9px 11px;font-size:12.5px;margin:2px 0 14px;text-align:center;font-weight:600}' +
    '#werkosAcct{position:fixed;left:10px;bottom:10px;z-index:2147482000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}' +
    '#werkosAcct .wa-badge{display:flex;align-items:center;gap:7px;background:#0e2236;color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:22px;padding:6px 13px 6px 7px;font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.3)}' +
    '#werkosAcct .wa-badge .dot{width:22px;height:22px;border-radius:50%;background:#2ecc71;color:#0e2236;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800}' +
    '#werkosAcct .wa-panel{position:absolute;left:0;bottom:44px;width:330px;max-height:72vh;overflow:auto;background:#fff;border-radius:14px;box-shadow:0 14px 44px rgba(0,0,0,.35);padding:16px;display:none}' +
    '#werkosAcct .wa-panel.open{display:block}' +
    '#werkosAcct h3{margin:0 0 4px;font-size:15px;color:#16324e}' +
    '#werkosAcct .wa-row{font-size:12px;color:#556;margin:3px 0;display:flex;gap:6px;align-items:baseline}' +
    '#werkosAcct .wa-sec{border-top:1px solid #eef1f5;margin-top:12px;padding-top:12px}' +
    '#werkosAcct .wa-sec>b{font-size:11px;color:#789;text-transform:uppercase;letter-spacing:.5px}' +
    '#werkosAcct button.wa-act{display:block;width:100%;margin-top:6px;padding:9px 11px;border:none;border-radius:9px;background:#f0f3f7;color:#234;font-size:13px;font-weight:600;cursor:pointer;text-align:left}' +
    '#werkosAcct button.wa-act:hover{background:#e2e9f0}' +
    '#werkosAcct button.wa-act.primary{background:#1a3a5c;color:#fff}' +
    '#werkosAcct button.wa-act.primary:hover{background:#2a5080}' +
    '#werkosAcct button.wa-act.danger{background:#fdecea;color:#c0392b}' +
    '#werkosAcct .wa-plan{border:1.5px solid #dfe6ee;border-radius:10px;padding:9px 10px;margin-top:6px;cursor:pointer}' +
    '#werkosAcct .wa-plan:hover{border-color:#1a3a5c;background:#f8fafc}' +
    '#werkosAcct .wa-plan.current{border-color:#1e8449;background:#f4fbf7}' +
    '#werkosAcct .wa-plan b{color:#16324e}' +
    '#werkosAcct .wa-link{word-break:break-all;background:#f4f6f8;border-radius:7px;padding:7px;font-size:11px;margin-top:6px}' +
    '#werkosAcct .wa-warn{background:#fff3cd;color:#856404;border-radius:9px;padding:9px;font-size:12px;margin-top:8px;line-height:1.45}' +
    '#werkosAcct .wa-offer{border:1px solid #eef1f5;border-radius:9px;padding:7px 9px;margin-top:6px;font-size:12px}' +
    '#werkosAcct .wa-st{display:inline-block;padding:1px 8px;border-radius:9px;font-size:10px;font-weight:700}' +
    '#werkosAcct .wa-st.open{background:#fff5df;color:#8a6d1a}' +
    '#werkosAcct .wa-st.accepted{background:#dff5e7;color:#1e8449}' +
    '#werkosAcct .wa-st.declined{background:#fdecea;color:#c0392b}' +
    '#werkosAcct .wa-st.revoked{background:#eef1f5;color:#789}' +
    /* Platz für das Konto-Badge: unterste Sidebar-Einträge nicht überdecken */
    'body .sidenav{padding-bottom:54px}' +
    'body #sidenavFooter{margin-bottom:46px}';

  function injectCss() {
    var st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function gateHtml(inviteToken, opts) {
    var buy = !!(opts && opts.buy);
    var logo = '<div class="wg-logo"><svg viewBox="0 0 100 100" width="28" height="28" aria-hidden="true">' +
      '<defs><linearGradient id="wfg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#3fcf7f"/></linearGradient></defs>' +
      '<path d="M 12 38 C 17 72, 29 74, 36 52 C 41 40, 47 40, 52 52 C 59 74, 71 72, 78 46 L 90 24" fill="none" stroke="url(#wfg)" stroke-width="12" stroke-linecap="round"/></svg></div>';
    if (inviteToken) {
      return '<div class="wg-card">' + logo +
        '<h1>Willkommen im Team!</h1><div class="wg-sub">Du wurdest zu einem Betrieb bei werkflow eingeladen. Kein Passwort nötig — dein Zugang läuft über diesen Link.</div>' +
        '<label>Dein Name</label><input id="wgName" placeholder="Vor- und Nachname" autocomplete="name">' +
        '<button class="wg-btn" id="wgJoin">Betrieb beitreten</button>' +
        '<div class="wg-err" id="wgErr"></div></div>';
    }
    var sub = buy
      ? 'Direkt buchen — Konto anlegen, Module wählen und sofort per Karte oder SEPA bezahlen. Keine Demo nötig.'
      : 'Dein ganzer Betrieb in einer App — Module frei wählen, Preis nach Mitarbeiterzahl.';
    var banner = buy ? '<div class="wg-buy">🛒 Direktkauf — nach dem Anlegen öffnet sich sofort die Modul- &amp; Zahlungsauswahl.</div>' : '';
    return '<div class="wg-card">' + logo +
      '<h1>werk<span style=\'color:#1e8449\'>flow</span></h1><div class="wg-sub">' + sub + '</div>' + banner +
      '<div class="wg-tabs"><button class="wg-tab' + (buy ? '' : ' on') + '" data-t="login">Anmelden</button><button class="wg-tab' + (buy ? ' on' : '') + '" data-t="reg">Betrieb registrieren</button></div>' +
      '<div id="wgLogin"' + (buy ? ' style="display:none"' : '') + '>' +
      '<label>E-Mail</label><input id="wgEmail" type="email" autocomplete="username" placeholder="chef@betrieb.de">' +
      '<label>Passwort</label><input id="wgPass" type="password" autocomplete="current-password">' +
      '<button class="wg-btn" id="wgDoLogin">Anmelden</button>' +
      '</div>' +
      '<div id="wgReg"' + (buy ? '' : ' style="display:none"') + '>' +
      '<label>Firmenname</label><input id="wgCompany" placeholder="z. B. Malerbetrieb Muster GmbH">' +
      '<label>Dein Name</label><input id="wgRName" autocomplete="name" placeholder="Vor- und Nachname">' +
      '<label>E-Mail</label><input id="wgREmail" type="email" autocomplete="username" placeholder="chef@betrieb.de">' +
      '<label>Passwort (mind. 10 Zeichen)</label><input id="wgRPass" type="password" autocomplete="new-password">' +
      '<button class="wg-btn" id="wgDoReg">' + (buy ? 'Konto anlegen &amp; buchen' : '14 Tage kostenlos testen') + '</button>' +
      '<div class="wg-trial">✓ Alle Module 14 Tage testen · ✓ ohne Zahlungsdaten · danach ab 14 €/Monat</div>' +
      '</div>' +
      '<div class="wg-err" id="wgErr"></div>' +
      '<div class="wg-foot">🇩🇪 Daten ausschließlich in Deutschland · DSGVO- &amp; GoBD-konform · Export jederzeit</div></div>';
  }

  function showGate(inviteToken, opts) {
    var el = document.createElement('div');
    el.id = 'werkosGate';
    el.innerHTML = gateHtml(inviteToken, opts);
    document.body.appendChild(el);
    var errBox = el.querySelector('#wgErr');
    function fail(r) {
      var map = {
        'invalid-credentials': 'E-Mail oder Passwort falsch.',
        'email-exists': 'Diese E-Mail ist bereits registriert — bitte anmelden.',
        'password-too-short': 'Passwort: mindestens 10 Zeichen.',
        'invalid-email': 'Bitte gültige E-Mail angeben.',
        'invalid-company': 'Bitte Firmennamen angeben.',
        'invalid-name': 'Bitte Namen angeben.',
        'invalid-invite': 'Einladung ungültig oder abgelaufen — bitte neuen Link anfordern.',
        'rate-limited': 'Zu viele Versuche — bitte kurz warten.'
      };
      errBox.textContent = map[r.data && r.data.error] || ('Fehler: ' + ((r.data && r.data.error) || r.status));
    }
    function done(r) {
      if (r.status >= 200 && r.status < 300) {
        setSession(r.data);
        try { history.replaceState(null, '', location.pathname); } catch (e) {}
        location.reload();
      } else fail(r);
    }
    if (inviteToken) {
      el.querySelector('#wgJoin').onclick = function () {
        req('POST', '/auth/magic', { token: inviteToken, name: el.querySelector('#wgName').value }).then(done);
      };
      el.querySelector('#wgName').addEventListener('keydown', function (e) { if (e.key === 'Enter') el.querySelector('#wgJoin').click(); });
    } else {
      el.querySelectorAll('.wg-tab').forEach(function (b) {
        b.onclick = function () {
          el.querySelectorAll('.wg-tab').forEach(function (x) { x.classList.remove('on'); });
          b.classList.add('on');
          el.querySelector('#wgLogin').style.display = b.dataset.t === 'login' ? '' : 'none';
          el.querySelector('#wgReg').style.display = b.dataset.t === 'reg' ? '' : 'none';
          errBox.textContent = '';
        };
      });
      el.querySelector('#wgDoLogin').onclick = function () {
        req('POST', '/auth/login', { email: el.querySelector('#wgEmail').value, password: el.querySelector('#wgPass').value }).then(done);
      };
      el.querySelector('#wgPass').addEventListener('keydown', function (e) { if (e.key === 'Enter') el.querySelector('#wgDoLogin').click(); });
      el.querySelector('#wgDoReg').onclick = function () {
        req('POST', '/auth/register', {
          company: el.querySelector('#wgCompany').value,
          name: el.querySelector('#wgRName').value,
          email: el.querySelector('#wgREmail').value,
          password: el.querySelector('#wgRPass').value
        }).then(done);
      };
    }
  }

  // --------------------------------------------------------------------------
  // Konto-Widget
  // --------------------------------------------------------------------------
  function planCardsHtml(plans, current) {
    var order = ['START', 'BETRIEB', 'BETRIEB_PLUS'];
    var names = { zeiten: 'Zeiten & Team', auftraege: 'Aufträge & Baustelle', geld: 'Angebote & Rechnungen', planung: 'Einsatzplanung', einkauf: 'Einkauf & Lager' };
    return order.map(function (k) {
      var p = plans[k];
      if (!p) return '';
      return '<div class="wa-plan' + (current === k ? ' current' : '') + '" data-plan="' + k + '"><b>' + esc(p.label) + '</b> — ' + p.priceEur + ' €/Monat pauschal' +
        (current === k ? ' <span style="color:#1e8449;font-weight:700;">✓ aktiv</span>' : '') +
        '<div style="font-size:11px;color:#667;margin-top:2px;">' + p.modules.map(function (m) { return names[m] || m; }).join(' · ') + '</div>' +
        '<div style="font-size:10px;color:#98a5b3;">bis ' + p.maxEmployees + ' Mitarbeiter · ' + p.storageGb + ' GB</div></div>';
    }).join('');
  }

  function showAccountWidget() {
    var s = getSession();
    if (!s) return;
    var root = document.createElement('div');
    root.id = 'werkosAcct';
    root.innerHTML = '<button class="wa-badge"><span class="dot">✓</span>' + esc(s.tenant.name) + '</button><div class="wa-panel"></div>';
    document.body.appendChild(root);
    var panel = root.querySelector('.wa-panel');
    root.querySelector('.wa-badge').onclick = function () {
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) renderPanel();
    };

    function renderPanel() {
      Promise.all([
        authed('GET', '/account'),
        syncOfferResponses({ silent: false }),
      ]).then(function (rs) {
        var r = rs[0], links = rs[1] || [];
        if (r.status === 401) { return refreshSession().then(function (ok) { if (ok) renderPanel(); }); }
        if (r.status !== 200) { panel.innerHTML = '<div class="wa-row">Konto nicht erreichbar (' + r.status + ')</div>'; return; }
        var a = r.data;
        var t = a.tenant;
        // Session-Kopie aktualisieren (Module können sich serverseitig geändert haben)
        var sess = getSession(); if (sess) { sess.tenant = Object.assign({}, sess.tenant, t); setSession(sess); applyModules(); }
        var isOwner = a.user.role === 'owner';
        var isOffice = a.user.role === 'office';
        var trialDays = t.trialEndsAt ? Math.max(0, Math.ceil((new Date(t.trialEndsAt) - Date.now()) / 864e5)) : 0;
        var modNames = (t.modules || []).map(function (m) { return (t.moduleCatalog[m] || {}).label || m; });
        var roleNames = { owner: 'Inhaber', office: 'Büro', employee: 'Mitarbeiter', external: 'Steuerberater (lesend)' };
        var sub = t.subscription;
        var html = '<h3>' + esc(t.name) + '</h3>' +
          '<div class="wa-row">👤 ' + esc(a.user.name) + ' · ' + esc(roleNames[a.user.role] || a.user.role) + '</div>' +
          '<div class="wa-row">📦 <b>' + esc(t.planLabel) + '</b>' +
          (t.plan === 'TRIAL' ? ' — noch ' + trialDays + ' Tage kostenlos' :
            (sub ? ' — Abo aktiv: ' + Number(sub.priceEur).toLocaleString('de-DE') + ' €/Monat (' + (sub.payMethod === 'sepa' ? 'SEPA' : 'auf Rechnung') + ')' : '')) + '</div>' +
          '<div class="wa-row">🧩 ' + esc(modNames.join(' · ') || 'keine Module') + '</div>' +
          '<div class="wa-row">🗄 ' + (a.storageBytes / 1048576).toFixed(1) + ' MB von ' + t.storageGb + ' GB belegt</div>';
        // Laufende Zusatzmodul-Tests mit Countdown + Kauf-Aufforderung
        var trials = (t.grants || []).filter(function (g) { return g.status === 'trial' && !g.inPlan; });
        trials.forEach(function (g) {
          var soon = g.daysLeft != null && g.daysLeft <= 3;
          html += '<div class="wa-warn" style="' + (soon ? '' : 'background:#eef6ff;color:#1a3a5c;') + '">' +
            '🧪 <b>' + esc(g.label) + '</b> — Test läuft noch ' + g.daysLeft + ' Tag' + (g.daysLeft === 1 ? '' : 'e') + '.' +
            (isOwner ? ' <button class="wa-act primary" data-buy="' + esc(g.module) + '" style="margin-top:6px;">Für ' + g.addonPriceEur + ' €/Monat behalten</button>' : '') +
            '</div>';
        });
        if (t.trialExpired) html += '<div class="wa-warn">⚠ Testphase abgelaufen — bitte Tarif wählen, um weiterzuarbeiten. Deine Daten bleiben erhalten und exportierbar.</div>';
        if (t.status === 'deletion_pending') html += '<div class="wa-warn">⚠ Konto-Löschung beantragt. <button class="wa-act" id="waCancelDel">Löschung widerrufen</button></div>';

        if (isOwner || isOffice) {
          html += '<div class="wa-sec"><b>Team</b>' +
            '<button class="wa-act primary" id="waInvite">📱 Mitarbeiter einladen (Link/QR)</button>' +
            '<button class="wa-act" id="waInviteExt">👓 Steuerberater-Zugang (nur lesen)</button>' +
            '<div id="waInviteOut"></div></div>';

          // Angebots-Links mit Kundenstatus
          var shown = links.slice(0, 8);
          html += '<div class="wa-sec"><b>Angebots-Links</b>';
          if (!shown.length) html += '<div class="wa-row" style="color:#98a5b3;">Noch keine geteilten Angebote. Im Angebot auf „📲 Kunden-Link" klicken.</div>';
          shown.forEach(function (l) {
            var st = { open: 'Wartet', accepted: 'Angenommen', declined: 'Abgelehnt', revoked: 'Widerrufen' }[l.status] || l.status;
            html += '<div class="wa-offer"><b>' + esc(l.number || l.id) + '</b> <span class="wa-st ' + esc(l.status) + '">' + st + '</span>' +
              (l.responder_name ? '<div style="color:#567;">von ' + esc(l.responder_name) + (l.responded_at ? ' · ' + new Date(l.responded_at).toLocaleDateString('de-DE') : '') + '</div>' : '') +
              (l.responder_comment ? '<div style="color:#789;">„' + esc(l.responder_comment) + '"</div>' : '') +
              '<div style="margin-top:3px;display:flex;gap:6px;flex-wrap:wrap;">' +
              (l.has_signature ? '<a href="#" data-sig="' + esc(l.id) + '" style="font-size:11px;">✍ Unterschrift ansehen</a>' : '') +
              (l.status === 'open' ? '<a href="#" data-revoke="' + esc(l.id) + '" style="font-size:11px;color:#c0392b;">Link widerrufen</a>' : '') +
              '</div></div>';
          });
          html += '</div>';
        }
        if (isOwner) {
          html += '<div class="wa-sec"><b>Tarif (schaltet Module automatisch frei)</b>' + planCardsHtml(a.plans, t.plan) + '</div>';
        }
        html += '<div class="wa-sec">' +
          (isOwner ? '<button class="wa-act" id="waExport">⬇ DSGVO/GoBD-Datenexport (ZIP)</button>' : '') +
          '<button class="wa-act" id="waVerify">🔍 GoBD-Prüfkette verifizieren</button>' +
          (isOwner && sub ? '<button class="wa-act" id="waCancelSub">Abo kündigen …</button>' : '') +
          (isOwner ? '<button class="wa-act danger" id="waDelete">Konto &amp; alle Daten löschen …</button>' : '') +
          '<button class="wa-act" id="waLogout">🚪 Abmelden</button></div>';
        panel.innerHTML = html;

        function makeInvite(role, label) {
          authed('POST', '/auth/invite', { role: role, maxUses: role === 'employee' ? 10 : 1, days: 14 }).then(function (ir) {
            var out = panel.querySelector('#waInviteOut');
            if (ir.status !== 201) { out.innerHTML = '<div class="wa-warn">Fehler: ' + esc((ir.data && ir.data.error) || ir.status) + '</div>'; return; }
            out.innerHTML = '<div class="wa-link"><b>' + esc(label) + '</b><br>' + esc(ir.data.url) + '</div><div id="waQr" style="margin-top:6px"></div>' +
              '<div style="display:flex;gap:6px;"><button class="wa-act" id="waCopy" style="flex:1;">📋 Kopieren</button>' +
              '<a style="flex:1;" href="https://wa.me/?text=' + encodeURIComponent('Dein Zugang zu unserem Betriebs-System: ' + ir.data.url) + '" target="_blank" rel="noopener"><button class="wa-act" style="width:100%;background:#dff5e7;color:#1e8449;">🟢 WhatsApp</button></a></div>';
            out.querySelector('#waCopy').onclick = function () { navigator.clipboard && navigator.clipboard.writeText(ir.data.url); this.textContent = '✓ Kopiert'; };
            try { if (window.QRCode) new QRCode(out.querySelector('#waQr'), { text: ir.data.url, width: 140, height: 140 }); } catch (e) {}
          });
        }
        var bi = panel.querySelector('#waInvite'); if (bi) bi.onclick = function () { makeInvite('employee', 'Mitarbeiter-Link (14 Tage gültig, bis 10 Personen)'); };
        var be = panel.querySelector('#waInviteExt'); if (be) be.onclick = function () { makeInvite('external', 'Steuerberater-Link (nur Lesezugriff)'); };

        panel.querySelectorAll('[data-sig]').forEach(function (aEl) {
          aEl.onclick = function (e) {
            e.preventDefault();
            fetch(API + '/t/offers/links/' + aEl.dataset.sig + '/signature', { headers: { Authorization: 'Bearer ' + getSession().accessToken } })
              .then(function (r) { return r.blob(); })
              .then(function (b) { window.open(URL.createObjectURL(b), '_blank'); });
          };
        });
        panel.querySelectorAll('[data-revoke]').forEach(function (aEl) {
          aEl.onclick = function (e) {
            e.preventDefault();
            if (!confirm('Diesen Angebots-Link widerrufen? Der Kunde kann ihn danach nicht mehr öffnen.')) return;
            authed('POST', '/t/offers/links/' + aEl.dataset.revoke + '/revoke').then(renderPanel);
          };
        });

        // KAUF: Tarifkarte → Checkout mit Rechnungsdaten + AGB/AVV-Zustimmung
        function showCheckout(planKey) {
          var p = a.plans[planKey];
          var billing = (a.user.email || '');
          panel.innerHTML = '<h3>🛒 ' + esc(p.label) + ' abschließen</h3>' +
            '<div class="wa-row">' + p.priceEur + ' €/Monat pauschal zzgl. USt · monatlich kündbar · Module sofort frei</div>' +
            '<div class="wa-sec"><b>Rechnungsdaten</b>' +
            '<label style="display:block;font-size:11px;font-weight:700;color:#456;margin:8px 0 3px;">Firma *</label>' +
            '<input id="ckCompany" style="width:100%;padding:9px;border:1px solid #cdd6df;border-radius:8px;font-size:14px;" value="' + esc(t.name) + '">' +
            '<label style="display:block;font-size:11px;font-weight:700;color:#456;margin:8px 0 3px;">Straße &amp; Nr. *</label>' +
            '<input id="ckAddress" style="width:100%;padding:9px;border:1px solid #cdd6df;border-radius:8px;font-size:14px;">' +
            '<div style="display:flex;gap:8px;">' +
            '<div style="flex:1;"><label style="display:block;font-size:11px;font-weight:700;color:#456;margin:8px 0 3px;">PLZ *</label>' +
            '<input id="ckZip" style="width:100%;padding:9px;border:1px solid #cdd6df;border-radius:8px;font-size:14px;"></div>' +
            '<div style="flex:2;"><label style="display:block;font-size:11px;font-weight:700;color:#456;margin:8px 0 3px;">Ort *</label>' +
            '<input id="ckCity" style="width:100%;padding:9px;border:1px solid #cdd6df;border-radius:8px;font-size:14px;"></div></div>' +
            '<label style="display:block;font-size:11px;font-weight:700;color:#456;margin:8px 0 3px;">Rechnungs-E-Mail *</label>' +
            '<input id="ckEmail" style="width:100%;padding:9px;border:1px solid #cdd6df;border-radius:8px;font-size:14px;" value="' + esc(billing) + '">' +
            '<label style="display:block;font-size:11px;font-weight:700;color:#456;margin:8px 0 3px;">USt-IdNr. (optional)</label>' +
            '<input id="ckUst" style="width:100%;padding:9px;border:1px solid #cdd6df;border-radius:8px;font-size:14px;" placeholder="DE…">' +
            '<label style="display:block;font-size:11px;font-weight:700;color:#456;margin:8px 0 3px;">Zahlweise</label>' +
            '<select id="ckPay" style="width:100%;padding:9px;border:1px solid #cdd6df;border-radius:8px;font-size:14px;">' +
            '<option value="invoice">Kauf auf Rechnung (14 Tage Ziel)</option>' +
            '<option value="sepa">SEPA-Lastschrift (Mandat folgt per E-Mail)</option></select>' +
            '<div style="display:flex;gap:8px;align-items:flex-start;margin-top:12px;font-size:11.5px;color:#5b6b7c;line-height:1.5;">' +
            '<input type="checkbox" id="ckTerms" style="width:16px;height:16px;margin-top:2px;flex:none;">' +
            '<span>Ich schließe das Abo verbindlich ab (monatlich kündbar) und stimme dem Auftragsverarbeitungsvertrag zu. *</span></div>' +
            '<button class="wa-act primary" id="ckGo" style="margin-top:12px;text-align:center;">✅ Kostenpflichtig abschließen — ' + p.priceEur + ' €/Monat</button>' +
            '<div id="ckErr" style="color:#c0392b;font-size:12px;font-weight:600;min-height:14px;margin-top:6px;"></div>' +
            '<button class="wa-act" id="ckBack">← Zurück</button></div>';
          panel.querySelector('#ckBack').onclick = renderPanel;
          panel.querySelector('#ckGo').onclick = function () {
            var errEl = panel.querySelector('#ckErr');
            if (!panel.querySelector('#ckTerms').checked) { errEl.textContent = 'Bitte der Abo- und AVV-Zustimmung bestätigen.'; return; }
            var btn = this; btn.disabled = true; btn.textContent = '⏳ Abschluss läuft …';
            authed('POST', '/billing/checkout', {
              plan: planKey, acceptTerms: true,
              billing: {
                company: panel.querySelector('#ckCompany').value,
                address: panel.querySelector('#ckAddress').value,
                zip: panel.querySelector('#ckZip').value,
                city: panel.querySelector('#ckCity').value,
                email: panel.querySelector('#ckEmail').value,
                ustId: panel.querySelector('#ckUst').value,
                payMethod: panel.querySelector('#ckPay').value,
              },
            }).then(function (pr) {
              if (pr.data && pr.data.checkoutUrl) {
                // Stripe: zur gehosteten Zahlungsseite (Karte/SEPA) weiterleiten.
                btn.textContent = '↪ Weiter zur Zahlung …';
                window.location.href = pr.data.checkoutUrl;
                return;
              }
              if (pr.status === 201) {
                var s2 = getSession(); s2.tenant = Object.assign({}, s2.tenant, pr.data.tenant); setSession(s2);
                applyModules();
                if (typeof window.render === 'function') { try { window.render(); } catch (e) {} }
                toast('🎉 ' + (pr.data.hint || 'Abo aktiv — Module freigeschaltet.'));
                renderPanel();
              } else {
                btn.disabled = false; btn.textContent = '✅ Kostenpflichtig abschließen — ' + p.priceEur + ' €/Monat';
                var map = { 'address-required': 'Bitte Adresse vollständig angeben.', 'invalid-email': 'Bitte gültige Rechnungs-E-Mail angeben.', 'invalid-company': 'Bitte Firma angeben.', 'terms-required': 'Bitte Zustimmung bestätigen.', 'stripe-error': (pr.data && pr.data.hint) || 'Zahlungsanbieter-Fehler.' };
                errEl.textContent = map[pr.data.error] || ('Fehler: ' + (pr.data.error || pr.status));
              }
            });
          };
        }
        panel.querySelectorAll('.wa-plan').forEach(function (card) {
          card.onclick = function () {
            if (card.classList.contains('current')) return;
            showCheckout(card.dataset.plan);
          };
        });

        // Zusatzmodul aus laufendem Test heraus kaufen
        panel.querySelectorAll('[data-buy]').forEach(function (btn) {
          btn.onclick = function () {
            var key = btn.dataset.buy;
            if (!confirm('Modul „' + key + '" dauerhaft behalten? Es wird kostenpflichtig zugebucht (auf Rechnung).')) return;
            authed('POST', '/billing/buy-module', { module: key, acceptTerms: true }).then(function (r) {
              if (r.status === 201) {
                var s2 = getSession(); s2.tenant = Object.assign({}, s2.tenant, r.data.tenant); setSession(s2);
                applyModules();
                if (typeof window.render === 'function') { try { window.render(); } catch (e) {} }
                toast('✓ ' + (r.data.hint || 'Modul gekauft.'));
                renderPanel();
              } else alert('Fehler: ' + ((r.data && r.data.error) || r.status));
            });
          };
        });

        var bcs = panel.querySelector('#waCancelSub');
        if (bcs) bcs.onclick = function () {
          var pw = prompt('Abo wirklich kündigen?\nDein Betrieb fällt in den Lese-Modus zurück (Export bleibt jederzeit möglich).\n\nZum Bestätigen Passwort eingeben:');
          if (!pw) return;
          authed('POST', '/billing/cancel', { password: pw }).then(function (cr) {
            if (cr.status === 200) { toast(cr.data.hint || 'Abo gekündigt.'); refreshSession().then(renderPanel); }
            else alert('Fehler: ' + ((cr.data && cr.data.error) || cr.status));
          });
        };

        var bx = panel.querySelector('#waExport');
        if (bx) bx.onclick = function () {
          bx.textContent = '⏳ Export wird erstellt …';
          fetch(API + '/dsgvo/export', { headers: { Authorization: 'Bearer ' + getSession().accessToken } })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
            .then(function (blob) {
              var u = URL.createObjectURL(blob);
              var aEl = document.createElement('a');
              aEl.href = u; aEl.download = 'werkos-export.zip'; aEl.click();
              setTimeout(function () { URL.revokeObjectURL(u); }, 5000);
              bx.textContent = '✓ Export heruntergeladen';
            }).catch(function (e) { bx.textContent = '✗ ' + e.message; });
        };

        var bv = panel.querySelector('#waVerify');
        if (bv) bv.onclick = function () {
          authed('GET', '/gobd/verify').then(function (vr) {
            bv.textContent = vr.data && vr.data.ok ? '✓ Prüfkette intakt (' + vr.data.entries + ' Einträge)' : '✗ Kette beschädigt!';
          });
        };

        var bd = panel.querySelector('#waDelete');
        if (bd) bd.onclick = function () {
          var pw = prompt('ACHTUNG: Alle Betriebsdaten werden nach 30 Tagen Karenzfrist ENDGÜLTIG gelöscht.\n\nBitte vorher den Datenexport ziehen (Aufbewahrungspflichten § 147 AO!).\n\nZum Bestätigen Passwort eingeben:');
          if (!pw) return;
          authed('POST', '/dsgvo/delete-tenant', { password: pw }).then(function (dr) {
            alert(dr.status === 200 ? 'Löschung vorgemerkt: endgültig am ' + dr.data.deleteAfter : 'Fehler: ' + ((dr.data && dr.data.error) || dr.status));
            renderPanel();
          });
        };
        var bc = panel.querySelector('#waCancelDel');
        if (bc) bc.onclick = function () { authed('POST', '/dsgvo/cancel-deletion', {}).then(renderPanel); };
        panel.querySelector('#waLogout').onclick = logout;
      });
    }
  }

  // --------------------------------------------------------------------------
  // Boot
  // --------------------------------------------------------------------------
  // Aktuelle Mitarbeiterzahl (für die Preis-Staffel) aus dem App-State ableiten.
  function currentEmployees() {
    try {
      var emps = (window.state && window.state.employees) || [];
      var active = emps.filter(function (e) { return e && !e.archived && !e.deleted; });
      return Math.max(1, active.length || emps.length || 1);
    } catch (e) { return 1; }
  }
  // Preis-Auskunft: was kostet es, ein (verkaufbares) Modul dazuzubuchen?
  function moduleQuote(werkKey) {
    return authed('POST', '/billing/module-quote', { module: werkKey, employees: currentEmployees() })
      .then(function (r) { return r.status === 200 ? r.data : null; });
  }
  // Self-Service-Kauf eines Moduls. Bei bestehendem Stripe-Abo sofort
  // freigeschaltet (Proration); bei Erstzahlung Weiterleitung zur Stripe-
  // Checkout-Seite (Freischaltung nach bestätigter Zahlung per Webhook).
  function buyModule(werkKey) {
    return authed('POST', '/billing/buy-module', { module: werkKey, acceptTerms: true, employees: currentEmployees() })
      .then(function (r) {
        if (r.data && r.data.checkoutUrl) {
          window.location.href = r.data.checkoutUrl;
          return { ok: true, redirect: true };
        }
        if (r.status === 201) {
          var s2 = getSession(); if (s2) { s2.tenant = Object.assign({}, s2.tenant, r.data.tenant); setSession(s2); }
          applyModules();
          return { ok: true, hint: r.data.hint, newMonthlyEur: r.data.newMonthlyEur, addEur: r.data.addEur };
        }
        return { ok: false, error: (r.data && (r.data.hint || r.data.error)) || r.status };
      });
  }
  function pricing() { var s = getSession(); return (s && s.tenant && s.tenant.pricing) || (window.state && window.state.pricing) || null; }

  window.WERKOS = {
    applyServerConfig: applyServerConfig,
    applyModules: applyModules,
    shareAngebot: shareAngebot,
    syncOfferResponses: syncOfferResponses,
    session: getSession,
    refresh: refreshSession,
    moduleQuote: moduleQuote,
    buyModule: buyModule,
    pricing: pricing,
    currentEmployees: currentEmployees,
    logout: logout
  };

  // Statischer Demo-Modus: kein Gate, kein Server — App direkt entsperren,
  // Demo-Hinweis zeigen, sinnlose Buttons (Abmelden/interner Login) ausblenden.
  function bootStatic() {
    var ribbon = document.createElement('div');
    ribbon.innerHTML = '🧪 <b>Demo-Modus</b> — alle Daten bleiben nur in diesem Browser. ' +
      'Für echten Team-Betrieb mit Login &amp; Kunden-Links: WERKOS auf eigenem Server starten.';
    ribbon.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147482000;background:#16324e;color:#dbe7f3;' +
      'padding:8px 14px;font-size:12.5px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
    document.body.appendChild(ribbon);
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      if (tries > 100) return clearInterval(t);
      if (!window.__appLoadedAt || typeof window.setMode !== 'function') return;
      var lb = document.getElementById('unifiedLoginBtn'); if (lb) lb.style.display = 'none';
      var lock = document.getElementById('lockBtn'); if (lock) lock.style.display = 'none';
      if (window.mode === 'locked') { try { window.setMode('admin'); } catch (e) { return; } }
      clearInterval(t);
    }, 300);
  }

  function boot() {
    if (STATIC) { bootStatic(); return; }
    injectCss();
    var inviteMatch = location.hash.match(/[#&]invite=([A-Za-z0-9_-]+)/);
    var s = getSession();
    // Direktkauf-Absicht von der Website (/app?action=buy) über den Reload retten.
    var buyIntent = /[?&]action=buy/.test(location.search);
    if (buyIntent) { try { sessionStorage.setItem('werkos_buy_intent', '1'); } catch (e) {} }
    buyIntent = buyIntent || (function () { try { return sessionStorage.getItem('werkos_buy_intent') === '1'; } catch (e) { return false; } })();
    if (inviteMatch && !s) { showGate(inviteMatch[1]); return; }
    if (!s) { showGate(null, { buy: buyIntent }); return; }
    // Rückkehr von der Stripe-Checkout-Seite auswerten.
    var ck = (location.search.match(/[?&]checkout=([a-z]+)/) || [])[1];
    if (ck) {
      // URL-Parameter entfernen (kein erneutes Triggern beim Reload).
      try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) {}
      if (ck === 'success') {
        // Webhook schaltet frei — Session ein paar Mal nachladen, bis es greift.
        var tries = 0;
        var poll = setInterval(function () {
          tries++;
          refreshSession().then(function () { applyModules(); if (typeof window.render === 'function') { try { window.render(); } catch (e) {} } });
          if (tries >= 5) clearInterval(poll);
        }, 2000);
        toast('✅ Zahlung erhalten — deine Freischaltung wird aktiviert …');
      } else if (ck === 'cancel') {
        toast('Zahlung abgebrochen — es wurde nichts berechnet.');
      }
    }
    // Aktive Session: Token auffrischen, Konfiguration erzwingen, Widget zeigen
    refreshSession();
    applyServerConfig();
    setInterval(refreshSession, 4 * 3600 * 1000);
    showAccountWidget();
    // Direktkauf: nach Registrierung/Login das Konto-Panel automatisch öffnen.
    if (buyIntent) {
      try { sessionStorage.removeItem('werkos_buy_intent'); } catch (e) {}
      setTimeout(function () {
        var badge = document.querySelector('#werkosAcct .wa-badge');
        var panel = document.querySelector('#werkosAcct .wa-panel');
        if (badge && panel && !panel.classList.contains('open')) badge.click();
        toast('Konto bereit — wähle deine Module und schließe direkt ab.');
      }, 700);
    }
    // Auto-Unlock: App-Modus aus WERKOS-Rolle ableiten (kein Doppel-Login)
    setInterval(autoUnlock, 400);
    // Kundenantworten auf Angebots-Links regelmäßig abholen
    setTimeout(function () { syncOfferResponses(); }, 6000);
    setInterval(function () { syncOfferResponses(); }, 5 * 60 * 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
