'use strict';
// Baut die STATISCHE Variante für GitHub Pages nach dist-static/:
//   - Website als index.html (relative Links statt Server-Routen)
//   - App als app.html im Demo-Modus (window.WERKOS_STATIC — kein Backend,
//     Daten bleiben im Browser)
//   - Impressum/Datenschutz, Bibliotheken, Icons, Manifest
// Bewusst NICHT enthalten: offer.html/admin.html (brauchen den Server).
//
// Aufruf: node tools/build-static-site.js  → dist-static/

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const OUT = path.join(ROOT, 'dist-static');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ---------------------------------------------------------------------------
// 1) Website → index.html (Server-Routen durch relative Dateinamen ersetzen)
// ---------------------------------------------------------------------------
let home = fs.readFileSync(path.join(WEB, 'home.html'), 'utf8');
home = home
  .replaceAll('href="/app"', 'href="app.html"')
  .replaceAll('href="/impressum"', 'href="impressum.html"')
  .replaceAll('href="/datenschutz"', 'href="datenschutz.html"')
  .replaceAll('href="/"', 'href="index.html"');

// Demo-Formular ersetzen: ohne Server keinen Account anlegen — stattdessen
// direkt in die Browser-Demo springen.
const formStart = home.indexOf('<div class="form" id="demoForm">');
const formEnd = home.indexOf('</div>\n      </div>\n    </div>\n  </div>\n</section>', formStart);
if (formStart < 0 || formEnd < 0) throw new Error('Demo-Formular-Block nicht gefunden — home.html geändert?');
const staticDemoCard = `<div class="form" id="demoForm" style="text-align:center;">
        <h3 style="font-size:18px;">App-Demo direkt im Browser</h3>
        <p style="color:var(--mut); font-size:14px; margin:12px 0 4px;">Diese Vorschau läuft ohne Server:
        Du kannst <b>alle Funktionen sofort ausprobieren</b> — mit Beispieldaten, ohne Anmeldung.
        Deine Eingaben bleiben nur in deinem Browser gespeichert.</p>
        <a class="btn primary big" href="app.html" style="display:block; margin-top:18px;">🚀 Demo jetzt im Browser starten</a>
        <p style="font-size:12px; color:var(--soft); margin-top:12px;">Team-Login, Kunden-Links mit Unterschrift und
        DSGVO/GoBD-Archiv gibt es in der Server-Version — Anleitung im Projekt (docs/DEPLOYMENT.md).</p>
      `;
home = home.slice(0, formStart) + staticDemoCard + home.slice(formEnd);
// Das Formular-Script der Server-Variante läuft ins Leere — sauber beenden
home = home.replace("var btn = document.getElementById('dGo');",
  "var btn = document.getElementById('dGo');\n  if (!btn) return; // statische Variante ohne Demo-Formular");
fs.writeFileSync(path.join(OUT, 'index.html'), home);

// ---------------------------------------------------------------------------
// 2) App → app.html mit Demo-Modus-Flag (vor saas.js gesetzt)
// ---------------------------------------------------------------------------
let app = fs.readFileSync(path.join(WEB, 'app.html'), 'utf8');
const saasTag = '<script src="saas.js"></script>';
if (!app.includes(saasTag)) throw new Error('saas.js-Tag nicht gefunden in app.html');
app = app.replace(saasTag, '<script>window.WERKOS_STATIC = true;</script>\n' + saasTag);
fs.writeFileSync(path.join(OUT, 'app.html'), app);

// ---------------------------------------------------------------------------
// 3) Rechtsseiten (Links relativieren), Assets, Manifest
// ---------------------------------------------------------------------------
for (const f of ['impressum.html', 'datenschutz.html']) {
  let html = fs.readFileSync(path.join(WEB, f), 'utf8');
  html = html
    .replaceAll('href="/impressum"', 'href="impressum.html"')
    .replaceAll('href="/datenschutz"', 'href="datenschutz.html"')
    .replaceAll('href="/"', 'href="index.html"');
  fs.writeFileSync(path.join(OUT, f), html);
}

fs.copyFileSync(path.join(WEB, 'saas.js'), path.join(OUT, 'saas.js'));
copyDir(path.join(WEB, 'lib'), path.join(OUT, 'lib'));
copyDir(path.join(WEB, 'icons'), path.join(OUT, 'icons'));

let manifest = JSON.parse(fs.readFileSync(path.join(WEB, 'manifest.webmanifest'), 'utf8'));
manifest.start_url = 'app.html'; // Pages liegt unter /<repo>/ — relativ bleiben
fs.writeFileSync(path.join(OUT, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2));

// GitHub Pages: kein Jekyll-Processing (Dateien mit _ etc. unangetastet lassen)
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

const count = fs.readdirSync(OUT).length;
console.log('[build-static] dist-static/ erstellt (' + count + ' Einträge).');
