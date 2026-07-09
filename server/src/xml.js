'use strict';
// Winziger, abhängigkeitsfreier XML-Parser — ausreichend für maschinell erzeugte
// E-Rechnungen (ZUGFeRD/CII, XRechnung/UBL) und CAMT.053-Kontoauszüge.
// Kein Anspruch auf vollständige XML-Spezifikation; toleriert Namespaces, indem
// nur der lokale Name (nach dem ':') für die Suche verwendet wird.

// Baut einen Baum: { name, local, attrs:{}, children:[], text:'' }
function parseXml(src) {
  let s = String(src == null ? '' : src);
  // BOM + XML-Deklaration + Kommentare + Doctype entfernen
  s = s.replace(/^﻿/, '')
       .replace(/<\?[\s\S]*?\?>/g, '')
       .replace(/<!--[\s\S]*?-->/g, '')
       .replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  const root = { name: '#root', local: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^<>]*?)?)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const close = m[1], tag = m[2], attrStr = m[3], selfClose = m[4], text = m[5];
    if (text != null) {
      const t = decodeEntities(text);
      if (t.trim()) stack[stack.length - 1].text += t;
      continue;
    }
    if (close) {
      // Schließen: bis zum passenden Tag zurückpoppen (tolerant)
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === tag) { stack.length = i; break; }
      }
      continue;
    }
    const node = { name: tag, local: localName(tag), attrs: parseAttrs(attrStr), children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

function localName(tag) { const i = tag.indexOf(':'); return i >= 0 ? tag.slice(i + 1) : tag; }

function parseAttrs(str) {
  const attrs = {};
  if (!str) return attrs;
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"|([A-Za-z_][\w.:-]*)\s*=\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const k = m[1] || m[3], v = m[2] != null ? m[2] : m[4];
    attrs[localName(k)] = decodeEntities(v);
  }
  return attrs;
}

function decodeEntities(t) {
  return t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCp(parseInt(h, 16)))
          .replace(/&#(\d+);/g, (_, d) => safeCp(parseInt(d, 10)))
          .replace(/&amp;/g, '&');
}
function safeCp(cp) { try { return String.fromCodePoint(cp); } catch (_e) { return ''; } }

// Alle Nachfahren mit gegebenem lokalen Namen (rekursiv, Reihenfolge = Dokument)
function findAll(node, local, out) {
  out = out || [];
  if (!node || !node.children) return out;
  for (const c of node.children) {
    if (c.local === local) out.push(c);
    findAll(c, local, out);
  }
  return out;
}
// Erster Nachfahre mit lokalem Namen
function find(node, local) {
  const a = findAll(node, local);
  return a.length ? a[0] : null;
}
// Direkte Kinder mit lokalem Namen
function children(node, local) {
  if (!node || !node.children) return [];
  return node.children.filter((c) => c.local === local);
}
function firstChild(node, local) {
  const c = children(node, local);
  return c.length ? c[0] : null;
}
// Text eines Nachfahren (erste Fundstelle) oder ''
function text(node, local) {
  if (local == null) return node ? (node.text || '').trim() : '';
  const f = find(node, local);
  return f ? (f.text || '').trim() : '';
}
// Pfad über lokale Namen, jeweils erstes Kind: byPath(root, ['A','B','C'])
function byPath(node, path) {
  let cur = node;
  for (const p of path) {
    if (!cur) return null;
    cur = firstChild(cur, p);
  }
  return cur;
}

module.exports = { parseXml, findAll, find, children, firstChild, text, byPath, localName, decodeEntities };
