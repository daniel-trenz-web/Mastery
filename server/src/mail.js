'use strict';
// Ausgehender E-Mail-Versand — abhängigkeitsfrei.
// Primär: SMTP über node:tls/node:net (implizites TLS auf 465, STARTTLS auf 587).
// Alternativ: HTTP-Mail-API (Provider-JSON-Endpoint) via fetch.
// Ohne Konfiguration liefert isConfigured()=false; Aufrufer fallen dann auf den
// manuellen Modus zurück (Link teilen), analog zur KI-Abstraktion.

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const cfg = require('./config');

function isConfigured() {
  return !!(cfg.MAIL_API_URL || (cfg.SMTP_HOST && cfg.SMTP_USER && cfg.SMTP_PASS));
}

// ---- MIME ---------------------------------------------------------------------
function encodeHeader(v) {
  const s = String(v == null ? '' : v);
  if (/^[\x20-\x7E]*$/.test(s)) return s; // reines ASCII
  return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}
function b64lines(buf) { return buf.toString('base64').replace(/(.{76})/g, '$1\r\n'); }
function addrList(a) { return Array.isArray(a) ? a.join(', ') : String(a || ''); }

function buildMime(msg, boundaryFn) {
  const bnd = boundaryFn ? boundaryFn() : 'b_' + crypto.randomBytes(12).toString('hex');
  const bnd2 = 'a_' + (boundaryFn ? boundaryFn() : crypto.randomBytes(12).toString('hex'));
  const headers = [];
  headers.push('From: ' + (msg.fromName ? encodeHeader(msg.fromName) + ' <' + msg.from + '>' : msg.from));
  headers.push('To: ' + addrList(msg.to));
  if (msg.cc) headers.push('Cc: ' + addrList(msg.cc));
  if (msg.replyTo) headers.push('Reply-To: ' + msg.replyTo);
  headers.push('Subject: ' + encodeHeader(msg.subject || ''));
  headers.push('MIME-Version: 1.0');
  headers.push('Message-ID: <' + crypto.randomBytes(16).toString('hex') + '@werkflow>');
  if (msg.date) headers.push('Date: ' + msg.date);

  const atts = msg.attachments || [];
  const text = msg.text != null ? msg.text : '';
  const html = msg.html;

  function bodyBlock() {
    if (html) {
      return 'Content-Type: multipart/alternative; boundary="' + bnd2 + '"\r\n\r\n' +
        '--' + bnd2 + '\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + b64lines(Buffer.from(text, 'utf8')) + '\r\n' +
        '--' + bnd2 + '\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + b64lines(Buffer.from(html, 'utf8')) + '\r\n' +
        '--' + bnd2 + '--\r\n';
    }
    return 'Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + b64lines(Buffer.from(text, 'utf8')) + '\r\n';
  }

  if (!atts.length) {
    return headers.join('\r\n') + '\r\n' + bodyBlock();
  }
  const parts = [];
  parts.push('--' + bnd + '\r\n' + bodyBlock());
  for (const a of atts) {
    const buf = Buffer.isBuffer(a.content) ? a.content : Buffer.from(String(a.content || ''), a.encoding || 'utf8');
    parts.push('--' + bnd + '\r\n' +
      'Content-Type: ' + (a.contentType || 'application/octet-stream') + '; name="' + (a.filename || 'anhang') + '"\r\n' +
      'Content-Transfer-Encoding: base64\r\n' +
      'Content-Disposition: attachment; filename="' + (a.filename || 'anhang') + '"\r\n\r\n' +
      b64lines(buf) + '\r\n');
  }
  return headers.join('\r\n') + '\r\n' +
    'Content-Type: multipart/mixed; boundary="' + bnd + '"\r\n\r\n' +
    parts.join('') + '--' + bnd + '--\r\n';
}

// ---- SMTP-Client --------------------------------------------------------------
function smtpConverse(socket, steps) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let idx = 0;
    let done = false;
    const finish = (err, val) => { if (done) return; done = true; socket.removeAllListeners('data'); err ? reject(err) : resolve(val); };
    socket.setEncoding('utf8');
    socket.on('data', (d) => {
      buf += d;
      // Vollständige Antwort? Letzte Zeile hat Leerzeichen nach dem Code.
      const lines = buf.split(/\r\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last || !/^\d{3}[ ]/.test(last)) return;
      const code = parseInt(last.slice(0, 3), 10);
      const response = buf; buf = '';
      const step = steps[idx++];
      if (!step) return finish(null, response);
      if (step.expect && (code < step.expect[0] || code > step.expect[1])) {
        return finish(new Error('SMTP ' + code + ' bei Schritt ' + (step.name || idx) + ': ' + response.trim()));
      }
      const toSend = typeof step.send === 'function' ? step.send(code, response) : step.send;
      if (step.last) return finish(null, response);
      if (toSend != null) socket.write(toSend + '\r\n');
    });
    socket.on('error', (e) => finish(e));
    socket.on('close', () => finish(done ? null : new Error('SMTP-Verbindung vorzeitig geschlossen')));
  });
}

