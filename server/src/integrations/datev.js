'use strict';
// DATEV-Export: EXTF-Buchungsstapel (Format-Kategorie 21) für den Steuerberater.
// Erzeugt eine DATEV-importierbare CSV mit korrektem Kopf-Datensatz und der
// Standard-Spaltenüberschrift. Kontenrahmen (SKR03/04) + Sachkonten werden vom
// Mandanten konfiguriert und vom Steuerberater bestätigt. Reine Funktion.

// Offizielle Spaltenüberschriften „Buchungsstapel" (Formatversion 13).
const FIELDS = [
  'Umsatz (ohne Soll/Haben-Kz)', 'Soll/Haben-Kennzeichen', 'WKZ Umsatz', 'Kurs', 'Basis-Umsatz', 'WKZ Basis-Umsatz',
  'Konto', 'Gegenkonto (ohne BU-Schlüssel)', 'BU-Schlüssel', 'Belegdatum', 'Belegfeld 1', 'Belegfeld 2',
  'Skonto', 'Buchungstext', 'Postensperre', 'Diverse Adressnummer', 'Geschäftspartnerbank', 'Sachverhalt',
  'Zinssperre', 'Beleglink',
  'Beleginfo - Art 1', 'Beleginfo - Inhalt 1', 'Beleginfo - Art 2', 'Beleginfo - Inhalt 2',
  'Beleginfo - Art 3', 'Beleginfo - Inhalt 3', 'Beleginfo - Art 4', 'Beleginfo - Inhalt 4',
  'Beleginfo - Art 5', 'Beleginfo - Inhalt 5', 'Beleginfo - Art 6', 'Beleginfo - Inhalt 6',
  'Beleginfo - Art 7', 'Beleginfo - Inhalt 7', 'Beleginfo - Art 8', 'Beleginfo - Inhalt 8',
  'KOST1 - Kostenstelle', 'KOST2 - Kostenstelle', 'KOST-Menge', 'EU-Land u. UStID (Bestimmung)',
  'EU-Steuersatz (Bestimmung)', 'Abw. Versteuerungsart', 'Sachverhalt L+L', 'Funktionsergänzung L+L',
  'BU 49 Hauptfunktionstyp', 'BU 49 Hauptfunktionsnummer', 'BU 49 Funktionsergänzung',
  'Zusatzinformation - Art 1', 'Zusatzinformation- Inhalt 1', 'Zusatzinformation - Art 2', 'Zusatzinformation- Inhalt 2',
  'Zusatzinformation - Art 3', 'Zusatzinformation- Inhalt 3', 'Zusatzinformation - Art 4', 'Zusatzinformation- Inhalt 4',
  'Zusatzinformation - Art 5', 'Zusatzinformation- Inhalt 5', 'Zusatzinformation - Art 6', 'Zusatzinformation- Inhalt 6',
  'Zusatzinformation - Art 7', 'Zusatzinformation- Inhalt 7', 'Zusatzinformation - Art 8', 'Zusatzinformation- Inhalt 8',
  'Zusatzinformation - Art 9', 'Zusatzinformation- Inhalt 9', 'Zusatzinformation - Art 10', 'Zusatzinformation- Inhalt 10',
  'Zusatzinformation - Art 11', 'Zusatzinformation- Inhalt 11', 'Zusatzinformation - Art 12', 'Zusatzinformation- Inhalt 12',
  'Zusatzinformation - Art 13', 'Zusatzinformation- Inhalt 13', 'Zusatzinformation - Art 14', 'Zusatzinformation- Inhalt 14',
  'Zusatzinformation - Art 15', 'Zusatzinformation- Inhalt 15', 'Zusatzinformation - Art 16', 'Zusatzinformation- Inhalt 16',
  'Zusatzinformation - Art 17', 'Zusatzinformation- Inhalt 17', 'Zusatzinformation - Art 18', 'Zusatzinformation- Inhalt 18',
  'Zusatzinformation - Art 19', 'Zusatzinformation- Inhalt 19', 'Zusatzinformation - Art 20', 'Zusatzinformation- Inhalt 20',
  'Stück', 'Gewicht', 'Zahlweise', 'Forderungsart', 'Veranlagungsjahr', 'Zugeordnete Fälligkeit', 'Skontotyp',
  'Auftragsnummer', 'Buchungstyp', 'USt-Schlüssel (Anzahlungen)', 'EU-Land (Anzahlungen)',
  'Sachverhalt L+L (Anzahlungen)', 'EU-Steuersatz (Anzahlungen)', 'Erlöskonto (Anzahlungen)', 'Herkunft-Kz',
  'Buchungs GUID', 'KOST-Datum', 'SEPA-Mandatsreferenz', 'Skontosperre', 'Gesellschaftername', 'Beteiligtennummer',
  'Identifikationsnummer', 'Zeichnernummer', 'Postensperre bis', 'Bezeichnung SoBil-Sachverhalt',
  'Kennzeichen SoBil-Buchung', 'Festschreibung', 'Leistungsdatum', 'Datum Zuord. Steuerperiode', 'Fälligkeit',
  'Generalumkehr (GU)', 'Steuersatz', 'Land', 'Abrechnungsreferenz', 'BVV-Position',
  'EU-Land u. UStID (Ursprung)', 'EU-Steuersatz (Ursprung)', 'Abw. Skontokonto',
];
const COLS = FIELDS.length;

