/* werkflow Website — Burger-Menü + sanftes Einblenden beim Scrollen */
(function () {
  'use strict';
  var b = document.querySelector('.burger');
  var m = document.querySelector('.mobile-menu');
  if (b && m) {
    b.addEventListener('click', function () {
      m.classList.toggle('open');
      b.setAttribute('aria-expanded', m.classList.contains('open') ? 'true' : 'false');
    });
  }

  // Reveal-on-Scroll: gängige Bausteine automatisch sanft einblenden — ohne
  // dass jede Seite Klassen setzen muss. Fällt sauber zurück (kein IO / reduzierte Bewegung).
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var nodes = document.querySelectorAll('.sec-head, .pain, .how-card, .mod, .plan, .calc-card, .cmp-wrap, .cta-band, .form, .matrix, .faq-cat, details');
  var targets = [];
  for (var i = 0; i < nodes.length; i++) { nodes[i].classList.add('reveal'); targets.push(nodes[i]); }
  if (!targets.length || reduce || !('IntersectionObserver' in window)) {
    for (var j = 0; j < targets.length; j++) targets[j].classList.add('in');
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  targets.forEach(function (t, idx) {
    // leichte Staffelung innerhalb einer Gruppe
    t.style.transitionDelay = ((idx % 6) * 55) + 'ms';
    io.observe(t);
  });
  // Sicherheitsnetz: falls ein Element nie den Schwellenwert kreuzt (sehr großes
  // Fenster, Layout-Sonderfall), nach kurzer Zeit trotzdem sichtbar machen.
  setTimeout(function () {
    for (var k = 0; k < targets.length; k++) if (!targets[k].classList.contains('in')) targets[k].classList.add('in');
  }, 2600);
})();

/* KI-Beratungs-Chatbot — schwebender Button + Panel. Spricht mit /api/chat;
   ohne erreichbaren Server (z. B. statisches Hosting) fällt er sauber auf ein
   Kontaktformular zurück (Support-Ticket bzw. E-Mail). */
(function () {
  'use strict';
  if (document.getElementById('wfChatBtn')) return;
  var SUPPORT_MAIL = 'support@werkflow.de';
  var css = '#wfChatBtn{position:fixed;right:18px;bottom:18px;z-index:9998;width:56px;height:56px;border-radius:50%;border:none;'
    + 'background:linear-gradient(135deg,#1e8449,#25a25a);color:#fff;font-size:26px;cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.28)}'
    + '#wfChatBtn:hover{transform:translateY(-2px)}'
    + '#wfChat{position:fixed;right:18px;bottom:84px;z-index:9999;width:min(360px,calc(100vw - 24px));max-height:min(560px,80vh);'
    + 'display:none;flex-direction:column;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.32);font-family:inherit}'
    + '#wfChat.open{display:flex}'
    + '#wfChat .hd{background:#0f2236;color:#fff;padding:13px 15px;font-weight:700;font-size:14px;display:flex;justify-content:space-between;align-items:center}'
    + '#wfChat .hd small{display:block;font-weight:400;color:#9fb3c8;font-size:11px;margin-top:2px}'
    + '#wfChat .hd button{background:none;border:none;color:#9fb3c8;font-size:20px;cursor:pointer;line-height:1}'
    + '#wfChat .bd{flex:1;overflow-y:auto;padding:14px;background:#f6f8fb;display:flex;flex-direction:column;gap:9px}'
    + '#wfChat .msg{max-width:85%;padding:9px 12px;border-radius:13px;font-size:13.5px;line-height:1.4;white-space:pre-wrap}'
    + '#wfChat .msg.bot{background:#fff;border:1px solid #e6ecf2;align-self:flex-start;border-bottom-left-radius:4px}'
    + '#wfChat .msg.me{background:#1e8449;color:#fff;align-self:flex-end;border-bottom-right-radius:4px}'
    + '#wfChat .chips{display:flex;flex-wrap:wrap;gap:6px}'
    + '#wfChat .chip{font-size:12px;background:#eaf5ee;color:#1e8449;border:1px solid #cdead8;border-radius:14px;padding:5px 10px;cursor:pointer}'
    + '#wfChat .ft{border-top:1px solid #e6ecf2;padding:9px;display:flex;gap:7px;background:#fff}'
    + '#wfChat .ft input{flex:1;padding:9px 11px;border:1px solid #cdd6df;border-radius:10px;font-size:13.5px;font-family:inherit}'
    + '#wfChat .ft button{border:none;background:#1e8449;color:#fff;border-radius:10px;padding:0 14px;font-weight:700;cursor:pointer}'
    + '#wfChat .contact{padding:12px;background:#fff;border-top:1px solid #e6ecf2;display:none}'
    + '#wfChat .contact.show{display:block}'
    + '#wfChat .contact input,#wfChat .contact textarea{width:100%;margin-top:6px;padding:8px 10px;border:1px solid #cdd6df;border-radius:9px;font-size:13px;font-family:inherit}'
    + '#wfChat .contact button{margin-top:8px;width:100%;border:none;background:#0f2236;color:#fff;border-radius:9px;padding:10px;font-weight:700;cursor:pointer}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var btn = document.createElement('button');
  btn.id = 'wfChatBtn'; btn.type = 'button'; btn.setAttribute('aria-label', 'Fragen? KI-Berater öffnen'); btn.innerHTML = '💬';
  var panel = document.createElement('div');
  panel.id = 'wfChat'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'werkflow KI-Berater');
  panel.innerHTML =
    '<div class="hd"><div>werkflow-Berater<small>Fragen zu Modulen, Preis &amp; Start</small></div><button type="button" id="wfChatX" aria-label="Schließen">×</button></div>'
    + '<div class="bd" id="wfChatBody"></div>'
    + '<div class="contact" id="wfChatContact"><div style="font-size:12.5px;color:#456;">Sollen wir dich persönlich beraten? Hinterlasse Kontakt:</div>'
    + '<input id="wfCName" placeholder="Name"><input id="wfCMail" type="email" placeholder="E-Mail"><input id="wfCPhone" placeholder="Telefon (optional)">'
    + '<textarea id="wfCMsg" rows="2" placeholder="Dein Anliegen"></textarea><button type="button" id="wfCSend">Absenden</button></div>'
    + '<div class="ft"><input id="wfChatIn" placeholder="Deine Frage…" autocomplete="off"><button type="button" id="wfChatSend">Senden</button></div>';
  document.body.appendChild(btn); document.body.appendChild(panel);

  var body = panel.querySelector('#wfChatBody');
  var input = panel.querySelector('#wfChatIn');
  var history = [];
  var started = false;

  function add(role, text) {
    var d = document.createElement('div'); d.className = 'msg ' + (role === 'user' ? 'me' : 'bot'); d.textContent = text;
    body.appendChild(d); body.scrollTop = body.scrollHeight; return d;
  }
  function chips(items) {
    var wrap = document.createElement('div'); wrap.className = 'chips';
    items.forEach(function (q) { var c = document.createElement('span'); c.className = 'chip'; c.textContent = q; c.onclick = function () { input.value = q; sendMsg(); }; wrap.appendChild(c); });
    body.appendChild(wrap); body.scrollTop = body.scrollHeight;
  }
  function showContact() { panel.querySelector('#wfChatContact').classList.add('show'); }

  function greet() {
    if (started) return; started = true;
    add('assistant', 'Hallo! 👋 Ich beantworte kurz deine Fragen zu werkflow — Module, Preise oder wie du startest. Was möchtest du wissen?');
    chips(['Was kostet das?', 'Welche Module gibt es?', 'Wie schnell bin ich startklar?', 'Persönlich beraten lassen']);
  }

  function sendMsg() {
    var text = (input.value || '').trim(); if (!text) return;
    input.value = '';
    if (/persönlich|mensch|anruf|beraten|kontakt|support/i.test(text)) { add('user', text); add('assistant', 'Sehr gern — hinterlasse hier kurz deinen Kontakt, wir melden uns zeitnah.'); showContact(); return; }
    add('user', text); history.push({ role: 'user', text: text });
    var typing = add('assistant', '…');
    fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: history.slice(-12) }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        typing.textContent = j.reply || 'Dazu berate ich dich gern persönlich.';
        history.push({ role: 'assistant', text: typing.textContent });
        if (j.wantsHuman || j.configured === false) showContact();
        if (j.leadIntent) chips(['14 Tage kostenlos testen', 'Direkt kaufen']);
      })
      .catch(function () {
        typing.textContent = 'Ich bin gerade nicht erreichbar — hinterlasse kurz deinen Kontakt, wir melden uns persönlich.';
        showContact();
      });
  }

  panel.querySelector('#wfChatSend').onclick = sendMsg;
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') sendMsg(); });
  panel.querySelector('#wfCSend').onclick = function () {
    var name = panel.querySelector('#wfCName').value.trim();
    var mail = panel.querySelector('#wfCMail').value.trim();
    var phone = panel.querySelector('#wfCPhone').value.trim();
    var msg = panel.querySelector('#wfCMsg').value.trim();
    if (!mail && !phone) { alert('Bitte E-Mail oder Telefon angeben.'); return; }
    var payload = { name: name, email: mail, phone: phone, topic: 'Website-Chat', message: msg, messages: history.slice(-12) };
    fetch('/api/chat/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function () { panel.querySelector('#wfChatContact').innerHTML = '<div style="color:#1e8449;font-weight:700;">✓ Danke! Wir melden uns zeitnah.</div>'; })
      .catch(function () { window.location.href = 'mailto:' + SUPPORT_MAIL + '?subject=' + encodeURIComponent('Beratung werkflow') + '&body=' + encodeURIComponent((msg || '') + '\n\n' + name + ' · ' + mail + ' · ' + phone); });
  };
  btn.onclick = function () { panel.classList.toggle('open'); if (panel.classList.contains('open')) { greet(); input.focus(); } };
  panel.querySelector('#wfChatX').onclick = function () { panel.classList.remove('open'); };
})();
