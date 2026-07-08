/* WERKOS SaaS-Bootstrap
 * Macht aus der Einzelplatz-PWA einen Mandanten-Client:
 *  - Login / Betriebs-Registrierung / Magic-Link-Beitritt (Overlay vor App-Start)
 *  - erzwingt die Server-Konfiguration der App (state.serverConfig) aus der Session
 *  - Konto-Widget: Einladungen (Link + QR), Tarifwahl, DSGVO-Export, Abmelden
 *  - Token-Refresh (beim Start + alle 4 h)
 * Läuft komplett ohne Framework; wird VOR dem App-Code geladen.
 */
(function () {
  'use strict';
  var API = location.origin + '/api';
  var SKEY = 'werkos_session_v1';

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

  function req(method, path, body, token) {
    var h = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = 'Bearer ' + token;
    return fetch(API + path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, data: j }; }); });
  }

  // --------------------------------------------------------------------------
  // Server-Konfiguration in die App drücken (wird aus app.html nach loadState()
  // aufgerufen — überschreibt jede manuelle Einstellung, solange Session aktiv)
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
    var s = getSession();
    var done = function () { clearSession(); location.reload(); };
    if (s) req('POST', '/auth/logout', {}, s.accessToken).then(done, done); else done();
  }

  // --------------------------------------------------------------------------
  // Login-/Registrierungs-Overlay
  // --------------------------------------------------------------------------
  var CSS = '\n' +
    '#werkosGate{position:fixed;inset:0;z-index:2147483000;background:linear-gradient(160deg,#12293f,#1a3a5c 55%,#24507c);display:flex;align-items:center;justify-content:center;padding:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;overflow:auto}' +
    '#werkosGate .wg-card{background:#fff;border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,.4);max-width:420px;width:100%;padding:28px}' +
    '#werkosGate h1{font-size:24px;color:#1a3a5c;margin:0 0 2px}' +
    '#werkosGate .wg-sub{color:#667;font-size:13px;margin-bottom:18px}' +
    '#werkosGate .wg-tabs{display:flex;gap:6px;margin-bottom:16px}' +
    '#werkosGate .wg-tab{flex:1;padding:9px;border:none;border-radius:8px;background:#eef1f5;color:#345;font-weight:600;font-size:13px;cursor:pointer}' +
    '#werkosGate .wg-tab.on{background:#1a3a5c;color:#fff}' +
    '#werkosGate label{display:block;font-size:12px;font-weight:600;color:#456;margin:10px 0 4px}' +
    '#werkosGate input{width:100%;padding:10px;border:1px solid #cdd4dc;border-radius:8px;font-size:14px;box-sizing:border-box}' +
    '#werkosGate .wg-btn{width:100%;margin-top:16px;padding:12px;border:none;border-radius:8px;background:#1a3a5c;color:#fff;font-size:15px;font-weight:600;cursor:pointer}' +
    '#werkosGate .wg-btn:hover{background:#2a5080}' +
    '#werkosGate .wg-err{color:#c0392b;font-size:13px;margin-top:10px;min-height:16px}' +
    '#werkosGate .wg-foot{margin-top:14px;font-size:11px;color:#889;text-align:center;line-height:1.5}' +
    '#werkosGate .wg-trial{background:#eafaf1;color:#1e8449;border-radius:8px;padding:8px 10px;font-size:12px;margin-top:12px;text-align:center}' +
    '#werkosAcct{position:fixed;left:10px;bottom:10px;z-index:2147482000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}' +
    '#werkosAcct .wa-badge{background:#1a3a5c;color:#fff;border:none;border-radius:20px;padding:7px 14px;font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}' +
    '#werkosAcct .wa-panel{position:absolute;left:0;bottom:44px;width:320px;max-height:70vh;overflow:auto;background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.3);padding:16px;display:none}' +
    '#werkosAcct .wa-panel.open{display:block}' +
    '#werkosAcct h3{margin:0 0 4px;font-size:15px;color:#1a3a5c}' +
    '#werkosAcct .wa-row{font-size:12px;color:#556;margin:2px 0}' +
    '#werkosAcct .wa-sec{border-top:1px solid #eef1f5;margin-top:12px;padding-top:12px}' +
    '#werkosAcct button.wa-act{display:block;width:100%;margin-top:6px;padding:9px;border:none;border-radius:8px;background:#eef1f5;color:#234;font-size:13px;font-weight:600;cursor:pointer;text-align:left}' +
    '#werkosAcct button.wa-act:hover{background:#dde4ec}' +
    '#werkosAcct button.wa-act.primary{background:#1a3a5c;color:#fff}' +
    '#werkosAcct button.wa-act.danger{background:#fdecea;color:#c0392b}' +
    '#werkosAcct .wa-plan{border:1px solid #cdd4dc;border-radius:8px;padding:8px;margin-top:6px;cursor:pointer}' +
    '#werkosAcct .wa-plan:hover{border-color:#1a3a5c}' +
    '#werkosAcct .wa-plan b{color:#1a3a5c}' +
    '#werkosAcct .wa-link{word-break:break-all;background:#f4f6f8;border-radius:6px;padding:6px;font-size:11px;margin-top:6px}' +
    '#werkosAcct .wa-warn{background:#fff3cd;color:#856404;border-radius:8px;padding:8px;font-size:12px;margin-top:8px}';

  function injectCss() {
    var st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function gateHtml(inviteToken) {
    if (inviteToken) {
      return '<div class="wg-card">' +
        '<h1>WERKOS</h1><div class="wg-sub">Du wurdest zu einem Betrieb eingeladen.</div>' +
        '<label>Dein Name</label><input id="wgName" placeholder="Vor- und Nachname" autocomplete="name">' +
        '<button class="wg-btn" id="wgJoin">Betrieb beitreten</button>' +
        '<div class="wg-err" id="wgErr"></div>' +
        '<div class="wg-foot">Kein Passwort nötig — dein Zugang läuft über diesen Link.</div></div>';
    }
    return '<div class="wg-card">' +
      '<h1>WERKOS</h1><div class="wg-sub">Dein ganzer Betrieb in einer App — ein Preis pro Betrieb, egal wie viele Mitarbeiter.</div>' +
      '<div class="wg-tabs"><button class="wg-tab on" data-t="login">Anmelden</button><button class="wg-tab" data-t="reg">Betrieb registrieren</button></div>' +
      '<div id="wgLogin">' +
      '<label>E-Mail</label><input id="wgEmail" type="email" autocomplete="username">' +
      '<label>Passwort</label><input id="wgPass" type="password" autocomplete="current-password">' +
      '<button class="wg-btn" id="wgDoLogin">Anmelden</button>' +
      '</div>' +
      '<div id="wgReg" style="display:none">' +
      '<label>Firmenname</label><input id="wgCompany" placeholder="z. B. Malerbetrieb Muster GmbH">' +
      '<label>Dein Name</label><input id="wgRName" autocomplete="name">' +
      '<label>E-Mail</label><input id="wgREmail" type="email" autocomplete="username">' +
      '<label>Passwort (mind. 10 Zeichen)</label><input id="wgRPass" type="password" autocomplete="new-password">' +
      '<button class="wg-btn" id="wgDoReg">Kostenlos testen</button>' +
      '<div class="wg-trial">14 Tage kostenlos, alle Module, ohne Zahlungsdaten. Danach ab 15 €/Monat.</div>' +
      '</div>' +
      '<div class="wg-err" id="wgErr"></div>' +
      '<div class="wg-foot">Daten werden ausschließlich in Deutschland gespeichert · DSGVO- &amp; GoBD-konform · jederzeit exportierbar</div></div>';
  }

  function showGate(inviteToken) {
    var el = document.createElement('div');
    el.id = 'werkosGate';
    el.innerHTML = gateHtml(inviteToken);
    document.body.appendChild(el);
    var errBox = el.querySelector('#wgErr');
    function fail(r) {
      var map = {
        'invalid-credentials': 'E-Mail oder Passwort falsch.',
        'email-exists': 'Diese E-Mail ist bereits registriert.',
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
  // Konto-Widget (nach Login)
  // --------------------------------------------------------------------------
  function planCardsHtml(plans, current) {
    var order = ['START', 'BETRIEB', 'BETRIEB_PLUS'];
    return order.map(function (k) {
      var p = plans[k];
      if (!p) return '';
      return '<div class="wa-plan" data-plan="' + k + '"><b>' + esc(p.label) + '</b> — ' + p.priceEur + ' €/Monat' +
        (current === k ? ' <span style="color:#1e8449">✓ aktiv</span>' : '') +
        '<div style="font-size:11px;color:#667">' + esc(p.modules.join(', ')) + ' · bis ' + p.maxEmployees + ' MA · ' + p.storageGb + ' GB</div></div>';
    }).join('');
  }

  function showAccountWidget() {
    var s = getSession();
    if (!s) return;
    var root = document.createElement('div');
    root.id = 'werkosAcct';
    root.innerHTML = '<button class="wa-badge">☁ ' + esc(s.tenant.name) + '</button><div class="wa-panel"></div>';
    document.body.appendChild(root);
    var panel = root.querySelector('.wa-panel');
    root.querySelector('.wa-badge').onclick = function () {
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) renderPanel();
    };

    function renderPanel() {
      req('GET', '/account', null, getSession().accessToken).then(function (r) {
        if (r.status === 401) { return refreshSession().then(function (ok) { if (ok) renderPanel(); }); }
        if (r.status !== 200) { panel.innerHTML = '<div class="wa-row">Konto nicht erreichbar (' + r.status + ')</div>'; return; }
        var a = r.data;
        var t = a.tenant;
        var isOwner = a.user.role === 'owner';
        var isOffice = a.user.role === 'office';
        var trialDays = t.trialEndsAt ? Math.max(0, Math.ceil((new Date(t.trialEndsAt) - Date.now()) / 864e5)) : 0;
        var html = '<h3>' + esc(t.name) + '</h3>' +
          '<div class="wa-row">👤 ' + esc(a.user.name) + ' · Rolle: ' + esc(a.user.role) + '</div>' +
          '<div class="wa-row">📦 Tarif: <b>' + esc(t.planLabel) + '</b>' + (t.plan === 'TRIAL' ? ' — noch ' + trialDays + ' Tage' : '') + '</div>' +
          '<div class="wa-row">🗄 Speicher: ' + (a.storageBytes / 1048576).toFixed(1) + ' MB von ' + t.storageGb + ' GB</div>' +
          '<div class="wa-row">🧩 Module: ' + esc((t.modules || []).join(', ')) + '</div>';
        if (t.trialExpired) html += '<div class="wa-warn">⚠ Testphase abgelaufen — bitte Tarif wählen, um weiterzuarbeiten. Deine Daten bleiben erhalten und exportierbar.</div>';
        if (t.status === 'deletion_pending') html += '<div class="wa-warn">⚠ Konto-Löschung beantragt. <button class="wa-act" id="waCancelDel">Löschung widerrufen</button></div>';

        if (isOwner || isOffice) {
          html += '<div class="wa-sec"><b style="font-size:12px;color:#456">Team</b>' +
            '<button class="wa-act primary" id="waInvite">📱 Mitarbeiter einladen (Link/QR)</button>' +
            '<button class="wa-act" id="waInviteExt">👓 Steuerberater-Zugang (nur lesen)</button>' +
            '<div id="waInviteOut"></div></div>';
        }
        if (isOwner) {
          html += '<div class="wa-sec"><b style="font-size:12px;color:#456">Tarif wählen</b>' + planCardsHtml(a.plans, t.plan) + '</div>';
        }
        html += '<div class="wa-sec">' +
          (isOwner ? '<button class="wa-act" id="waExport">⬇ DSGVO/GoBD-Datenexport (ZIP)</button>' : '') +
          '<button class="wa-act" id="waVerify">🔍 GoBD-Prüfkette verifizieren</button>' +
          (isOwner ? '<button class="wa-act danger" id="waDelete">Konto &amp; alle Daten löschen …</button>' : '') +
          '<button class="wa-act" id="waLogout">Abmelden</button></div>';
        panel.innerHTML = html;

        function makeInvite(role, label) {
          req('POST', '/auth/invite', { role: role, maxUses: role === 'employee' ? 10 : 1, days: 14 }, getSession().accessToken).then(function (ir) {
            var out = panel.querySelector('#waInviteOut');
            if (ir.status !== 201) { out.innerHTML = '<div class="wa-warn">Fehler: ' + esc((ir.data && ir.data.error) || ir.status) + '</div>'; return; }
            out.innerHTML = '<div class="wa-link">' + esc(label) + ':<br>' + esc(ir.data.url) + '</div><div id="waQr" style="margin-top:6px"></div>' +
              '<button class="wa-act" id="waCopy">Link kopieren</button>';
            out.querySelector('#waCopy').onclick = function () { navigator.clipboard && navigator.clipboard.writeText(ir.data.url); this.textContent = '✓ kopiert'; };
            try { if (window.QRCode) new QRCode(out.querySelector('#waQr'), { text: ir.data.url, width: 140, height: 140 }); } catch (e) {}
          });
        }
        var bi = panel.querySelector('#waInvite'); if (bi) bi.onclick = function () { makeInvite('employee', 'Mitarbeiter-Link (14 Tage, bis 10 Personen)'); };
        var be = panel.querySelector('#waInviteExt'); if (be) be.onclick = function () { makeInvite('external', 'Steuerberater-Link (nur Lesezugriff)'); };

        panel.querySelectorAll('.wa-plan').forEach(function (card) {
          card.onclick = function () {
            if (!confirm('Tarif „' + card.dataset.plan + '" aktivieren?')) return;
            req('POST', '/billing/choose-plan', { plan: card.dataset.plan }, getSession().accessToken).then(function (pr) {
              if (pr.status === 200) { var sess = getSession(); sess.tenant = pr.data.tenant; setSession(sess); renderPanel(); }
              else alert('Fehler: ' + ((pr.data && pr.data.error) || pr.status));
            });
          };
        });

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
          req('GET', '/gobd/verify', null, getSession().accessToken).then(function (vr) {
            bv.textContent = vr.data && vr.data.ok ? '✓ Prüfkette intakt (' + vr.data.entries + ' Einträge)' : '✗ Kette beschädigt!';
          });
        };

        var bd = panel.querySelector('#waDelete');
        if (bd) bd.onclick = function () {
          var pw = prompt('ACHTUNG: Alle Betriebsdaten werden nach 30 Tagen Karenzfrist ENDGÜLTIG gelöscht.\n\nBitte vorher den Datenexport ziehen (Aufbewahrungspflichten § 147 AO!).\n\nZum Bestätigen Passwort eingeben:');
          if (!pw) return;
          req('POST', '/dsgvo/delete-tenant', { password: pw }, getSession().accessToken).then(function (dr) {
            alert(dr.status === 200 ? 'Löschung vorgemerkt: endgültig am ' + dr.data.deleteAfter : 'Fehler: ' + ((dr.data && dr.data.error) || dr.status));
            renderPanel();
          });
        };
        var bc = panel.querySelector('#waCancelDel');
        if (bc) bc.onclick = function () {
          req('POST', '/dsgvo/cancel-deletion', {}, getSession().accessToken).then(function () { renderPanel(); });
        };
        panel.querySelector('#waLogout').onclick = logout;
      });
    }
  }

  // --------------------------------------------------------------------------
  // Boot
  // --------------------------------------------------------------------------
  window.WERKOS = {
    applyServerConfig: applyServerConfig,
    session: getSession,
    refresh: refreshSession,
    logout: logout
  };

  function boot() {
    injectCss();
    var inviteMatch = location.hash.match(/[#&]invite=([A-Za-z0-9_-]+)/);
    var s = getSession();
    if (inviteMatch && !s) { showGate(inviteMatch[1]); return; }
    if (!s) { showGate(null); return; }
    // Aktive Session: Token auffrischen, Konfiguration erzwingen, Widget zeigen
    refreshSession();
    applyServerConfig();
    setInterval(refreshSession, 4 * 3600 * 1000);
    showAccountWidget();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
