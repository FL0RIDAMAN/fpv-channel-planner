// Coordinate parsing and formatting: MGRS / UTM / lat-long (WGS84).
// UTM uses Snyder's transverse Mercator series (mm-level within a zone).
// MGRS covers 80°S–84°N (polar UPS areas are not supported).

const A = 6378137, F = 1 / 298.257223563, K0 = 0.9996;
const E2 = F * (2 - F), EP2 = E2 / (1 - E2);
const R2D = 180 / Math.PI, D2R = Math.PI / 180;
const BANDS = 'CDEFGHJKLMNPQRSTUVWX';
const COLS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
const ROWS = 'ABCDEFGHJKLMNPQRSTUV';

export function utmZone(lat, lon) {
  if (lon >= 180) lon -= 360;
  let z = Math.floor((lon + 180) / 6) + 1;
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) z = 32;
  if (lat >= 72 && lat < 84) {
    if (lon >= 0 && lon < 9) z = 31; else if (lon >= 9 && lon < 21) z = 33;
    else if (lon >= 21 && lon < 33) z = 35; else if (lon >= 33 && lon < 42) z = 37;
  }
  return z;
}

function meridianArc(phi) {
  const e4 = E2 * E2, e6 = e4 * E2;
  return A * ((1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi - (3 * E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi) - (35 * e6 / 3072) * Math.sin(6 * phi));
}

export function toUtm(lat, lon, zone = utmZone(lat, lon)) {
  const phi = lat * D2R, lam0 = ((zone - 1) * 6 - 180 + 3) * D2R;
  let dl = lon * D2R - lam0;
  if (dl > Math.PI) dl -= 2 * Math.PI; if (dl < -Math.PI) dl += 2 * Math.PI;
  const s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi);
  const N = A / Math.sqrt(1 - E2 * s * s), T = t * t, C = EP2 * c * c, Aa = c * dl;
  const M = meridianArc(phi);
  const x = K0 * N * (Aa + (1 - T + C) * Aa ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5 / 120) + 500000;
  let y = K0 * (M + N * t * (Aa * Aa / 2 + (5 - T + 9 * C + 4 * C * C) * Aa ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6 / 720));
  if (lat < 0) y += 1e7;
  return { zone, south: lat < 0, easting: x, northing: y };
}