function withTimeout(socket, ms) {
  socket.setTimeout(ms || 20000, () => { socket.destroy(new Error('SMTP-Timeout')); });
  return socket;
}

async function sendSmtp(msg) {
  const host = cfg.SMTP_HOST, port = Number(cfg.SMTP_PORT || 587);
  const secure = cfg.SMTP_SECURE === true || cfg.SMTP_SECURE === 'true' || port === 465;
  const useStartTls = !(cfg.SMTP_STARTTLS === false || cfg.SMTP_STARTTLS === 'false');
  const from = msg.from || cfg.SMTP_FROM || cfg.SMTP_USER;
  const rcpts = (Array.isArray(msg.to) ? msg.to : [msg.to]).concat(msg.cc ? (Array.isArray(msg.cc) ? msg.cc : [msg.cc]) : []).filter(Boolean);
  const mime = buildMime(Object.assign({ from, date: new Date().toUTCString() }, msg));
  const ehlo = 'EHLO ' + (cfg.SMTP_EHLO || 'werkflow.local');

  function afterGreeting(socket, upgraded) {
    const authUser = Buffer.from(cfg.SMTP_USER, 'utf8').toString('base64');
    const authPass = Buffer.from(cfg.SMTP_PASS, 'utf8').toString('base64');
    const steps = [
      { name: 'greeting', expect: [200, 299], send: ehlo },
      { name: 'ehlo', expect: [200, 299], send: 'AUTH LOGIN' },
      { name: 'auth', expect: [300, 399], send: authUser },
      { name: 'user', expect: [300, 399], send: authPass },
      { name: 'pass', expect: [200, 299], send: 'MAIL FROM:<' + from + '>' },
      { name: 'from', expect: [200, 299], send: 'RCPT TO:<' + rcpts[0] + '>' },
    ];
    for (let i = 1; i < rcpts.length; i++) steps.push({ name: 'rcpt', expect: [200, 299], send: 'RCPT TO:<' + rcpts[i] + '>' });
    steps.push({ name: 'rcptlast', expect: [200, 299], send: 'DATA' });
    steps.push({ name: 'data', expect: [300, 399], send: mime.replace(/\r\n\.\r\n/g, '\r\n..\r\n') + '\r\n.' });
    steps.push({ name: 'body', expect: [200, 299], send: 'QUIT' });
    steps.push({ name: 'quit', last: true });
    return smtpConverse(socket, steps);
  }

  const tlsName = net.isIP(host) ? undefined : host; // RFC 6066: keine IP als SNI

  if (secure) {
    const socket = withTimeout(tls.connect({ host, port, servername: tlsName }), Number(cfg.SMTP_TIMEOUT_MS) || 20000);
    await new Promise((res, rej) => { socket.once('secureConnect', res); socket.once('error', rej); });
    await afterGreeting(socket, true);
    socket.end();
    return { ok: true, transport: 'smtps' };
  }

  const plain = withTimeout(net.connect({ host, port }), Number(cfg.SMTP_TIMEOUT_MS) || 20000);
  await new Promise((res, rej) => { plain.once('connect', res); plain.once('error', rej); });

  if (!useStartTls) {
    // Klartext-SMTP (nur für lokale Relays/Tests) — kein TLS
    await afterGreeting(plain, false);
    plain.end();
    return { ok: true, transport: 'plain' };
  }
  // STARTTLS
  await smtpConverse(plain, [
    { name: 'greeting', expect: [200, 299], send: ehlo },
    { name: 'ehlo', expect: [200, 299], send: 'STARTTLS' },
    { name: 'starttls', expect: [200, 299], last: true },
  ]);
  const secured = withTimeout(tls.connect({ socket: plain, servername: tlsName }), Number(cfg.SMTP_TIMEOUT_MS) || 20000);
  await new Promise((res, rej) => { secured.once('secureConnect', res); secured.once('error', rej); });
  await afterGreeting(secured, true);
  secured.end();
  return { ok: true, transport: 'starttls' };
}

async function sendViaApi(msg) {
  const body = {
    from: msg.from || cfg.SMTP_FROM,
    to: Array.isArray(msg.to) ? msg.to : [msg.to],
    subject: msg.subject, text: msg.text, html: msg.html,
    replyTo: msg.replyTo,
    attachments: (msg.attachments || []).map((a) => ({
      filename: a.filename, contentType: a.contentType,
      content: (Buffer.isBuffer(a.content) ? a.content : Buffer.from(String(a.content || ''))).toString('base64'),
    })),
  };
  const r = await fetch(cfg.MAIL_API_URL, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, cfg.MAIL_API_KEY ? { authorization: 'Bearer ' + cfg.MAIL_API_KEY } : {}),
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, error: 'api-http-' + r.status };
  return { ok: true, transport: 'http-api' };
}

async function sendMail(msg) {
  if (!isConfigured()) return { ok: false, configured: false, error: 'mail-not-configured' };
  try {
    if (cfg.MAIL_API_URL) return await sendViaApi(msg);
    return await sendSmtp(msg);
  } catch (e) {
    return { ok: false, configured: true, error: 'send-failed', message: String(e && e.message || e) };
  }
}

module.exports = { sendMail, buildMime, isConfigured };
