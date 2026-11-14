/* global L */
import { distM, fmtDist } from './geo.js';
import { toMgrs, fmtLatLon } from './coords.js';
import { flightPath, pointAt } from './paths.js';

export const BASEMAPS = {
  'USGS Topo': 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
  'USGS Imagery + Topo': 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}',
  'USGS Shaded Relief': 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer/tile/{z}/{y}/{x}',
};

let map, layers, handlers;

export function initMap(el, h) {
  handlers = h;
  map = L.map(el, { zoomControl: true, maxZoom: 16 });
  const base = {};
  for (const [name, url] of Object.entries(BASEMAPS)) {
    base[name] = L.tileLayer(url, { maxZoom: 16, maxNativeZoom: 16, attribution: 'USGS The National Map' });
  }
  base['USGS Topo'].addTo(map);
  layers = { hover: null, overlays: L.layerGroup().addTo(map), routes: L.layerGroup().addTo(map), teams: L.layerGroup().addTo(map), links: L.layerGroup().addTo(map), emitters: L.layerGroup().addTo(map) };
  L.control.layers(base, { 'Routes & targets': layers.routes, 'Team links': layers.links, 'Site overlays': layers.overlays, 'Emitters': layers.emitters }).addTo(map);
  L.control.scale({ imperial: true }).addTo(map);
  map.on('click', e => handlers.onMapClick?.({ lat: e.latlng.lat, lon: e.latlng.lng }));

  // Live grid readout: pointer position on desktop, map centre on touch screens.
  const Readout = L.Control.extend({
    onAdd() {
      const el = L.DomUtil.create('div', 'coord-readout');
      L.DomEvent.disableClickPropagation(el);
      const show = ll => { el.innerHTML = `<b>${toMgrs(ll.lat, ll.lng) ?? '—'}</b><br>${fmtLatLon(ll.lat, ll.lng)}`; };
      map.on('mousemove', e => show(e.latlng));
      map.on('move', () => { if (!matchMedia('(hover: hover)').matches) show(map.getCenter()); });
      map.on('moveend', () => show(map.getCenter()));
      map.whenReady(() => show(map.getCenter()));
      el.title = 'Click to copy the MGRS grid';
      el.onclick = () => navigator.clipboard?.writeText(el.querySelector('b')?.textContent || '');
      return el;
    },
  });
  new Readout({ position: 'bottomleft' }).addTo(map);
  // crosshair at map centre for touch users picking by eye
  const cross = L.DomUtil.create('div', 'map-cross', el);
  cross.setAttribute('aria-hidden', 'true');
  return map;
}

export const getMap = () => map;
export function setView(site) { map.setView([site.lat, site.lon], site.zoom); }

export function renderSiteOverlays(site) {
  layers.overlays.clearLayers();
  for (const o of site.overlays || []) {
    if (o.type === 'circle') {
      L.circle([o.lat, o.lon], { radius: o.radiusM, color: o.color, weight: 2, dashArray: '6 6', fill: false, interactive: false })
        .bindTooltip(o.label, { sticky: true }).addTo(layers.overlays);
    }
  }
}