function q(s) { return '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"'; }
function amount2(n) { return (Math.round(Math.abs(Number(n) || 0) * 100) / 100).toFixed(2).replace('.', ','); }
function ddmm(iso) { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + m[2] : ''; }
function yyyymmdd(iso) { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[1] + m[2] + m[3] : ''; }
function clip(s, n) { return String(s == null ? '' : s).replace(/[\r\n;]/g, ' ').slice(0, n); }

function stamp17(d) {
  const p = (x, n) => String(x).padStart(n || 2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + p(d.getMilliseconds(), 3);
}

// bookings: [{ umsatz, sollHaben:'S'|'H', konto, gegenkonto, buSchluessel, belegdatum(ISO),
//              belegfeld1, buchungstext, skonto?, faelligkeit?(ISO), leistungsdatum?(ISO), kost1? }]
// meta: { beraterNr, mandantNr, wjBeginn(ISO), datumVon(ISO), datumBis(ISO), bezeichnung,
//         sachkontenLen=4, festschreibung=true, now=Date }
function buildBuchungsstapel(bookings, meta) {
  const m = meta || {};
  const now = m.now instanceof Date ? m.now : new Date();
  const wj = yyyymmdd(m.wjBeginn) || (now.getFullYear() + '0101');
  const von = yyyymmdd(m.datumVon) || wj;
  const bis = yyyymmdd(m.datumBis) || (now.getFullYear() + '1231');
  // Kopf-Datensatz (Header 1)
  const header = [
    q('EXTF'), 700, 21, q('Buchungsstapel'), 13, stamp17(now), '', q(''), q(''), q(''),
    m.beraterNr || '', m.mandantNr || '', wj, m.sachkontenLen || 4, von, bis,
    q(clip(m.bezeichnung || 'werkflow Buchungsstapel', 30)), q(clip(m.diktatkuerzel || '', 2)), 1, 0,
    m.festschreibung === false ? 0 : 1, q('EUR'), '', '', '', '', '', q(''), q(''), q(''), '',
  ].join(';');
  const columnRow = FIELDS.map(q).join(';');

  const rows = (bookings || []).map((b) => {
    const row = new Array(COLS).fill('');
    row[0] = amount2(b.umsatz);
    row[1] = (b.sollHaben === 'H' ? 'H' : 'S');
    row[2] = 'EUR';
    row[6] = String(b.konto == null ? '' : b.konto);
    row[7] = String(b.gegenkonto == null ? '' : b.gegenkonto);
    row[8] = b.buSchluessel == null ? '' : String(b.buSchluessel);
    row[9] = ddmm(b.belegdatum);
    row[10] = q(clip(b.belegfeld1, 36));
    row[12] = b.skonto ? amount2(b.skonto) : '';
    row[13] = q(clip(b.buchungstext, 60));
    if (b.kost1) row[36] = q(clip(b.kost1, 36));
    row[114] = m.festschreibung === false ? 0 : 1; // Festschreibung
    if (b.leistungsdatum) row[115] = ddmm(b.leistungsdatum);
    if (b.faelligkeit) row[117] = ddmm(b.faelligkeit);
    // Textspalten, die leer aber als Text markiert bleiben sollen, sind ok als ''
    return row.join(';');
  });

  // DATEV erwartet Windows-Zeilenenden
  return [header, columnRow].concat(rows).join('\r\n') + '\r\n';
}

// Bequeme Zuordnung: Aus-/Eingangsrechnungen → Buchungssätze mit SKR-Defaults.
// cfg: { skr:'03'|'04', erloese, wareneingang, debitorFrom, kreditorFrom }
function invoicesToBookings(items, cfg) {
  const c = cfg || {};
  const skr = c.skr === '04' ? '04' : '03';
  // Sinnvolle Standard-Sachkonten (vom Steuerberater zu bestätigen)
  const erloese = c.erloese || (skr === '04' ? '4400' : '8400');   // Erlöse 19 % USt
  const wareneingang = c.wareneingang || (skr === '04' ? '5400' : '3400'); // Wareneingang 19 % VSt
  const buUmsatz = '9'; // BU-Schlüssel Automatik 19 %
  const bookings = [];
  for (const it of items) {
    if (it.kind === 'outgoing') {
      // Debitor an Erlöse (Automatikkonto rechnet USt heraus)
      bookings.push({
        umsatz: it.gross, sollHaben: 'S',
        konto: it.debitor || (Number(c.debitorFrom || 10000) + (it.debitorSeq || 0)),
        gegenkonto: erloese, buSchluessel: buUmsatz,
        belegdatum: it.date, belegfeld1: it.number, buchungstext: 'Ausgangsrechnung ' + (it.party || ''),
        faelligkeit: it.dueDate, leistungsdatum: it.serviceDate,
      });
    } else {
      // Wareneingang an Kreditor
      bookings.push({
        umsatz: it.gross, sollHaben: 'S',
        konto: wareneingang,
        gegenkonto: it.kreditor || (Number(c.kreditorFrom || 70000) + (it.kreditorSeq || 0)),
        buSchluessel: buUmsatz,
        belegdatum: it.date, belegfeld1: it.number, buchungstext: 'Eingangsrechnung ' + (it.party || ''),
        faelligkeit: it.dueDate,
      });
    }
  }
  return bookings;
}

module.exports = { buildBuchungsstapel, invoicesToBookings, FIELDS, COLS };
