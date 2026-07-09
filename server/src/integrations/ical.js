'use strict';
// iCal-Feed (RFC 5545): Termine/Einsätze als abonnierbaren Kalender ausliefern,
// den Google Kalender, Apple Kalender, Outlook usw. per URL einbinden. Reine Funktion.

function fold(line) {
  // RFC5545: Zeilen auf 75 Oktett begrenzen (einfache Faltung)
  if (line.length <= 74) return line;
  let out = line.slice(0, 74); let rest = line.slice(74);
  while (rest.length > 73) { out += '\r\n ' + rest.slice(0, 73); rest = rest.slice(73); }
  return out + '\r\n ' + rest;
}
function escText(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function dt(v, allDay) {
  const s = String(v || '');
  if (allDay) { const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[1] + m[2] + m[3] : ''; }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ]?(\d{2})?:?(\d{2})?/);
  if (!m) return '';
  return m[1] + m[2] + m[3] + 'T' + (m[4] || '00') + (m[5] || '00') + '00';
}
function stamp(now) {
  const dd = now instanceof Date ? now : new Date();
  const p = function (x) { return String(x).padStart(2, '0'); };
  return dd.getUTCFullYear() + p(dd.getUTCMonth() + 1) + p(dd.getUTCDate()) + 'T' + p(dd.getUTCHours()) + p(dd.getUTCMinutes()) + p(dd.getUTCSeconds()) + 'Z';
}

// events: [{ uid, start, end, summary, location, description, allDay }]
function buildICal(events, cfg) {
  const c = cfg || {};
  const now = c.now instanceof Date ? c.now : new Date();
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//werkflow//Kalender//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  if (c.name) lines.push('X-WR-CALNAME:' + escText(c.name));
  (events || []).forEach(function (e) {
    const allDay = !!e.allDay;
    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + (e.uid || ('wf-' + Math.abs(hash(JSON.stringify(e))))) + '@werkflow');
    lines.push('DTSTAMP:' + stamp(now));
    if (allDay) { lines.push('DTSTART;VALUE=DATE:' + dt(e.start, true)); if (e.end) lines.push('DTEND;VALUE=DATE:' + dt(e.end, true)); }
    else { lines.push('DTSTART:' + dt(e.start)); if (e.end) lines.push('DTEND:' + dt(e.end)); }
    lines.push('SUMMARY:' + escText(e.summary || 'Termin'));
    if (e.location) lines.push('LOCATION:' + escText(e.location));
    if (e.description) lines.push('DESCRIPTION:' + escText(e.description));
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return h; }

module.exports = { buildICal };