// linkInfo: Map "teamA|teamB" -> {los, diffDb, distM}
export function renderTeams(state, linkInfo, selectedId) {
  layers.teams.clearLayers();
  layers.links.clearLayers();
  const placed = state.teams.filter(t => t.lat != null);
  for (const t of placed) {
    const n = state.drones.filter(d => d.teamId === t.id && d.active).length;
    if (!(t.route || []).some(w => w.lat != null)) L.circle([t.lat, t.lon], { radius: t.radiusM, color: t.color, weight: t.id === selectedId ? 3 : 2, fillOpacity: 0.08, interactive: false }).addTo(layers.teams);
    const icon = L.divIcon({
      className: '', iconSize: [22, 22], iconAnchor: [11, 11],
      html: `<div style="width:22px;height:22px;border-radius:50%;background:${t.color};border:3px solid #fff;box-shadow:0 0 0 1px #0006"></div>`,
    });
    const m = L.marker([t.lat, t.lon], { icon, draggable: true, title: t.name, autoPan: true }).addTo(layers.teams);
    m.bindTooltip(`${t.name} · ${n} aircraft`, { permanent: true, direction: 'right', offset: [12, 0], className: 'team-label' });
    m.bindPopup(() => `<b>${t.name} launch point</b><br>${toMgrs(t.lat, t.lon) ?? ''}<br>${fmtLatLon(t.lat, t.lon)}`);
    m.on('dragend', () => { const p = m.getLatLng(); handlers.onTeamMoved?.(t.id, { lat: p.lat, lon: p.lng }); });
    m.on('click', () => handlers.onTeamClick?.(t.id));
  }
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
    const a = placed[i], b = placed[j];
    const d = distM(a, b);
    // worst case of the two directions (least terrain shielding)
    const cands = [linkInfo?.get(`${a.id}|${b.id}`), linkInfo?.get(`${b.id}|${a.id}`)].filter(Boolean);
    const li = cands.sort((x, y) => (x.los ? -1 : x.diffDb) - (y.los ? -1 : y.diffDb))[0];
    const color = !li ? '#555' : li.los ? '#c62828' : li.diffDb > 20 ? '#1a7f37' : '#b06a00';
    const line = L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color, weight: 2, dashArray: li && !li.los ? '5 6' : null }).addTo(layers.links);
    const txt = `${fmtDist(d)}${li ? (li.los ? ' · LOS' : ` · terrain −${Math.round(li.diffDb)} dB`) : ''}`;
    line.bindTooltip(txt, { permanent: true, direction: 'center', className: 'dist-label' });
  }
}

export function renderEmitters(state) {
  layers.emitters.clearLayers();
  for (const e of state.emitters || []) {
    if (e.lat == null) continue;
    const icon = L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 9], html: '<div style="width:18px;height:18px;transform:rotate(45deg);background:#222;border:2px solid #ff0"></div>' });
    const m = L.marker([e.lat, e.lon], { icon, draggable: true, title: e.name }).addTo(layers.emitters);
    m.bindTooltip(`${e.name} · ${e.freqMHz} MHz · ${e.eirpDbm} dBm EIRP`);
    m.on('dragend', () => { const p = m.getLatLng(); handlers.onEmitterMoved?.(e.id, { lat: p.lat, lon: p.lng }); });
  }
}

export function fitTeams(state) {
  const pts = state.teams.filter(t => t.lat != null).map(t => [t.lat, t.lon]);
  if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.4), { maxZoom: 14 });
}

