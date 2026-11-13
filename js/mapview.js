/* global L */
import { distM, fmtDist } from './geo.js';
import { toMgrs, fmtLatLon } from './coords.js';

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
  layers = { overlays: L.layerGroup().addTo(map), teams: L.layerGroup().addTo(map), links: L.layerGroup().addTo(map), emitters: L.layerGroup().addTo(map) };
  L.control.layers(base, { 'Team links': layers.links, 'Site overlays': layers.overlays, 'Emitters': layers.emitters }).addTo(map);
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
    L.circle([t.lat, t.lon], { radius: t.radiusM, color: t.color, weight: t.id === selectedId ? 3 : 2, fillOpacity: 0.08, interactive: false }).addTo(layers.teams);
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
