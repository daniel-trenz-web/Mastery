'use strict';
// Wetter-Connector für das Bautagebuch: holt für Ort + Datum die Tageswerte.
// Nutzt open-meteo (kostenlos, ohne API-Key). Nur die Code→Text-Zuordnung ist
// rein/testbar; der Abruf braucht Netzwerk.

const WMO = {
  0: 'klar', 1: 'überwiegend klar', 2: 'teils bewölkt', 3: 'bedeckt',
  45: 'Nebel', 48: 'Reifnebel', 51: 'leichter Nieselregen', 53: 'Nieselregen', 55: 'starker Nieselregen',
  61: 'leichter Regen', 63: 'Regen', 65: 'starker Regen', 66: 'gefrierender Regen', 67: 'starker gefrierender Regen',
  71: 'leichter Schneefall', 73: 'Schneefall', 75: 'starker Schneefall', 77: 'Schneegriesel',
  80: 'leichte Regenschauer', 81: 'Regenschauer', 82: 'heftige Regenschauer',
  85: 'Schneeschauer', 86: 'starke Schneeschauer', 95: 'Gewitter', 96: 'Gewitter mit Hagel', 99: 'schweres Gewitter mit Hagel',
};
function weatherText(code) { return WMO[code] != null ? WMO[code] : 'unbekannt'; }

// Wetter-Zusammenfassung fürs Bautagebuch aus einer open-meteo-Antwort bauen (rein).
function summarizeDaily(json, date) {
  const daily = json && json.daily;
  if (!daily || !daily.time) return null;
  const idx = date ? daily.time.indexOf(date) : 0;
  const i = idx >= 0 ? idx : 0;
  const code = daily.weathercode ? daily.weathercode[i] : null;
  return {
    date: daily.time[i],
    tempMax: pick(daily.temperature_2m_max, i),
    tempMin: pick(daily.temperature_2m_min, i),
    precip: pick(daily.precipitation_sum, i),
    windMax: pick(daily.windspeed_10m_max, i),
    code: code,
    text: weatherText(code),
    summary: buildSummary(daily, i, code),
  };
}
function pick(arr, i) { return arr && arr[i] != null ? arr[i] : null; }
function buildSummary(daily, i, code) {
  const tmax = pick(daily.temperature_2m_max, i), tmin = pick(daily.temperature_2m_min, i), rain = pick(daily.precipitation_sum, i);
  const parts = [weatherText(code)];
  if (tmin != null && tmax != null) parts.push(Math.round(tmin) + '–' + Math.round(tmax) + ' °C');
  if (rain != null) parts.push('Niederschlag ' + rain + ' mm');
  return parts.join(', ');
}

async function geocode(place) {
  const url = 'https://geocoding-api.open-meteo.com/v1/search?count=1&language=de&name=' + encodeURIComponent(place);
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  const hit = j.results && j.results[0];
  return hit ? { lat: hit.latitude, lon: hit.longitude, name: hit.name } : null;
}

// Live-Abruf: Ort (Name oder {lat,lon}) + Datum (YYYY-MM-DD) → Tageswetter.
async function fetchWeather(place, date) {
  try {
    let loc = place;
    if (typeof place === 'string') { loc = await geocode(place); if (!loc) return { ok: false, error: 'ort-nicht-gefunden' }; }
    const today = new Date().toISOString().slice(0, 10);
    const past = date && date < today;
    const base = past ? 'https://archive-api.open-meteo.com/v1/archive' : 'https://api.open-meteo.com/v1/forecast';
    const params = 'latitude=' + loc.lat + '&longitude=' + loc.lon +
      '&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max&timezone=Europe%2FBerlin' +
      (date ? '&start_date=' + date + '&end_date=' + date : '');
    const r = await fetch(base + '?' + params);
    if (!r.ok) return { ok: false, error: 'api-http-' + r.status };
    const j = await r.json();
    const s = summarizeDaily(j, date);
    if (!s) return { ok: false, error: 'keine-daten' };
    return Object.assign({ ok: true, place: loc.name || '' }, s);
  } catch (e) {
    return { ok: false, error: 'network', message: String(e && e.message || e) };
  }
}

module.exports = { fetchWeather, summarizeDaily, weatherText };