// Team routes (solid), pilot movement (dashed), targets with loiter circles, and blocked video segments.
export function renderRoutes(state, plan, openDroneId) {
  layers.routes.clearLayers();
  const dot = (html, size = 20) => L.divIcon({ className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2], html });
  const drag = (m, id) => m.on('dragend', () => { const p = m.getLatLng(); handlers.onPointMoved?.(id, { lat: p.lat, lon: p.lng }); });
  for (const t of state.teams) {
    if (t.lat == null) continue;
    const path = flightPath(t, null);
    if (path) L.polyline(path.pts.map(p => [p.lat, p.lon]), { color: t.color, weight: 3, opacity: 0.9, interactive: false }).addTo(layers.routes);
    (t.route || []).forEach((w, i) => {
      if (w.lat == null) return;
      const sym = w.type === 'launch' ? '▲' : w.type === 'land' ? '▼' : w.type === 'loiter' ? '⟳' : `${i + 1}`;
      const name = w.type === 'launch' ? 'launch (takeoff)' : w.type === 'land' ? 'land' : w.type === 'loiter' ? `loiter ${i + 1}${w.loiterMin ? ` · ${w.loiterMin} min` : ''}` : `WP${i + 1}`;
      const m = L.marker([w.lat, w.lon], { draggable: true, icon: dot(`<div class="wp-dot ${w.type || 'wp'}" style="background:${t.color}">${sym}</div>`) }).addTo(layers.routes);
      m.bindTooltip(`${t.name} ${name}${w.type === 'land' ? '' : ` · ${w.altM ?? t.altM} m AGL`}<br>${toMgrs(w.lat, w.lon) ?? ''}`);
      if (w.type === 'loiter' && (w.loiterM ?? 0) > 0) L.circle([w.lat, w.lon], { radius: w.loiterM, color: t.color, weight: 1.5, fillOpacity: 0.05, dashArray: '3 4', interactive: false }).addTo(layers.routes);
      drag(m, w.id);
    });
    const track = (t.pilotTrack || []).filter(p => p.lat != null);
    if (track.length) L.polyline([[t.lat, t.lon], ...track.map(p => [p.lat, p.lon])], { color: t.color, weight: 2, dashArray: '2 6', interactive: false }).addTo(layers.routes);
    track.forEach((p, i) => {
      const m = L.marker([p.lat, p.lon], { draggable: true, icon: dot(`<div class="pilot-dot" style="border-color:${t.color}">P${i + 2}</div>`, 22) }).addTo(layers.routes);
      m.bindTooltip(`${t.name} pilot position ${i + 2}<br>${toMgrs(p.lat, p.lon) ?? ''}`);
      drag(m, p.id);
    });
  }
  for (const d of state.drones) {
    const g = d.target, t = state.teams.find(x => x.id === d.teamId);
    if (!g || g.lat == null || !t) continue;
    const p = flightPath(t, d);
    if (p && t.route?.length) { const from = p.pts[p.targetIdx - 1]; L.polyline([[from.lat, from.lon], [g.lat, g.lon]], { color: t.color, weight: 2, dashArray: '8 5', interactive: false }).addTo(layers.routes); }
    else if (p) L.polyline([[t.lat, t.lon], [g.lat, g.lon]], { color: t.color, weight: 2, dashArray: '8 5', interactive: false }).addTo(layers.routes);
    if (g.loiterM > 0) L.circle([g.lat, g.lon], { radius: g.loiterM, color: t.color, weight: 1.5, fillOpacity: 0.06, dashArray: '3 4', interactive: false }).addTo(layers.routes);
    const m = L.marker([g.lat, g.lon], { draggable: true, icon: dot(`<div class="tgt-dot" style="color:${t.color}">⊕</div>`, 26) }).addTo(layers.routes);
    m.bindTooltip(`${d.callsign} target${d.id === openDroneId ? '' : ''}<br>${toMgrs(g.lat, g.lon) ?? ''}`, { permanent: d.id === openDroneId, direction: 'right', offset: [12, 0] });
    drag(m, g.id);
  }
  // red overlay where an aircraft's own video is blocked by terrain
  plan?.scn?.nodes.forEach((n, i) => {
    const lp = plan.profiles?.[i];
    if (!lp || !n.path) return;
    for (const r of lp.runs) {
      const pts = [];
      for (let k = 0; k <= 12; k++) { const q = pointAt(n.path, (r.from + (r.to - r.from) * k / 12) / (n.path.length || 1)); pts.push([q.lat, q.lon]); }
      L.polyline(pts, { color: '#c62828', weight: 8, opacity: 0.45 }).addTo(layers.routes)
        .bindTooltip(`${n.drone.callsign}: video blocked by terrain${r.minAgl ? ` — needs ≈${r.minAgl} m AGL` : ''}`, { sticky: true });
    }
  });
}

// Chart hover: aircraft and pilot at the same moment, joined by the line of sight.
let hoverRenderer = null;
export function showHover(drone, pilot, los, color) {
  if (!layers.hover) {
    const pane = map.createPane('chartHover');
    pane.style.zIndex = 700; // above route and team markers
    pane.style.pointerEvents = 'none';
    hoverRenderer = L.svg({ pane: 'chartHover' });
    layers.hover = L.layerGroup().addTo(map);
  }
  layers.hover.clearLayers();
  const o = { pane: 'chartHover', renderer: hoverRenderer, interactive: false };
  L.polyline([[pilot.lat, pilot.lon], [drone.lat, drone.lon]], { ...o, color: los ? '#1a7f37' : '#c62828', weight: 4, dashArray: los ? null : '7 5' }).addTo(layers.hover);
  L.circleMarker([pilot.lat, pilot.lon], { ...o, radius: 7, color: '#fff', weight: 2.5, fillColor: '#111', fillOpacity: 1 }).addTo(layers.hover);
  L.circleMarker([drone.lat, drone.lon], { ...o, radius: 11, color: '#fff', weight: 3, fillColor: color, fillOpacity: 1 }).addTo(layers.hover);
  L.circleMarker([drone.lat, drone.lon], { ...o, radius: 17, color, weight: 2, fill: false, opacity: 0.8 }).addTo(layers.hover);
}
export function clearHover() { layers.hover?.clearLayers(); }
