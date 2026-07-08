'use strict';
// Minimaler ZIP-Writer und -Reader ohne externe Abhängigkeiten.
// Writer: für DSGVO-Datenexporte (Deflate via zlib).
// Reader: für den "Voll-Backup einspielen"-Erstumzug aus der PWA
// (unterstützt Store- und Deflate-Einträge, keine Verschlüsselung/ZIP64).

const zlib = require('zlib');

// --- CRC32 (Standard-Polynom) ---------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// --- Writer ----------------------------------------------------------------
// entries: [{ name: 'pfad/datei.txt', data: Buffer }]
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(String(e.name), 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 6 });
    // Nur komprimieren, wenn es sich lohnt
    const useDeflate = deflated.length < data.length;
    const stored = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // UTF-8 flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);            // time
    local.writeUInt16LE(0x21, 12);         // date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, nameBuf, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += 30 + nameBuf.length + stored.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

// --- Reader ----------------------------------------------------------------
// Liest über das Central Directory (robust gegen Data-Descriptors).
// Rückgabe: [{ name, data: Buffer }]
function parseZip(buf) {
  // EOCD von hinten suchen (max. 64k Kommentar)
  let eocd = -1;
  const min = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: EOCD nicht gefunden');
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const out = [];

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('zip: Central-Directory-Eintrag ungültig');
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');

    // Local-Header lesen (Name/Extra-Längen können dort abweichen)
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);

    if (!name.endsWith('/')) { // Verzeichnis-Einträge überspringen
      let data;
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = zlib.inflateRawSync(raw);
      else throw new Error('zip: Kompressionsmethode ' + method + ' nicht unterstützt');
      out.push({ name, data });
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

module.exports = { buildZip, parseZip, crc32 };