export function fromUtm(zone, south, easting, northing) {
  const x = easting - 500000, y = south ? northing - 1e7 : northing;
  const e4 = E2 * E2, e6 = e4 * E2;
  const mu = (y / K0) / (A * (1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const s = Math.sin(p1), c = Math.cos(p1), t = Math.tan(p1);
  const N1 = A / Math.sqrt(1 - E2 * s * s), T1 = t * t, C1 = EP2 * c * c;
  const R1 = A * (1 - E2) / (1 - E2 * s * s) ** 1.5, D = x / (N1 * K0);
  const phi = p1 - (N1 * t / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6 / 720);
  const lam = (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5 / 120) / c;
  let lon = (zone - 1) * 6 - 180 + 3 + lam * R2D;
  if (lon > 180) lon -= 360; if (lon < -180) lon += 360;
  return { lat: phi * R2D, lon };
}

const bandOf = lat => lat >= 72 ? 'X' : BANDS[Math.floor((lat + 80) / 8)];

// digits per coordinate: 5 = 1 m, 4 = 10 m, 3 = 100 m ...
export function toMgrs(lat, lon, digits = 5, spaced = true) {
  if (!(lat >= -80 && lat <= 84) || !Number.isFinite(lon)) return null;
  const u = toUtm(lat, lon);
  const col = COLS[(u.zone - 1) % 3][Math.floor(u.easting / 1e5) - 1];
  let r = Math.floor(u.northing / 1e5) % 20;
  if (u.zone % 2 === 0) r = (r + 5) % 20;
  const div = 10 ** (5 - digits);
  const e = String(Math.floor((u.easting % 1e5) / div)).padStart(digits, '0');
  const n = String(Math.floor((u.northing % 1e5) / div)).padStart(digits, '0');
  const parts = [`${u.zone}${bandOf(lat)}`, `${col}${ROWS[r]}`, ...(digits ? [e, n] : [])];
  return spaced ? parts.join(' ') : parts.join('');
}

const MGRS_RE = /^(\d{1,2})\s*([A-Z])\s*([A-Z])\s*([A-Z])\s*(\d*)\s*(\d*)$/i;
export const looksLikeMgrs = s => MGRS_RE.test(String(s).trim());

// Returns {lat, lon, precisionM} for the centre of the grid square.
export function fromMgrs(str) {
  const m = String(str).trim().toUpperCase().match(MGRS_RE);
  if (!m) throw new Error('Not an MGRS grid (expected e.g. 11S KC 44662 45837).');
  const zone = +m[1], band = m[2], col = m[3], row = m[4];
  if (!BANDS.includes(band)) throw new Error(`Latitude band ${band} is invalid (C–X, no I or O; A/B/Y/Z are polar and not supported).`);
  if (!ROWS.includes(row)) throw new Error(`Row letter ${row} is invalid (A–V, no I or O).`);
  const digits = m[6] ? m[5] + m[6] : m[5];
  if (zone < 1 || zone > 60) throw new Error(`Grid zone ${zone} is invalid (1–60).`);
  if (digits.length % 2) throw new Error('MGRS easting and northing need the same number of digits.');
  const p = digits.length / 2;
  if (p > 5) throw new Error('MGRS supports at most 5 + 5 digits (1 m).');
  const ci = COLS[(zone - 1) % 3].indexOf(col);
  if (ci < 0) throw new Error(`Column letter ${col} isn't used in zone ${zone}.`);
  let ri = ROWS.indexOf(row);
  if (zone % 2 === 0) ri = (ri - 5 + 20) % 20;
  const size = 10 ** (5 - p);
  const e = (ci + 1) * 1e5 + (p ? +digits.slice(0, p) * size : 0) + size / 2;
  let n = ri * 1e5 + (p ? +digits.slice(p) * size : 0) + size / 2;
  const south = band < 'N';
  const bandBottom = band === 'C' ? -80 : -80 + BANDS.indexOf(band) * 8;
  const minN = toUtm(bandBottom, (zone - 1) * 6 - 180 + 3, zone).northing;
  while (n < minN - 1e5) n += 2e6;
  const ll = fromUtm(zone, south, e, n);
  if (bandOf(ll.lat) !== band && Math.abs(ll.lat - bandBottom) > 0.5 && Math.abs(ll.lat - (bandBottom + 8)) > 0.5) {
    throw new Error(`${str} doesn't fall in latitude band ${band} — check the letters.`);
  }
  return { ...ll, precisionM: size };
}

// Lat/long in decimal, degrees-minutes or degrees-minutes-seconds, with signs or N/S/E/W.
function parseOne(part) {
  const hemi = (part.match(/[NSEW]/) || [])[0] || null;
  const neg = /-/.test(part);
  const nums = (part.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (!nums.length || nums.length > 3) return null;
  const [d, mi = 0, se = 0] = nums;
  if (mi >= 60 || se >= 60) return null;
  let v = d + mi / 60 + se / 3600;
  if (neg || hemi === 'S' || hemi === 'W') v = -v;
  return { v, hemi };
}

export function parseLatLon(str) {
  let s = String(str).trim().toUpperCase().replace(/[°º˚'′’"″”]/g, ' ').replace(/\s+/g, ' ');
  if (!s) throw new Error('Enter a coordinate.');
  let parts;
  if (s.includes(',')) parts = s.split(',');
  else if (/[NS]/.test(s) && /[EW]/.test(s)) {
    // "38 21 N 119 31 W"  or  "N38 21 W119 31"
    const m = s.match(/^([NS][^EW]*?)\s*([EW].*)$/) || s.match(/^([EW][^NS]*?)\s*([NS].*)$/)
      || s.match(/^([^NSEW]*?[NS])\s*(.*[EW])$/) || s.match(/^([^NSEW]*?[EW])\s*(.*[NS])$/);
    parts = m ? [m[1], m[2]] : null;
  } else {
    const nums = s.match(/-?\d+(?:\.\d+)?/g) || [];
    if ([2, 4, 6].includes(nums.length)) { const k = nums.length / 2; parts = [nums.slice(0, k).join(' '), nums.slice(k).join(' ')]; }
  }
  if (!parts || parts.length !== 2) throw new Error('Couldn\'t read that as lat, long (e.g. 38.356, -119.520 or 38°21\'22"N 119°31\'12"W).');
  let a = parseOne(parts[0]), b = parseOne(parts[1]);
  if (!a || !b) throw new Error('Couldn\'t read the numbers — check degrees/minutes/seconds.');
  if ((a.hemi === 'E' || a.hemi === 'W') && (!b.hemi || b.hemi === 'N' || b.hemi === 'S')) [a, b] = [b, a];
  const lat = a.v, lon = b.v;
  if (Math.abs(lat) > 90) throw new Error(`Latitude ${lat.toFixed(4)} is out of range — is the order lat, long?`);
  if (Math.abs(lon) > 180) throw new Error(`Longitude ${lon.toFixed(4)} is out of range.`);
  return { lat, lon, precisionM: null };
}

// Accepts MGRS or lat/long. Returns {lat, lon, kind, precisionM}.
export function parseCoord(str) {
  const s = String(str).trim();
  if (looksLikeMgrs(s)) return { ...fromMgrs(s), kind: 'MGRS' };
  return { ...parseLatLon(s), kind: 'lat/long' };
}

export const fmtLatLon = (lat, lon) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
export const fmtBoth = (lat, lon) => `${toMgrs(lat, lon) ?? '—'}  ·  ${fmtLatLon(lat, lon)}`;
