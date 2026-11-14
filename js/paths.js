// Flight path geometry: team route + per-aircraft target, moving pilots, sampling.
import { distM, dest, bearing, lerp } from './geo.js';

const pt = (p, alt) => ({ lat: p.lat, lon: p.lon, alt });

export const POINT_TYPES = [
  ['wp', 'Waypoint'], ['launch', 'Launch (takeoff)'], ['loiter', 'Loiter / hold'], ['land', 'Land'],
];
export const pointTypeName = t => (POINT_TYPES.find(x => x[0] === t) || POINT_TYPES[0])[1];

// Route problems worth telling the user about.
export function routeIssues(team) {
  const r = (team.route || []).filter(w => w.lat != null), out = [];
  r.forEach((w, i) => {
    if (w.type === 'launch' && i > 0) out.push(`Point ${i + 1} is a launch point but isn't first — it's treated as a waypoint.`);
    if (w.type === 'land' && i < r.length - 1) out.push(`Point ${i + 1} is a land point — the ${r.length - 1 - i} point(s) after it are ignored.`);
  });
  if (r.some(w => w.type === 'land') && team.rtl === true) out.push('The route ends with a landing, so "Return to launch" is ignored.');
  return out;
}

// Ordered 3-D path for an aircraft (alt = metres AGL), or null if it only has the team circle.
// Route points can be typed: an optional first "launch" point (takeoff away from the pilots),
// waypoints, loiter/hold points, and a "land" point that ends the route.
// The aircraft's own target is flown after the route (before a landing, if there is one).
export function flightPath(team, drone) {
  if (team.lat == null) return null;
  let route = (team.route || []).filter(w => w.lat != null);
  const tgt = drone?.target?.lat != null ? drone.target : null;
  if (!route.length && !tgt) return null;
  const launch = route[0]?.type === 'launch' ? route[0] : null;
  if (launch) route = route.slice(1);
  const landIdx = route.findIndex(w => w.type === 'land');
  const land = landIdx >= 0 ? route[landIdx] : null;
  if (land) route = route.slice(0, landIdx);
  const start = launch || team;
  const firstAlt = route[0]?.altM ?? tgt?.altM ?? team.altM;
  const pts = [{ ...pt(start, firstAlt), kind: 'launch', ref: launch }];
  const loiters = [];
  route.forEach((w, i) => {
    const kind = w.type === 'loiter' ? 'loiter' : 'wp';
    const p = { ...pt(w, w.altM ?? team.altM), kind, n: i + 1 + (launch ? 1 : 0), ref: w };
    pts.push(p);
    if (kind === 'loiter' && (w.loiterM ?? 0) > 0) loiters.push({ lat: w.lat, lon: w.lon, alt: p.alt, radius: w.loiterM, idx: pts.length - 1 });
  });
  let targetIdx = -1;
  if (tgt) {
    targetIdx = pts.length;
    pts.push({ ...pt(tgt, tgt.altM ?? team.altM), kind: 'target' });
    if ((tgt.loiterM ?? 0) > 0) loiters.push({ lat: tgt.lat, lon: tgt.lon, alt: tgt.altM ?? team.altM, radius: tgt.loiterM, idx: targetIdx });
  }
  if (land) pts.push({ ...pt(land, pts[pts.length - 1].alt), kind: 'land', ref: land });
  else if (team.rtl === true) pts.push({ ...pt(start, pts[pts.length - 1].alt), kind: 'rtl' });
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distM(pts[i - 1], pts[i]));
  return { pts, cum, length: cum[cum.length - 1], targetIdx, loiterM: tgt ? (tgt.loiterM ?? 0) : 0, target: tgt, loiters, start };
}

// Position at fraction f (0..1) of the path length.
export function pointAt(path, f) {
  const { pts, cum, length } = path;
  if (pts.length === 1 || length === 0) return { ...pts[0], hdg: 0 };
  const d = Math.min(Math.max(f, 0), 1) * length;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const seg = cum[i] - cum[i - 1] || 1, t = (d - cum[i - 1]) / seg;
  const a = pts[i - 1], b = pts[i];
  return { ...lerp(a, b, t), alt: a.alt + (b.alt - a.alt) * t, hdg: bearing(a, b) };
}

// Pilots start at the launch point and move along the pilot track in step with the aircraft.
export function pilotPath(team) {
  const track = (team.pilotTrack || []).filter(p => p.lat != null);
  const pts = [pt(team, 0), ...track.map(p => pt(p, 0))];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distM(pts[i - 1], pts[i]));
  return { pts, cum, length: cum[cum.length - 1] };
}
export const pilotAt = (team, f, pp = pilotPath(team)) => pp.pts.length === 1 ? pp.pts[0] : pointAt(pp, f);

// Pilots finish moving when the aircraft reaches the far end of its route (before any return leg).
export function pilotFraction(path, f) {
  const last = path.pts[path.pts.length - 1];
  const outbound = last.kind === 'rtl' ? path.cum[path.cum.length - 2] : path.length;
  return outbound > 0 ? Math.min(1, (f * path.length) / outbound) : 1;
}

// Where pilots can be: launch, every track point, and mid-points (capped).
export function pilotSamples(team) {
  const pp = pilotPath(team);
  if (pp.pts.length === 1) return pp.pts;
  const n = Math.min(10, pp.pts.length * 2);
  return Array.from({ length: n + 1 }, (_, k) => pointAt(pp, k / n));
}

// Points the aircraft may occupy: along the path, either side of it (corridor), and around the loiter circle.
export function flightSamples(path, corridorM = 150, n = 16) {
  const out = [];
  for (let k = 0; k <= n; k++) {
    const p = pointAt(path, k / n);
    out.push(p);
    if (corridorM > 0) for (const s of [-90, 90]) out.push({ ...dest(p, p.hdg + s, corridorM), alt: p.alt });
  }
  for (const p of path.pts) if (p.kind !== 'launch' && p.kind !== 'rtl') out.push(p);
  for (const l of path.loiters || []) for (let k = 0; k < 8; k++) out.push({ ...dest(l, k * 45, l.radius), alt: l.alt });
  return out;
}

// Aircraft and pilot positions in step, for the own-link check.
export function syncedPairs(team, path, n = 80) {
  const pp = pilotPath(team);
  const out = [];
  for (let k = 0; k <= n; k++) {
    const f = k / n;
    out.push({ f, along: f * path.length, drone: pointAt(path, f), pilot: pilotAt(team, pilotFraction(path, f), pp) });
  }
  for (const l of path.loiters || []) {
    const f = path.cum[l.idx] / (path.length || 1), pilot = pilotAt(team, pilotFraction(path, f), pp);
    for (let k = 0; k < 8; k++) out.push({ f, along: path.cum[l.idx], loiter: true, drone: { ...dest(l, k * 45, l.radius), alt: l.alt }, pilot });
  }
  return out;
}

export const pathKey = pts => pts.map(p => `${p.lat.toFixed(5)},${p.lon.toFixed(5)},${Math.round(p.alt ?? 0)}`).join(';');
