// Mission files (ArduPilot .waypoints, QGroundControl .plan, INAV .mission) and KML for ATAK.
import { elevationAt } from './terrain.js';
import { flightPath } from './paths.js';
import { toMgrs } from './coords.js';
import { chanName } from './vtxtable.js';

const f7 = x => x.toFixed(7), r1 = x => Math.round(x * 10) / 10, n7 = x => Number(x.toFixed(7));
const xmlEsc = s => String(s ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

// Mission items in a neutral form. Altitudes: AGL from the plan, converted to "relative to home"
// using the terrain model so the aircraft keeps the planned height above the ground at each waypoint.
export function missionItems(team, drone) {
  const path = flightPath(team, drone);
  if (!path) return null;
  const homeElev = elevationAt(team.lat, team.lon);
  let terrainOk = homeElev != null;
  const rel = p => {
    const e = elevationAt(p.lat, p.lon);
    if (e == null || homeElev == null) { terrainOk = false; return r1(p.alt); }
    return r1(e + p.alt - homeElev);
  };
  const items = [{ type: 'takeoff', alt: rel({ ...team, alt: path.pts[1]?.alt ?? team.altM }) }];
  for (const p of path.pts.slice(1)) {
    if (p.kind === 'wp') items.push({ type: 'waypoint', lat: p.lat, lon: p.lon, alt: rel(p), name: `WP${p.n}` });
    else if (p.kind === 'target') {
      const t = drone.target;
      if ((t.loiterMin ?? 0) > 0) items.push({ type: 'loiter', lat: p.lat, lon: p.lon, alt: rel(p), seconds: Math.round(t.loiterMin * 60), radius: t.loiterM ?? 0, name: 'Target' });
      else items.push({ type: 'waypoint', lat: p.lat, lon: p.lon, alt: rel(p), name: 'Target' });
    } else if (p.kind === 'rtl') items.push({ type: 'rtl' });
  }
  return { items, home: { lat: team.lat, lon: team.lon, amsl: homeElev ?? 0 }, terrainOk };
}

// ArduPilot / Mission Planner "QGC WPL 110" (tab-separated; row 0 is home, absolute altitude).
export function toWaypointsFile(m) {
  const rows = ['QGC WPL 110'];
  const row = (cmd, frame, p, lat, lon, alt, cur = 0) => rows.push([rows.length - 1, cur, frame, cmd, ...p, f7(lat), f7(lon), alt, 1].join('\t'));
  row(16, 0, [0, 0, 0, 0], m.home.lat, m.home.lon, r1(m.home.amsl), 1);
  for (const it of m.items) {
    if (it.type === 'takeoff') row(22, 3, [0, 0, 0, 0], 0, 0, it.alt);
    else if (it.type === 'waypoint') row(16, 3, [0, 0, 0, 0], it.lat, it.lon, it.alt);
    else if (it.type === 'loiter') row(19, 3, [it.seconds, 0, it.radius, 0], it.lat, it.lon, it.alt);
    else if (it.type === 'rtl') row(20, 3, [0, 0, 0, 0], 0, 0, 0);
  }
  return rows.join('\n') + '\n';
}

// QGroundControl .plan (JSON). firmwareType 3 = ArduPilot, vehicleType 2 = quadrotor.
export function toQgcPlan(m) {
  let id = 1;
  const item = (command, params, alt) => ({ AMSLAltAboveTerrain: null, Altitude: alt, AltitudeMode: 1, autoContinue: true, command, doJumpId: id++, frame: 3, params, type: 'SimpleItem' });
  const items = m.items.map(it => {
    if (it.type === 'takeoff') return item(22, [0, 0, 0, null, n7(m.home.lat), n7(m.home.lon), it.alt], it.alt);
    if (it.type === 'waypoint') return item(16, [0, 0, 0, null, n7(it.lat), n7(it.lon), it.alt], it.alt);
    if (it.type === 'loiter') return item(19, [it.seconds, 0, it.radius, null, n7(it.lat), n7(it.lon), it.alt], it.alt);
    return item(20, [0, 0, 0, 0, 0, 0, 0], 0);
  });
  return JSON.stringify({
    fileType: 'Plan', groundStation: 'QGroundControl', version: 1,
    geoFence: { circles: [], polygons: [], version: 2 }, rallyPoints: { points: [], version: 2 },
    mission: { cruiseSpeed: 15, firmwareType: 3, globalPlanAltitudeMode: 1, hoverSpeed: 5, items, plannedHomePosition: [n7(m.home.lat), n7(m.home.lon), r1(m.home.amsl)], vehicleType: 2, version: 2 },
  }, null, 2);
}

// INAV Configurator mission XML. Altitude in metres relative to home; last item flagged 165 (0xA5).
export function toInavMission(m) {
  const its = m.items.filter(i => i.type !== 'takeoff'); // INAV has no takeoff item
  const lines = its.map((it, k) => {
    const last = k === its.length - 1 ? 165 : 0;
    const a = { no: k + 1, action: 'WAYPOINT', lat: 0, lon: 0, alt: 0, parameter1: 0, parameter2: 0, parameter3: 0, flag: last };
    if (it.type === 'waypoint') Object.assign(a, { lat: f7(it.lat), lon: f7(it.lon), alt: Math.round(it.alt) });
    else if (it.type === 'loiter') Object.assign(a, { action: 'POSHOLD_TIME', lat: f7(it.lat), lon: f7(it.lon), alt: Math.round(it.alt), parameter1: it.seconds });
    else if (it.type === 'rtl') Object.assign(a, { action: 'RTH' });
    return `  <missionitem ${Object.entries(a).map(([k2, v]) => `${k2}="${v}"`).join(' ')}></missionitem>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>
<mission>
  <version value="2.3-pre8"></version>
  <mwp cx="${f7(m.home.lon)}" cy="${f7(m.home.lat)}" home-x="${f7(m.home.lon)}" home-y="${f7(m.home.lat)}" zoom="15"></mwp>
${lines.join('\n')}
</mission>
`;
}

// Whole plan as KML (ATAK, Google Earth). KML colours are aabbggrr.
export function toKml(state) {
  const kcol = hex => { const h = hex.replace('#', ''); return `ff${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`; };
  const coord = (p, alt = 0) => `${p.lon.toFixed(7)},${p.lat.toFixed(7)},${Math.round(alt)}`;
  const out = [`<?xml version="1.0" encoding="UTF-8"?>`, `<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${xmlEsc(state.mission.name)}</name>`];
  state.teams.forEach((t, i) => {
    out.push(`<Style id="t${i}"><LineStyle><color>${kcol(t.color)}</color><width>3</width></LineStyle><IconStyle><color>${kcol(t.color)}</color></IconStyle><PolyStyle><color>40${kcol(t.color).slice(2)}</color></PolyStyle></Style>`,
      `<Style id="p${i}"><LineStyle><color>${kcol(t.color)}</color><width>2</width></LineStyle></Style>`);
  });
  state.teams.forEach((t, i) => {
    if (t.lat == null) return;
    const ds = state.drones.filter(d => d.teamId === t.id && d.active);
    const chans = ds.map(d => {
      const f = d.assign ? d.vtx.bands[d.assign.bandIdx]?.freqs[d.assign.chIdx] : null;
      return `${d.callsign}${d.pilot ? ` (${d.pilot})` : ''}: ${f ? `${chanName(d.vtx, d.assign.bandIdx, d.assign.chIdx)} ${f} MHz` : 'unassigned'}`;
    }).join('\n');
    out.push(`<Folder><name>${xmlEsc(t.name)}</name>`);
    out.push(`<Placemark><name>${xmlEsc(t.name)} launch</name><description>${xmlEsc(`${toMgrs(t.lat, t.lon) ?? ''}\n${chans}`)}</description><styleUrl>#t${i}</styleUrl><Point><coordinates>${coord(t)}</coordinates></Point></Placemark>`);
    const path = flightPath(t, null);
    if (path) out.push(`<Placemark><name>${xmlEsc(t.name)} route</name><styleUrl>#t${i}</styleUrl><LineString><altitudeMode>relativeToGround</altitudeMode><coordinates>${path.pts.map(p => coord(p, p.alt)).join(' ')}</coordinates></LineString></Placemark>`);
    (t.route || []).forEach((w, k) => w.lat != null && out.push(`<Placemark><name>${xmlEsc(t.name)} WP${k + 1}</name><styleUrl>#t${i}</styleUrl><Point><altitudeMode>relativeToGround</altitudeMode><coordinates>${coord(w, w.altM ?? t.altM)}</coordinates></Point></Placemark>`));
    const track = (t.pilotTrack || []).filter(p => p.lat != null);
    if (track.length) out.push(`<Placemark><name>${xmlEsc(t.name)} pilot movement</name><styleUrl>#p${i}</styleUrl><LineString><tessellate>1</tessellate><coordinates>${[t, ...track].map(p => coord(p)).join(' ')}</coordinates></LineString></Placemark>`);
    for (const d of ds) {
      if (d.target?.lat == null) continue;
      out.push(`<Placemark><name>${xmlEsc(`${d.callsign} target`)}</name><description>${xmlEsc(`${toMgrs(d.target.lat, d.target.lon) ?? ''}${d.target.loiterMin ? `\nloiter ${d.target.loiterMin} min, ${d.target.loiterM ?? 0} m radius` : ''}`)}</description><styleUrl>#t${i}</styleUrl><Point><coordinates>${coord(d.target)}</coordinates></Point></Placemark>`);
    }
    out.push('</Folder>');
  });
  out.push('</Document></kml>');
  return out.join('\n');
}

// ---------- KML / KMZ import ----------
async function unzipFirstKml(buf) {
  const v = new DataView(buf), bytes = new Uint8Array(buf);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a valid KMZ (zip) file.');
  let p = v.getUint32(eocd + 16, true);
  const count = v.getUint16(eocd + 10, true);
  for (let n = 0; n < count; n++) {
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true);
    const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (!/\.kml$/i.test(name)) continue;
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + csize);
    if (method === 0) return new TextDecoder().decode(data);
    if (method !== 8) throw new Error('Unsupported KMZ compression.');
    const ds = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return await new Response(ds).text();
  }
  throw new Error('No .kml file inside the KMZ.');
}

// Returns [{name, kind: 'line'|'point'|'polygon', pts: [{lat, lon, alt}]}]
export async function readKmlFile(file) {
  const text = /\.kmz$/i.test(file.name) ? await unzipFirstKml(await file.arrayBuffer()) : await file.text();
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Could not read the KML.');
  const parse = s => s.trim().split(/\s+/).map(c => c.split(',').map(Number)).filter(a => a.length >= 2 && a.every(Number.isFinite)).map(([lon, lat, alt]) => ({ lat, lon, alt: alt ?? null }));
  const out = [];
  for (const pm of doc.getElementsByTagName('Placemark')) {
    const name = pm.getElementsByTagName('name')[0]?.textContent?.trim() || 'Unnamed';
    for (const [tag, kind] of [['LineString', 'line'], ['Point', 'point'], ['Polygon', 'polygon']]) {
      for (const g of pm.getElementsByTagName(tag)) {
        const c = g.getElementsByTagName('coordinates')[0];
        if (c) out.push({ name, kind, pts: parse(c.textContent) });
      }
    }
  }
  if (!out.length) throw new Error('No points, lines or shapes found in the file.');
  return out;
}
