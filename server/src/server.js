'use strict';
// HTTP-Server: API-Routing + Auslieferung der PWA (web/) mit Security-Headern.

const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { handleApi } = require('./routes');
const { err } = require('./http');
const dbm = require('./db');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=(self)');
  // HSTS setzt Caddy in Produktion (nur über HTTPS sinnvoll)
}

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/app.html';
  else if (pathname === '/angebot') pathname = '/offer.html';       // öffentliche Angebotsseite
  else if (pathname === '/admin') pathname = '/admin.html';         // Betreiber-Konsole
  else if (pathname === '/favicon.ico') pathname = '/icons/icon-192.png';
  // Nur Dateien innerhalb von WEB_DIR — Traversal hart verhindern
  const clean = path.normalize(pathname).replace(/^([/\\])+/, '');
  const file = path.join(cfg.WEB_DIR, clean);
  if (!file.startsWith(path.resolve(cfg.WEB_DIR))) return err(res, 403, 'forbidden');
  fs.stat(file, (e, st) => {
    if (e || !st.isFile()) return err(res, 404, 'not-found');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function createServer() {
  const server = http.createServer(async (req, res) => {
    securityHeaders(res);

    // CORS: Die PWA wird vom selben Origin ausgeliefert — Cross-Origin nur für
    // lokale Entwicklung (file:// → Origin "null" bzw. localhost) erlauben.
    const origin = req.headers.origin;
    if (origin && (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || origin === 'null')) {
      res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Tenant-Key, If-Match');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    let pathname;
    try { pathname = decodeURI(new URL(req.url, 'http://x').pathname); }
    catch (_e) { return err(res, 400, 'bad-url'); }

    try {
      if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
      return err(res, 405, 'method-not-allowed');
    } catch (e) {
      if (e && e.status) return err(res, e.status, e.message);
      console.error('[werkos] Unerwarteter Fehler:', e);
      return err(res, 500, 'internal-error');
    }
  });

  // DSGVO-Housekeeping: fällige endgültige Löschungen einmal täglich ausführen
  const purgeTimer = setInterval(() => {
    try { dbm.purgeDueTenants(); } catch (e) { console.error('[werkos] purge:', e.message); }
  }, 24 * 3600 * 1000);
  purgeTimer.unref();

  return server;
}

module.exports = { createServer };
