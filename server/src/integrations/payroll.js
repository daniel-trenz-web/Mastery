'use strict';
// Lohn-Export: Stundenzettel → Lohnbuchhaltung. Generisches CSV (für Lexware Lohn,
// Addison, Sage u. a.) sowie ein DATEV-Lohn-Bewegungsdaten-CSV. Reine Funktion.

function cell(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/[\r\n;]/g, ' ') + '"'; }
function h2(v) { return (Math.round((Number(v) || 0) * 100) / 100).toFixed(2).replace('.', ','); }

// entries: [{ personalNr, name, period, hours, overtime, absenceDays, hourlyRate }]
function buildPayrollCsv(entries, cfg) {
  const c = cfg || {};
  const cols = ['Personalnummer', 'Name', 'Abrechnungszeitraum', 'Stunden', 'Überstunden', 'Abwesenheitstage', 'Stundensatz', 'Bruttolohn'];
  const head = cols.map(cell).join(';');
  const rows = (entries || []).map(function (e) {
    const hours = Number(e.hours) || 0, rate = Number(e.hourlyRate) || 0;
    const gross = Math.round((hours + (Number(e.overtime) || 0)) * rate * 100) / 100;
    return [e.personalNr || '', e.name || '', e.period || c.period || '', h2(hours), h2(e.overtime || 0), e.absenceDays || 0, h2(rate), h2(gross)].map(cell).join(';');
  }).join('\r\n');
  return head + '\r\n' + rows + '\r\n';
}

// DATEV-Lohn (Lohn & Gehalt / LODAS) Bewegungsdaten – Lohnart je Zeile.
// entries: [{ personalNr, lohnart, wert, period }] ; lohnart z. B. 200 (Stunden), 210 (Überstd.)
function buildDatevLohn(entries, meta) {
  const m = meta || {};
  const cols = ['Beraternummer', 'Mandantennummer', 'Personalnummer', 'Lohnart', 'Wert', 'Abrechnungsmonat'];
  const head = cols.map(cell).join(';');
  const rows = (entries || []).map(function (e) {
    return [m.beraterNr || '', m.mandantNr || '', e.personalNr || '', e.lohnart || '200', h2(e.wert != null ? e.wert : e.hours), e.period || m.period || ''].map(cell).join(';');
  }).join('\r\n');
  return '[Allgemein]\r\nZiel=LODAS\r\nVersion=1.0\r\n[Bewegungsdaten]\r\n' + head + '\r\n' + rows + '\r\n';
}

// Bequemer Aufbau aus Mitarbeiter- + Stundenlisten der App.
function fromTimesheets(employees, timesheets, period) {
  const byEmp = {};
  (timesheets || []).forEach(function (t) {
    if (period && t.period && t.period !== period) return;
    const id = t.employeeId || t.empId;
    byEmp[id] = (byEmp[id] || 0) + (Number(t.hours) || 0);
  });
  return (employees || []).map(function (emp) {
    return { personalNr: emp.personalNr || emp.id, name: emp.name || '', period: period || '', hours: Math.round((byEmp[emp.id] || 0) * 100) / 100, overtime: 0, absenceDays: 0, hourlyRate: emp.hourlyRate || emp.tagessatz && (emp.tagessatz / 8) || 0 };
  }).filter(function (e) { return e.hours > 0; });
}

module.exports = { buildPayrollCsv, buildDatevLohn, fromTimesheets };
