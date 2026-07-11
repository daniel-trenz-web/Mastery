'use strict';
// Website-Generator (Rendering). Nimmt strukturierte Inhalte (von der KI oder aus
// dem Workflow) + Betriebsdaten und rendert eine vollständige, SEO-optimierte,
// DSGVO-konforme statische Website in einer von 3 Vorlagen. Kein externer Dienst,
// keine Tracker — daher datensparsam; Cookie-Consent nur für optionale Einbettungen
// (z. B. Karte). Reine Funktion.

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function attr(s) { return esc(s).replace(/'/g, '&#39;'); }
// JSON-LD sicher in einen <script>-Block einbetten (Ausbruch via </script> verhindern)
function jsonLdSafe(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}
function slugify(s) {
  return String(s || 'website').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'website';
}

// 3 Vorlagen: unterschiedliche Farbwelt, Typo & Hero-Layout
const TEMPLATES = {
  modern: { name: 'Modern', font: "-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif", primary: '#1a5cff', dark: '#0b1f3a', bg: '#ffffff', soft: '#f4f7fb', hero: 'split', radius: '14px' },
  bold: { name: 'Bold', font: "'Segoe UI',system-ui,sans-serif", primary: '#ff6b2c', dark: '#12100e', bg: '#ffffff', soft: '#faf6f2', hero: 'cover', radius: '6px' },
  classic: { name: 'Klassisch', font: "Georgia,'Times New Roman',serif", primary: '#2e6b4f', dark: '#20302a', bg: '#fbfaf7', soft: '#eef3ef', hero: 'centered', radius: '4px' },
};

// Inhalte aus rohem Workflow-Input bauen (Fallback ohne KI)
function contentFromInput(input) {
  const i = input || {};
  const ort = i.city || i.ort || '';
  const services = (i.services || i.leistungen || []).map((s) => (
    typeof s === 'string' ? { title: s, text: '', icon: '🔧' } : { title: s.title || s.name || '', text: s.text || s.desc || '', icon: s.icon || '🔧' }
  )).filter((s) => s.title);
  return {
    seoTitle: (i.companyName || i.name || 'Ihr Betrieb') + (ort ? ' – ' + i.branche + ' in ' + ort : (i.branche ? ' – ' + i.branche : '')),
    metaDescription: (i.slogan || i.tagline || ('Ihr Partner für ' + (i.branche || 'Handwerk') + (ort ? ' in ' + ort : '') + '. Jetzt unverbindlich anfragen.')).slice(0, 160),
    keywords: [i.branche, ort].concat(services.map((s) => s.title)).filter(Boolean),
    heroHeadline: i.slogan || i.tagline || (i.branche ? i.branche + (ort ? ' in ' + ort : '') : (i.companyName || 'Willkommen')),
    heroSubline: i.intro || i.about || ('Qualität und Zuverlässigkeit' + (ort ? ' in ' + ort + ' und Umgebung.' : '.')),
    aboutTitle: 'Über uns',
    aboutText: i.about || i.beschreibung || '',
    services,
    usps: (i.usps || []).map((u) => (typeof u === 'string' ? { title: u, text: '' } : u)),
    faq: i.faq || [],
    ctaText: i.ctaText || 'Jetzt Angebot anfragen',
  };
}

// KI-Inhalte + Fallback zusammenführen
function mergeContent(aiContent, input) {
  const base = contentFromInput(input);
  if (!aiContent) return base;
  const c = Object.assign({}, base, aiContent);
  if (!c.services || !c.services.length) c.services = base.services;
  return c;
}

function commonHead(content, biz, tpl, canonical, pageTitle) {
  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'LocalBusiness',
    name: biz.companyName || biz.name || '', description: content.metaDescription,
    telephone: biz.phone || '', email: biz.email || '',
    address: { '@type': 'PostalAddress', streetAddress: biz.address || '', addressLocality: biz.city || '', postalCode: biz.zip || '', addressCountry: 'DE' },
    url: canonical || '',
  };
  return `<!doctype html><html lang="de"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(pageTitle || content.seoTitle)}</title>
<meta name="description" content="${attr(content.metaDescription)}">
${content.keywords && content.keywords.length ? '<meta name="keywords" content="' + attr(content.keywords.join(', ')) + '">' : ''}
<meta property="og:type" content="website"><meta property="og:title" content="${attr(pageTitle || content.seoTitle)}">
<meta property="og:description" content="${attr(content.metaDescription)}">
${canonical ? '<link rel="canonical" href="' + attr(canonical) + '">' : ''}
<meta name="robots" content="index,follow">
<script type="application/ld+json">${jsonLdSafe(jsonLd)}</script>
<style>${css(tpl)}</style>
</head>`;
}

function hexA(hex, a) {
  var h = String(hex || '').replace('#', '');
  if (h.length !== 6) return hex;
  var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}
function css(t) {
  return `*{box-sizing:border-box;margin:0;padding:0}html{scroll-behavior:smooth}
body{font-family:${t.font};color:${t.dark};background:${t.bg};line-height:1.6}
a{color:${t.primary};text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1080px;margin:0 auto;padding:0 20px}
header.nav{position:sticky;top:0;background:rgba(255,255,255,.95);backdrop-filter:blur(6px);border-bottom:1px solid #e8edf3;z-index:50}
header.nav .wrap{display:flex;align-items:center;justify-content:space-between;height:64px}
.brand{font-weight:800;font-size:20px;color:${t.dark}}
nav.menu a{margin-left:22px;color:${t.dark};font-weight:600;font-size:15px}
.btn{display:inline-block;background:${t.primary};color:#fff;padding:12px 22px;border-radius:${t.radius};font-weight:700;border:none;cursor:pointer;transition:background .15s,transform .1s}
.btn:hover{background:${t.accent};text-decoration:none;transform:translateY(-1px)}
.hero{padding:72px 0;${t.hero === 'cover'
    ? 'background:linear-gradient(135deg,' + t.dark + ',' + t.accent + ');color:#fff;'
    : 'background:linear-gradient(160deg,' + t.soft + ' 60%,' + hexA(t.accent, 0.10) + ');'}}
.hero h1{font-size:clamp(30px,5vw,52px);line-height:1.1;margin-bottom:16px}
.hero p{font-size:20px;max-width:640px;${t.hero === 'centered' ? 'margin:0 auto 26px;' : 'margin-bottom:26px;'}opacity:.9}
${t.hero === 'centered' ? '.hero .wrap{text-align:center}' : ''}
section{padding:60px 0}
h2{font-size:clamp(24px,3.5vw,34px);margin-bottom:26px;position:relative}
h2::after{content:"";display:block;width:52px;height:4px;border-radius:3px;background:${t.accent};margin-top:12px;${t.hero === 'centered' ? 'margin-left:auto;margin-right:auto;' : ''}}${t.hero === 'centered' ? 'section{text-align:center}' : ''}
.grid{display:grid;gap:22px;grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}
.card{background:${t.soft};border:1px solid #e8edf3;border-radius:${t.radius};padding:24px}
.card .ic{font-size:32px;display:block;margin-bottom:10px}
.card h3{font-size:19px;margin-bottom:8px}
.faq details{background:${t.soft};border:1px solid #e8edf3;border-radius:${t.radius};padding:14px 18px;margin-bottom:10px;text-align:left}
.faq summary{font-weight:700;cursor:pointer}
.contact{background:${t.soft}}
footer{background:${t.dark};color:#cdd6e0;padding:34px 0;font-size:14px}
footer a{color:#fff}footer .wrap{display:flex;flex-wrap:wrap;gap:16px;justify-content:space-between}
form label{display:block;font-weight:600;margin:12px 0 4px}
form input,form textarea{width:100%;padding:11px;border:1px solid #cdd6e0;border-radius:8px;font:inherit}
.consent{position:fixed;left:0;right:0;bottom:0;background:#0b1f3a;color:#fff;padding:16px 20px;display:none;z-index:100;font-size:14px}
.consent.show{display:block}.consent .wrap{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
.consent button{margin-left:8px}
@media(max-width:640px){nav.menu{display:none}}`;
}

function heroSection(content, biz, tpl) {
  return `<section class="hero"><div class="wrap">
<h1>${esc(content.heroHeadline)}</h1>
<p>${esc(content.heroSubline)}</p>
<a class="btn" href="#kontakt">${esc(content.ctaText || 'Kontakt aufnehmen')}</a>
</div></section>`;
}
function servicesSection(content) {
  if (!content.services || !content.services.length) return '';
  return `<section id="leistungen"><div class="wrap"><h2>Leistungen</h2><div class="grid">${
    content.services.map((s) => `<div class="card"><span class="ic">${esc(s.icon || '🔧')}</span><h3>${esc(s.title)}</h3><p>${esc(s.text || '')}</p></div>`).join('')
  }</div></div></section>`;
}
function aboutSection(content) {
  if (!content.aboutText) return '';
  return `<section id="ueber-uns"><div class="wrap"><h2>${esc(content.aboutTitle || 'Über uns')}</h2><p style="max-width:760px;font-size:18px">${esc(content.aboutText)}</p></div></section>`;
}
function uspSection(content) {
  if (!content.usps || !content.usps.length) return '';
  return `<section style="background:transparent"><div class="wrap"><div class="grid">${
    content.usps.map((u) => `<div class="card"><h3>✓ ${esc(u.title)}</h3><p>${esc(u.text || '')}</p></div>`).join('')
  }</div></div></section>`;
}
function faqSection(content) {
  if (!content.faq || !content.faq.length) return '';
  return `<section id="faq"><div class="wrap"><h2>Häufige Fragen</h2><div class="faq">${
    content.faq.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')
  }</div></div></section>`;
}
function contactSection(biz) {
  return `<section id="kontakt" class="contact"><div class="wrap"><h2>Kontakt</h2>
<div class="grid"><div>
${biz.phone ? '<p><b>Telefon:</b> <a href="tel:' + attr(biz.phone) + '">' + esc(biz.phone) + '</a></p>' : ''}
${biz.email ? '<p><b>E-Mail:</b> <a href="mailto:' + attr(biz.email) + '">' + esc(biz.email) + '</a></p>' : ''}
${biz.address ? '<p><b>Adresse:</b><br>' + esc(biz.address) + '<br>' + esc((biz.zip || '') + ' ' + (biz.city || '')) + '</p>' : ''}
</div>
<form onsubmit="return sendContact(event)">
<label>Name</label><input name="name" required>
<label>E-Mail</label><input type="email" name="email" required>
<label>Nachricht</label><textarea name="message" rows="4" required></textarea>
<label style="font-weight:400;font-size:13px"><input type="checkbox" required style="width:auto;margin-right:6px">Ich habe die <a href="datenschutz.html">Datenschutzerklärung</a> gelesen und stimme zu.</label>
<p style="margin-top:14px"><button class="btn" type="submit">Nachricht senden</button></p>
</form></div></div></section>`;
}

function nav(biz) {
  return `<header class="nav"><div class="wrap"><a class="brand" href="index.html">${esc(biz.companyName || biz.name || 'Startseite')}</a>
<nav class="menu"><a href="#leistungen">Leistungen</a><a href="#ueber-uns">Über uns</a><a href="#faq">FAQ</a><a href="#kontakt">Kontakt</a></nav>
</div></header>`;
}
function footer(biz) {
  return `<footer><div class="wrap">
<div>© ${new Date().getFullYear()} ${esc(biz.companyName || biz.name || '')}</div>
<div><a href="impressum.html">Impressum</a> &nbsp;·&nbsp; <a href="datenschutz.html">Datenschutz</a></div>
</div></footer>`;
}
// Cookie-Consent: standardmäßig werden KEINE Cookies/Tracker gesetzt. Der Banner
// erscheint nur, wenn optionale Einbettungen aktiviert sind, und blockiert diese
// bis zur Einwilligung (Opt-in, Art. 6 DSGVO / TTDSG).
function consentBanner() {
  return `<div class="consent" id="cc"><div class="wrap">
<span>Diese Website verwendet nur technisch notwendige Speicherung. Optionale Inhalte (z. B. Karte) werden erst nach Ihrer Einwilligung geladen.</span>
<span><button class="btn" onclick="ccOk()">Einverstanden</button><button class="btn" style="background:#556" onclick="ccNo()">Nur notwendige</button></span>
</div></div>
<script>
function ccOk(){try{localStorage.setItem('cc','all')}catch(e){}document.getElementById('cc').classList.remove('show')}
function ccNo(){try{localStorage.setItem('cc','ess')}catch(e){}document.getElementById('cc').classList.remove('show')}
(function(){try{if(!localStorage.getItem('cc'))document.getElementById('cc').classList.add('show')}catch(e){}})();
function sendContact(e){e.preventDefault();alert('Vielen Dank! Ihre Nachricht wurde vorbereitet. (Formularversand über werkflow anbinden.)');return false}
</script>`;
}

function renderIndex(content, biz, tpl, canonical) {
  return commonHead(content, biz, tpl, canonical) + '<body>' + nav(biz) +
    heroSection(content, biz, tpl) + aboutSection(content) + servicesSection(content) + uspSection(content) + faqSection(content) + contactSection(biz) +
    footer(biz) + consentBanner() + '</body></html>';
}
function legalPage(title, bodyHtml, content, biz, tpl) {
  return commonHead(content, biz, tpl, '', title + ' – ' + (biz.companyName || biz.name || '')) + '<body>' + nav(biz) +
    '<section><div class="wrap" style="max-width:800px"><h2>' + esc(title) + '</h2>' + bodyHtml + '</div></section>' +
    footer(biz) + consentBanner() + '</body></html>';
}
function impressumHtml(biz) {
  return `<p>Angaben gemäß § 5 DDG</p>
<p><b>${esc(biz.companyName || biz.name || '')}</b><br>${esc(biz.address || '')}<br>${esc((biz.zip || '') + ' ' + (biz.city || ''))}</p>
${biz.owner ? '<p>Vertreten durch: ' + esc(biz.owner) + '</p>' : ''}
<p>Kontakt:<br>${biz.phone ? 'Telefon: ' + esc(biz.phone) + '<br>' : ''}${biz.email ? 'E-Mail: ' + esc(biz.email) : ''}</p>
${biz.vatId ? '<p>Umsatzsteuer-ID: ' + esc(biz.vatId) + '</p>' : ''}
${biz.register ? '<p>' + esc(biz.register) + '</p>' : ''}
<p style="color:#889;font-size:13px">Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV: ${esc(biz.owner || biz.companyName || '')}</p>`;
}
function datenschutzHtml(biz) {
  const name = esc(biz.companyName || biz.name || 'der Betreiber');
  return `<p>Wir freuen uns über Ihr Interesse. Der Schutz Ihrer personenbezogenen Daten ist uns wichtig.</p>
<h3 style="margin:18px 0 6px">1. Verantwortlicher</h3><p>${name}${biz.address ? ', ' + esc(biz.address) + ', ' + esc((biz.zip || '') + ' ' + (biz.city || '')) : ''}${biz.email ? ', ' + esc(biz.email) : ''}.</p>
<h3 style="margin:18px 0 6px">2. Hosting &amp; Server-Logs</h3><p>Beim Aufruf der Website werden durch den Hosting-Provider automatisch Zugriffsdaten (IP-Adresse, Zeitpunkt, abgerufene Seite) in Server-Logfiles verarbeitet. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO (Betrieb und Sicherheit der Website). Die Daten werden nach kurzer Zeit gelöscht.</p>
<h3 style="margin:18px 0 6px">3. Kontaktaufnahme</h3><p>Wenn Sie uns über das Kontaktformular oder per E-Mail kontaktieren, verarbeiten wir Ihre Angaben zur Bearbeitung der Anfrage (Art. 6 Abs. 1 lit. b bzw. f DSGVO). Die Daten werden gelöscht, sobald sie nicht mehr erforderlich sind.</p>
<h3 style="margin:18px 0 6px">4. Cookies</h3><p>Diese Website setzt keine Tracking- oder Marketing-Cookies. Es wird lediglich eine technisch notwendige lokale Speicherung Ihrer Cookie-Auswahl verwendet. Optionale Inhalte werden erst nach Ihrer Einwilligung geladen.</p>
<h3 style="margin:18px 0 6px">5. Ihre Rechte</h3><p>Sie haben das Recht auf Auskunft (Art. 15 DSGVO), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung (Art. 18), Datenübertragbarkeit (Art. 20) und Widerspruch (Art. 21) sowie ein Beschwerderecht bei einer Aufsichtsbehörde.</p>
<p style="color:#889;font-size:13px">Automatisch generierter Basistext – bitte vor Veröffentlichung rechtlich prüfen lassen.</p>`;
}

function validColor(s) {
  return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.trim()) ? s.trim().toLowerCase() : null;
}
// Zwei Voreinstellungen (für den Baukasten). „bold" bleibt für Bestands-Sites erhalten.
const PRESETS = [
  { key: 'modern', name: 'Modern', desc: 'Klar, luftig, serifenlos — für die meisten Betriebe', colors: { primary: '#1a5cff', secondary: '#0b1f3a', accent: '#12b981' } },
  { key: 'classic', name: 'Klassisch', desc: 'Seriös mit Serifen — für Handwerk mit Tradition', colors: { primary: '#2e6b4f', secondary: '#20302a', accent: '#c08a2d' } },
];

function renderSite(aiContent, biz, opts) {
  const o = opts || {};
  const tplKey = TEMPLATES[o.template] ? o.template : 'modern';
  const baseTpl = TEMPLATES[tplKey];
  // Drei frei wählbare Farben überschreiben die Preset-Defaults.
  const c = o.colors || {};
  const tpl = Object.assign({}, baseTpl, {
    primary: validColor(c.primary) || baseTpl.primary,
    dark: validColor(c.secondary) || baseTpl.dark,
    accent: validColor(c.accent) || validColor(c.primary) || baseTpl.primary,
  });
  const content = mergeContent(aiContent, o.input || biz);
  const canonical = o.canonical || '';
  const pages = {
    'index.html': renderIndex(content, biz, tpl, canonical),
    'impressum.html': legalPage('Impressum', impressumHtml(biz), content, biz, tpl),
    'datenschutz.html': legalPage('Datenschutzerklärung', datenschutzHtml(biz), content, biz, tpl),
  };
  const base = (canonical || '').replace(/index\.html$/, '').replace(/\/$/, '');
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    ['index.html', 'impressum.html', 'datenschutz.html'].map((p) => `<url><loc>${esc(base + '/' + p)}</loc></url>`).join('') + '</urlset>';
  const robots = 'User-agent: *\nAllow: /\n' + (base ? 'Sitemap: ' + base + '/sitemap.xml\n' : '');
  return { template: tplKey, colors: { primary: tpl.primary, secondary: tpl.dark, accent: tpl.accent }, slug: slugify(biz.companyName || biz.name), pages, 'sitemap.xml': sitemap, 'robots.txt': robots, content };
}

module.exports = { renderSite, contentFromInput, mergeContent, slugify, validColor, TEMPLATES, PRESETS };
