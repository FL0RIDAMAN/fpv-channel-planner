import { SITES, ANTENNAS } from './data.js';
import { load, save, emptyMission, exampleMission, newTeam, newDrone, uid, clone, migrate, TEMPLATES, templateKey, vtxFromTemplate } from './store.js';
import { buildScenario, evaluate, pairMatrix, linkProfile } from './rf.js';
import { solve } from './solver.js';
import { parseAny, channelsOf, chanName } from './vtxtable.js';
import { ensureBounds, terrainStats, DEM_Z, DEM_URL, TILE_CACHE } from './terrain.js';
import { initMap, setView, renderSiteOverlays, renderTeams, renderEmitters, renderRoutes, fitTeams, getMap, showHover, clearHover, BASEMAPS } from './mapview.js';
import { firmwareCommands, channelCardHtml, downloadText, powerLabel } from './export.js';
import { FIRMWARES, fwSupports } from './firmware.js';
import { distM, fmtDist, tilesForBounds } from './geo.js';
import { parseCoord, toMgrs, fmtLatLon } from './coords.js';
import { flightPath, POINT_TYPES, pointTypeName, routeIssues } from './paths.js';
import { missionItems, toWaypointsFile, toQgcPlan, toInavMission, toKml, readKmlFile } from './missions.js';

// ---------- state ----------
let state = load() || emptyMission('mwtc');
let plan = null;          // { scn, assign, pIdx, ev }
let terrainMsg = '';
const ui = { tab: 'teams', placing: null, selectedTeam: null, openDrone: null, solving: false };

const $ = s => document.querySelector(s);
const site = () => SITES[state.mission.site] || SITES.custom;
const byId = (arr, id) => arr.find(x => x.id === id);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const num = (label, obj, key, opts = {}) => h('label', { title: opts.title },
  label, h('input', { type: 'number', step: opts.step ?? 'any', min: opts.min, value: obj[key] ?? '', onchange: e => { obj[key] = e.target.value === '' ? null : Number(e.target.value); commit(); } }));
const txt = (label, obj, key, opts = {}) => h('label', { title: opts.title },
  label, h('input', { type: opts.type || 'text', value: obj[key] ?? '', placeholder: opts.placeholder, onchange: e => { obj[key] = e.target.value; commit(opts.light); } }));
const sel = (label, obj, key, options, opts = {}) => h('label', { title: opts.title },
  label, h('select', { onchange: e => { obj[key] = opts.numeric ? Number(e.target.value) : e.target.value; opts.after?.(); commit(); } },
    options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(obj[key]) || null }, l))));
const chk = (label, obj, key, after) => h('label', { class: 'chk' },
  h('input', { type: 'checkbox', checked: obj[key], onchange: e => { obj[key] = e.target.checked; after?.(); commit(); } }), label);
const status = m => m == null ? '' : m >= 3 ? 'good' : m >= 0 ? 'warn' : 'bad';
const statusText = m => m >= 3 ? 'OK' : m >= 0 ? 'MARGINAL' : 'CONFLICT';

// ---------- persistence + recompute ----------
let recomputeTimer = null;
function commit(light) {
  save(state);
  if (!light) scheduleRecompute();
  render();
}
function scheduleRecompute() {
  clearTimeout(recomputeTimer);
  recomputeTimer = setTimeout(recompute, 250);
}

function areaBounds() {
  const pts = [];
  for (const t of state.teams) if (t.lat != null) {
    const dLat = t.radiusM / 111000, dLon = t.radiusM / (111000 * Math.cos(t.lat * Math.PI / 180));
    pts.push([t.lat - dLat, t.lon - dLon], [t.lat + dLat, t.lon + dLon]);
  }
  for (const e of state.emitters) if (e.lat != null) pts.push([e.lat, e.lon]);
  for (const t of state.teams) for (const w of [...(t.route || []), ...(t.pilotTrack || [])]) if (w.lat != null) pts.push([w.lat, w.lon]);
  for (const d of state.drones) if (d.target?.lat != null) { const r = (d.target.loiterM || 0) / 111000; pts.push([d.target.lat - r, d.target.lon - r], [d.target.lat + r, d.target.lon + r]); }
  if (!pts.length) return null;
  const s = Math.min(...pts.map(p => p[0])) - 0.01, n = Math.max(...pts.map(p => p[0])) + 0.01;
  const w = Math.min(...pts.map(p => p[1])) - 0.01, e = Math.max(...pts.map(p => p[1])) + 0.01;
  return { s, w, n, e };
}

async function recompute() {
  const b = areaBounds();
  if (b) {
    try {
      const r = await ensureBounds(b.s, b.w, b.n, b.e);
      terrainMsg = r.missing ? `Terrain: ${r.missing}/${r.requested} tiles unavailable (offline?) — those paths assume line-of-sight.` : `Terrain loaded (${r.requested} tiles, ~30 m DEM).`;
    } catch (e) { terrainMsg = `Terrain: ${e.message} Paths assume line-of-sight.`; }
  }
  evaluateCurrent();
  render();
}

function evaluateCurrent() {
  const scn = buildScenario(state);
  const assign = scn.nodes.map(n => n.cur), pIdx = scn.nodes.map(n => n.pIdx);
  plan = scn.nodes.length ? { scn, assign, pIdx, ev: evaluate(scn, assign, pIdx, true) } : { scn, assign, pIdx, ev: null };
  plan.profiles = scn.nodes.map((n, i) => linkProfile(scn, i, pIdx[i]));
}

async function runSolve() {
  ui.solving = true; render();
  await recompute();
  await new Promise(r => setTimeout(r, 30));
  const scn = plan.scn;
  if (!scn.nodes.length) { ui.solving = false; render(); alert('Nothing to solve — add teams (placed on the map) and drones.'); return; }
  const best = solve(scn, { iterations: 4000, restarts: 6, seed: Date.now() });
  scn.nodes.forEach((n, i) => {
    const c = n.cands[best.assign[i]];
    n.drone.assign = { bandIdx: c.bandIdx, chIdx: c.chIdx };
    n.drone.flightPowerIdx = best.pIdx[i];
    n.drone.takeoffPowerIdx = best.tIdx[i];
    n.drone.powerPlanned = true;
  });
  ui.solving = false;
  ui.tab = 'results';
  save(state);
  evaluateCurrent();
  render();
}

// ---------- map ----------
initMap($('#map'), {
  onMapClick: p => {
    if (!ui.placing) return;
    const { kind, id, list } = ui.placing;
    if (kind === 'draw') {
      const t = byId(state.teams, id), arr = t[list];
      arr.push(list === 'route' ? { id: uid('w'), lat: p.lat, lon: p.lon, altM: arr[arr.length - 1]?.altM ?? t.altM } : { id: uid('w'), lat: p.lat, lon: p.lon });
      commit();
      return;
    }
    const obj = findPlaceable(id);
    if (obj) { obj.lat = p.lat; obj.lon = p.lon; }
    ui.placing = null;
    document.body.classList.remove('panel-hidden');
    commit();
  },
  onTeamMoved: (id, p) => { const t = byId(state.teams, id); Object.assign(t, p); commit(); },
  onEmitterMoved: (id, p) => { const e = byId(state.emitters, id); Object.assign(e, p); commit(); },
  onPointMoved: (id, p) => { const o = findPlaceable(id); if (o) { Object.assign(o, p); commit(); } },
  onTeamClick: id => { ui.selectedTeam = id; ui.tab = 'teams'; render(); document.querySelectorAll('.team-card')[state.teams.findIndex(t => t.id === id)]?.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
});

// Anything with a map position, by id: team launch points, emitters, waypoints, pilot positions, targets.
function findPlaceable(id) {
  for (const t of state.teams) {
    if (t.id === id) return t;
    const w = [...(t.route || []), ...(t.pilotTrack || [])].find(x => x.id === id);
    if (w) return w;
  }
  return state.emitters.find(e => e.id === id) || state.drones.map(d => d.target).find(g => g?.id === id) || null;
}

// Drawing a route or pilot track: every map tap adds a point until Done.
function startDraw(team, list) {
  ui.placing = { kind: 'draw', id: team.id, list };
  document.body.classList.add('panel-hidden');
  render();
}

function startPlacing(kind, id, label) {
  ui.placing = { kind, id };
  document.body.classList.add('panel-hidden');
  render();
  $('#mapHint').replaceChildren(`Tap the map to set ${label}`, h('button', { class: 'small', style: 'margin-left:10px', onclick: e => { e.stopPropagation(); cancelPlacing(); } }, 'Cancel'));
}
function cancelPlacing() { ui.placing = null; document.body.classList.remove('panel-hidden'); render(); }
addEventListener('keydown', e => { if (e.key === 'Escape' && ui.placing) cancelPlacing(); });

// Warn when a typed point is far from the mission area (usual cause: missing minus sign or wrong zone).
function farNote(p) {
  const ref = state.teams.find(t => t.lat != null) || site();
  const d = distM(ref, p);
  return d > 300000 ? ` ⚠ ${fmtDist(d)} from ${ref.name || 'the site'} — check the minus sign / grid zone.` : '';
}

// Coordinate entry: MGRS or lat/long, with a live check and a map pick button.
function coordField(label, obj, pickLabel, kind) {
  const has = obj.lat != null;
  const preview = h('div', { class: `coord-preview ${has ? 'ok' : ''}` }, has ? `${fmtLatLon(obj.lat, obj.lon)}` : 'Type MGRS (e.g. 11S KC 79808 48321) or lat, long — or pick on the map.');
  const inp = h('input', { class: 'coord-input', 'data-for': obj.id, value: has ? (toMgrs(obj.lat, obj.lon) ?? fmtLatLon(obj.lat, obj.lon)) : '', placeholder: 'MGRS or lat, long', autocomplete: 'off', spellcheck: 'false', 'aria-label': label });
  const check = () => {
    const v = inp.value.trim();
    if (!v) { preview.textContent = ''; preview.className = 'coord-preview'; return null; }
    try {
      const p = parseCoord(v);
      const far = obj.lat != null ? (distM(obj, p) > 300000 ? ` ⚠ moves it ${fmtDist(distM(obj, p))} — check the minus sign / grid zone.` : '') : farNote(p);
      preview.textContent = (p.kind === 'MGRS' ? `✓ ${fmtLatLon(p.lat, p.lon)}${p.precisionM > 10 ? ` (±${p.precisionM / 2} m grid square)` : ''}` : `✓ ${toMgrs(p.lat, p.lon) ?? 'outside MGRS area'}`) + far;
      preview.className = `coord-preview ${far ? 'bad' : 'ok'}`;
      return p;
    } catch (e) { preview.textContent = e.message; preview.className = 'coord-preview bad'; return null; }
  };
  inp.oninput = check;
  let applied = false;
  const apply = () => {
    if (applied) return;
    const p = check();
    if (!p) return;
    applied = true;
    obj.lat = p.lat; obj.lon = p.lon;
    inp.blur();
    getMap().setView([p.lat, p.lon], Math.max(getMap().getZoom(), 13));
    commit();
  };
  inp.onchange = apply;
  inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); apply(); } };
  return h('div', { class: `coord-field ${has ? '' : 'needs'}` },
    h('div', { class: 'f-label' }, label),
    h('div', { class: 'row' }, inp,
      h('button', { class: 'small', title: 'Pick on the map', onclick: () => startPlacing(kind, obj.id, pickLabel) }, '📍 Map'),
      has ? h('button', { class: 'small', title: 'Centre map here', onclick: () => getMap().setView([obj.lat, obj.lon], 14) }, 'Zoom') : null),
    preview);
}

// ---------- rendering ----------
function render() {
  if (ui.placing && !findPlaceable(ui.placing.id)) {
    ui.placing = null;
    document.body.classList.remove('panel-hidden');
  }
  $('#missionName').value = state.mission.name;
  $('#siteSel').value = state.mission.site;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === ui.tab));
  $('#mapHint').hidden = !ui.placing;
  if (ui.placing?.kind === 'draw') {
    const t = byId(state.teams, ui.placing.id), arr = t?.[ui.placing.list] || [];
    const what = ui.placing.list === 'route' ? 'waypoints' : 'pilot positions';
    $('#mapHint').replaceChildren(`Tap the map to add ${what} for ${t?.name} · ${arr.length} so far`,
      h('button', { class: 'small', style: 'margin-left:10px', disabled: !arr.length || null, onclick: e => { e.stopPropagation(); arr.pop(); commit(); } }, 'Undo'),
      h('button', { class: 'small', style: 'margin-left:6px', onclick: e => { e.stopPropagation(); cancelPlacing(); } }, 'Done'));
  }
  $('#btnSolve').textContent = ui.solving ? 'Solving…' : 'Solve channels';
  $('#btnSolve').disabled = ui.solving;
  const body = $('#tabBody');
  const scroll = body.scrollTop;
  // keep a coordinate field the user is typing in across redraws (value, cursor and focus)
  const act = document.activeElement;
  const keep = act && body.contains(act) && act.dataset?.for ? { id: act.dataset.for, value: act.value, start: act.selectionStart, end: act.selectionEnd } : null;
  body.replaceChildren(({ teams: renderTeamsTab, results: renderResultsTab, equipment: renderEquipmentTab, env: renderEnvTab })[ui.tab]());
  body.scrollTop = scroll;
  if (keep) {
    const el = body.querySelector(`.coord-input[data-for="${keep.id}"]`);
    if (el) {
      if (el.value !== keep.value) { el.value = keep.value; el.oninput?.(); }
      el.focus({ preventScroll: true });
      try { el.setSelectionRange(keep.start, keep.end); } catch { /* ignore */ }
    }
  }
  if (ui.focusCoord) {
    const inp = body.querySelector(`.coord-input[data-for="${ui.focusCoord}"]`);
    ui.focusCoord = null;
    if (inp) { inp.closest('.card')?.scrollIntoView({ block: 'start' }); inp.focus({ preventScroll: true }); }
  }
  const links = new Map();
  if (plan?.scn) for (const [k, v] of plan.scn.teamCoupling) links.set(k, v);
  renderTeams(state, links, ui.selectedTeam);
  renderEmitters(state);
  renderRoutes(state, plan, ui.openDrone);
}

// ---------- Teams & Aircraft ----------
const today = () => new Date().toISOString().slice(0, 10);
const polOpts = [['RHCP', 'RHCP'], ['LHCP', 'LHCP'], ['LIN', 'Linear']];
const curFreq = d => d.assign ? d.vtx.bands[d.assign.bandIdx]?.freqs[d.assign.chIdx] : null;

// After the VTX table changes: keep the same frequency and the closest powers if possible.
function remapAfterTableChange(d, old) {
  const near = mw => {
    let best = -1, bd = Infinity;
    d.vtx.powers.forEach((p, i) => { if (p.mW && Math.abs(p.mW - mw) < bd) { bd = Math.abs(p.mW - mw); best = i; } });
    return Math.max(0, best);
  };
  d.takeoffPowerIdx = near(old.takeoffMw ?? 25);
  d.flightPowerIdx = near(old.flightMw ?? 800);
  d.powerPlanned = false;
  const c = old.freq ? channelsOf(d.vtx).find(x => x.freq === old.freq) : null;
  d.assign = c ? { bandIdx: c.bandIdx, chIdx: c.chIdx } : null;
  if (!c) d.locked = false;
}
const snapshot = d => ({ freq: curFreq(d), takeoffMw: d.vtx.powers[d.takeoffPowerIdx]?.mW, flightMw: d.vtx.powers[d.flightPowerIdx]?.mW });

function applyTable(d, text) {
  const p = parseAny(text);
  const old = snapshot(d);
  Object.assign(d.vtx, { bands: p.bands, powers: p.powers, source: 'uploaded', uploadedAt: today() });
  delete d.vtx.copiedFrom;
  remapAfterTableChange(d, old);
  commit();
}

function uploadTableFile(d) {
  const inp = h('input', { type: 'file', accept: '.txt,.json,.cli,text/plain,application/json' });
  inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return;
    try { applyTable(d, await f.text()); } catch (e) { alert(`Could not read ${f.name}: ${e.message}`); }
  };
  inp.click();
}

function pasteTableDialog(d) {
  const ta = h('textarea', { rows: 12, placeholder: 'In the Betaflight CLI type:  vtxtable\nthen copy all the lines it prints and paste them here.\n(A VTX table .json file\'s contents also work.)' });
  dialog(`VTX table for ${d.callsign}`, h('div', null,
    h('div', { class: 'muted small-text', style: 'margin-bottom:6px' }, h('a', { href: 'manual.html#pull-table', target: '_blank' }, 'How to pull the table from the quad')), ta), [
    h('button', { class: 'primary', type: 'button', onclick: () => { try { applyTable(d, ta.value); $('#dlg').close(); } catch (e) { alert(e.message); } } }, 'Use this table')]);
}

function tableStatus(d) {
  const v = d.vtx;
  const summary = `${v.bands.length} band${v.bands.length === 1 ? '' : 's'} (${v.bands.map(b => b.letter).join('')}) · power ${v.powers.map((p, i) => powerLabel(v, i)).join('/')}`;
  if (v.source === 'uploaded') return h('div', { class: 'ok-box' }, `✓ Table uploaded ${v.uploadedAt || ''} · ${summary}`);
  if (v.source === 'copied') return h('div', { class: 'note' }, `Copied from ${v.copiedFrom}'s table · ${summary}. Upload this quad's own table if it differs.`);
  return h('div', { class: 'warn-box' }, `Using the approximate ${v.brand} ${v.model} template · ${summary}. Upload the table pulled from this quad.`);
}

function templateSelect(d) {
  const brands = [...new Set(TEMPLATES.map(t => t.brand))];
  return h('label', null, 'VTX model', h('select', {
    onchange: e => {
      if (d.vtx.source === 'uploaded' && !confirm('Switching the model replaces the uploaded table with a template. Continue?')) { render(); return; }
      const old = snapshot(d);
      d.vtx = vtxFromTemplate(e.target.value);
      remapAfterTableChange(d, old);
      commit();
    },
  }, brands.map(b => h('optgroup', { label: b }, TEMPLATES.filter(t => t.brand === b).map(t => {
    const k = templateKey(t);
    return h('option', { value: k, selected: d.vtx.template === k || null }, t.model);
  })))));
}

function downloadMission(d, kind) {
  const team = byId(state.teams, d.teamId);
  const m = missionItems(team, d);
  if (!m) return;
  if (!m.terrainOk && !confirm('Terrain data isn\'t loaded for every waypoint, so some heights will be written as height above home instead of above the ground there. Download anyway?')) return;
  const base = `${d.callsign || 'mission'}`.replace(/[^\w-]+/g, '_');
  if (kind === 'waypoints') downloadText(`${base}.waypoints`, toWaypointsFile(m), 'text/plain');
  if (kind === 'plan') downloadText(`${base}.plan`, toQgcPlan(m), 'application/json');
  if (kind === 'inav') downloadText(`${base}.mission`, toInavMission(m), 'application/xml');
}

function missionSection(d) {
  const team = byId(state.teams, d.teamId), fw = d.firmware || 'betaflight';
  const canAuto = fw === 'inav' || fw === 'ardupilot';
  if (!canAuto && d.flightMode === 'auto') d.flightMode = 'manual';
  const g = d.target;
  const path = team ? flightPath(team, d) : null;
  return h('div', null,
    h('div', { class: 'section-label' }, 'Mission'),
    h('div', { class: 'grid' },
      h('label', null, 'How it\'s flown', h('select', { onchange: e => { d.flightMode = e.target.value; commit(); } },
        h('option', { value: 'manual', selected: d.flightMode !== 'auto' || null }, 'Hand-flown'),
        h('option', { value: 'auto', selected: d.flightMode === 'auto' || null, disabled: !canAuto || null }, canAuto ? 'Autonomous mission' : 'Autonomous (INAV/ArduPilot only)')))),
    g ? h('div', { class: 'target-box' },
      coordField('Target', g, `${d.callsign}'s target`, 'point'),
      h('div', { class: 'grid' },
        num('Height AGL (m)', g, 'altM', { min: 1 }),
        num('Loiter radius (m)', g, 'loiterM', { min: 0, title: 'Area the aircraft works in around the target (used for interference and the link check)' }),
        num('Loiter time (min)', g, 'loiterMin', { min: 0, title: 'Autonomous missions hold here this long (0 = fly through)' }),
        h('div', null, h('button', { class: 'small danger', onclick: () => { d.target = null; commit(); } }, '✕ Remove target'))))
      : h('button', { class: 'small', onclick: () => { d.target = { id: uid('g'), lat: null, lon: null, altM: team?.altM ?? 60, loiterM: 150, loiterMin: 0 }; ui.focusCoord = d.target.id; commit(); } }, '+ Add target'),
    h('div', { class: 'muted small-text', style: 'margin-top:4px' }, path ? `Flies ${team.route.length ? `the ${team.name} route` : 'from the launch point'}${g?.lat != null ? ' then to its target' : ''}${team.rtl === true ? ', then returns to launch' : ' (one-way)'} · ${fmtDist(path.length)}.` : 'No route or target yet — planned as flying anywhere within the team radius.'),
    d.flightMode === 'auto' && canAuto ? h('div', { class: 'row', style: 'margin-top:6px' },
      !path ? h('span', { class: 'muted small-text' }, 'Add a team route or a target to export a mission.')
        : fw === 'ardupilot' ? [
          h('button', { class: 'small primary', onclick: () => downloadMission(d, 'waypoints') }, '⬇ Mission Planner (.waypoints)'),
          h('button', { class: 'small', onclick: () => downloadMission(d, 'plan') }, '⬇ QGroundControl (.plan)')]
          : h('button', { class: 'small primary', onclick: () => downloadMission(d, 'inav') }, '⬇ INAV Configurator (.mission)')) : null);
}

// Takeoff/landing and in-flight power are outputs of Solve; a pilot can still fix either by hand.
function powerPlanBox(d, fw, powerOpts) {
  const team = byId(state.teams, d.teamId), v = d.vtx;
  const planned = d.powerPlanned;
  const row = (label, key, lockKey, hint) => h('div', { class: 'power-line' },
    h('div', null, h('div', { class: 'muted small-text' }, label), d[lockKey]
      ? h('select', { onchange: e => { d[key] = Number(e.target.value); commit(); } }, powerOpts.map(([i, l]) => h('option', { value: i, selected: i === d[key] || null }, l)))
      : h('b', { class: planned ? '' : 'muted' }, planned ? powerLabel(v, d[key], fw) : 'set by Solve')),
    h('div', { class: 'muted small-text', style: 'flex:1' }, hint),
    chk('Fix by hand', d, lockKey));
  return h('div', { class: 'power-box' },
    row('Takeoff / landing', 'takeoffPowerIdx', 'takeoffLocked', `Until ${team?.switchM ?? 150} m from launch, and again on the way in to land.`),
    row('In flight', 'flightPowerIdx', 'powerLocked', 'Beyond that distance.'),
    planned ? null : h('div', { class: 'muted small-text' }, 'Press Solve channels: the planner picks the lowest takeoff and flight power that keeps every pilot clear.'),
    (v.powers[d.flightPowerIdx]?.mW ?? 0) < (v.powers[d.takeoffPowerIdx]?.mW ?? 0) && (d.takeoffLocked || d.powerLocked) ? h('div', { class: 'warn-box' }, 'Fixed flight power is lower than takeoff power — check these are the right way round.') : null);
}

function droneEditor(d, r) {
  const v = d.vtx, rx = byId(state.receivers, d.receiverId), fw = d.firmware || 'betaflight';
  const cands = channelsOf(v).filter(c => (!rx || rx.ranges.some(([lo, hi]) => c.freq >= lo && c.freq <= hi)) && fwSupports(fw, c.freq));
  const curKey = d.assign ? `${d.assign.bandIdx}:${d.assign.chIdx}` : '';
  const powerOpts = v.powers.map((p, i) => [i, powerLabel(v, i, fw)]).filter((_, i) => v.powers[i].mW);
  return h('div', { class: 'drone-editor' },
    h('div', { class: 'section-label' }, 'Aircraft'),
    h('div', { class: 'grid' },
      txt('Callsign', d, 'callsign', { light: true }),
      txt('Pilot name', d, 'pilot', { light: true, placeholder: 'e.g. Sgt. Rivera' }),
      sel('Flight controller', d, 'firmware', Object.entries(FIRMWARES).map(([k, f]) => [k, f.name]), {
        after: () => { const f = curFreq(d); if (f && !fwSupports(d.firmware, f)) { d.assign = null; d.locked = false; } },
      }),
      sel('Goggles / receiver', d, 'receiverId', state.receivers.map(x => [x.id, x.name]), {
        after: () => { const r = byId(state.receivers, d.receiverId); if (r?.antennaGainDbi != null) d.rxGainDbi = r.antennaGainDbi; },
      })),
    h('div', { class: 'section-label' }, 'VTX'),
    h('div', { class: 'grid' }, templateSelect(d)),
    tableStatus(d),
    h('div', { class: 'row' },
      h('button', { class: 'primary small', onclick: () => uploadTableFile(d) }, '⬆ Upload VTX table file'),
      h('button', { class: 'small', onclick: () => pasteTableDialog(d) }, 'Paste table'),
      h('a', { class: 'small-text', href: 'manual.html#pull-table', target: '_blank' }, 'How do I pull it?')),
    h('div', { class: 'section-label' }, 'VTX power (planned)'),
    powerPlanBox(d, fw, powerOpts),
    missionSection(d),
    h('details', null, h('summary', { class: 'muted small-text' }, 'Advanced: channel lock, power switch, antennas, VTX details'),
      h('div', { class: 'grid', style: 'margin-top:6px' },
        h('label', null, 'Channel', h('select', {
          onchange: e => {
            if (!e.target.value) { d.assign = null; d.locked = false; } else { const [b, c] = e.target.value.split(':').map(Number); d.assign = { bandIdx: b, chIdx: c }; d.locked = true; }
            commit();
          },
        }, h('option', { value: '' }, 'Auto (solver)'), cands.map(c => h('option', { value: `${c.bandIdx}:${c.chIdx}`, selected: curKey === `${c.bandIdx}:${c.chIdx}` || null }, `${c.name} ${c.freq}`)))),
        h('div', null, chk('Lock channel', d, 'locked'), chk('Include in plan', d, 'active')),
        num('Power switch RC channel (5–16)', d, 'switchCh', { min: 5, title: 'Radio channel of a switch that changes takeoff → flight power. Adds switch setup to the exported commands.' }),
        sel('Team', d, 'teamId', state.teams.map(t => [t.id, t.name])),
        sel('VTX type', v, 'type', [['analog', 'Analog'], ['digital', 'Digital (HDZero)']]),
        sel('VTX control protocol', v, 'protocol', [['SmartAudio', 'SmartAudio'], ['Tramp', 'IRC Tramp'], ['MSP', 'MSP (HDZero)'], ['CRSF', 'CRSF'], ['None', 'None / manual'], ['', 'Unknown']], { title: 'Used for INAV/ArduPilot power mapping' }),
        num('Signal width (MHz)', v, 'bandwidthMHz'), num('Freq. tolerance ± (MHz)', v, 'freqTolMHz'),
        num('Measured freq. offset (MHz)', d, 'freqOffsetMHz'),
        num('Max range (m, blank = team radius)', d, 'maxRangeM'),
        num('VTX antenna gain (dBi)', d, 'txGainDbi'), sel('VTX antenna polarization', d, 'txPol', polOpts),
        num('Goggle antenna gain (dBi)', d, 'rxGainDbi', { title: ANTENNAS.map(a => a.name).join(', ') }), sel('Goggle antenna polarization', d, 'rxPol', polOpts))),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'primary small', onclick: () => { ui.openDrone = null; render(); } }, 'Done'),
      h('button', { class: 'small', onclick: () => { const c = newDrone(state, d.teamId); Object.assign(c, { ...clone(d), id: c.id, callsign: c.callsign, pilot: '', assign: null, locked: false, target: null }); c.vtx = { ...clone(d.vtx), source: d.vtx.source === 'uploaded' ? 'copied' : d.vtx.source, copiedFrom: d.callsign }; state.drones.splice(state.drones.indexOf(d) + 1, 0, c); ui.openDrone = c.id; commit(); } }, 'Duplicate'),
      h('button', { class: 'small danger', onclick: () => { if (confirm(`Remove ${d.callsign}?`)) { state.drones = state.drones.filter(x => x !== d); commit(); } } }, 'Remove')),
  );
}

function droneRow(d) {
  const v = d.vtx, fw = d.firmware || 'betaflight';
  const node = plan?.scn.nodes.findIndex(n => n.drone.id === d.id);
  const r = node >= 0 && plan.ev ? plan.ev.res[node] : null;
  const open = ui.openDrone === d.id;
  const f = curFreq(d);
  const badge = v.source === 'uploaded' ? h('span', { class: 'st good', title: 'VTX table uploaded' }, 'table ✓')
    : v.source === 'copied' ? h('span', { class: 'st warn', title: `Table copied from ${v.copiedFrom}` }, 'copied table')
    : h('span', { class: 'st warn', title: 'No table uploaded yet' }, 'template');
  return h('div', { class: `drone ${open ? 'open' : ''} ${d.active ? '' : 'inactive'}` },
    h('div', { class: 'drone-row', onclick: () => { ui.openDrone = open ? null : d.id; render(); } },
      h('span', { class: 'callsign' }, d.callsign || '—'),
      h('span', { class: 'pilot' }, d.pilot || h('i', { class: 'muted' }, 'no pilot')),
      h('span', { class: 'chan' }, f ? `${chanName(v, d.assign.bandIdx, d.assign.chIdx)} ${f}` : h('span', { class: 'muted' }, '—')),
      h('span', { class: 'pw', title: 'Planned VTX power: takeoff/landing → in flight' }, d.powerPlanned || (d.takeoffLocked && d.powerLocked) ? `${powerLabel(v, d.takeoffPowerIdx, fw)} → ${powerLabel(v, d.flightPowerIdx, fw)}` : 'power: Solve'),
      badge,
      r && d.assign ? h('span', { class: `st ${status(r.margin)}` }, `${r.margin.toFixed(1)} dB`) : null,
      h('span', { class: 'chev' }, open ? '▾' : '▸')),
    h('div', { class: 'drone-sub muted small-text' }, `${v.brand} ${v.model} · ${FIRMWARES[fw].name}${d.flightMode === 'auto' ? ' · autonomous' : ''}${d.target?.lat != null ? ' · has target' : ''} · ${byId(state.receivers, d.receiverId)?.name ?? 'no goggles'}`),
    open ? droneEditor(d, r) : null);
}

function pointRow(t, list, w, i) {
  const isRoute = list === 'route';
  const label = !isRoute ? `Pilot position ${i + 2}` : w.type === 'launch' ? 'Launch (takeoff)' : w.type === 'land' ? 'Land' : w.type === 'loiter' ? `Loiter ${i + 1}` : `WP${i + 1}`;
  return h('div', { class: `wp-row ${isRoute ? `wp-${w.type || 'wp'}` : ''}` },
    coordField(label, w, `${t.name} ${label}`, 'point'),
    h('div', { class: 'wp-side' },
      isRoute ? h('label', { class: 'f' }, 'Type', h('select', { style: 'width:120px', onchange: e => {
        w.type = e.target.value;
        if (w.type === 'loiter') { w.loiterM ??= 150; w.loiterMin ??= 5; }
        if (w.type === 'launch' && i > 0) { t.route.splice(i, 1); t.route.unshift(w); }   // launch goes first
        if (w.type === 'land' && i < t.route.length - 1) { t.route.splice(i, 1); t.route.push(w); } // land goes last
        commit();
      } }, POINT_TYPES.map(([v, l]) => h('option', { value: v, selected: (w.type || 'wp') === v || null }, l)))) : null,
      isRoute && w.type !== 'land' ? h('label', { class: 'f' }, 'AGL m', h('input', { type: 'number', min: 1, value: w.altM ?? t.altM, style: 'width:70px', onchange: e => { w.altM = Number(e.target.value) || t.altM; commit(); } })) : null,
      isRoute && w.type === 'loiter' ? [
        h('label', { class: 'f' }, 'Min', h('input', { type: 'number', min: 0, step: 0.5, value: w.loiterMin ?? 0, style: 'width:60px', onchange: e => { w.loiterMin = Number(e.target.value) || 0; commit(); } })),
        h('label', { class: 'f' }, 'Radius m', h('input', { type: 'number', min: 0, value: w.loiterM ?? 0, style: 'width:70px', onchange: e => { w.loiterM = Number(e.target.value) || 0; commit(); } }))] : null,
      h('button', { class: 'small danger', title: 'Remove', onclick: () => { t[list] = t[list].filter(x => x !== w); commit(); } }, '✕')));
}

function downloadTeamRoute(t, kind) {
  if (kind === 'atak') { downloadText(`${t.name.replace(/[^\w-]+/g, '_')}.kml`, toKml(state, t.id), 'application/vnd.google-earth.kml+xml'); return; }
  const m = missionItems(t, null);
  if (!m) return;
  if (!m.terrainOk && !confirm('Terrain data isn\'t loaded for every point, so some heights will be written as height above home instead of above the ground there. Download anyway?')) return;
  const base = t.name.replace(/[^\w-]+/g, '_');
  if (kind === 'waypoints') downloadText(`${base}.waypoints`, toWaypointsFile(m), 'text/plain');
  if (kind === 'plan') downloadText(`${base}.plan`, toQgcPlan(m), 'application/json');
  if (kind === 'inav') downloadText(`${base}.mission`, toInavMission(m), 'application/xml');
}

function kmlChooser(t) {
  const k = ui.kmlImport;
  if (!k || k.teamId !== t.id) return null;
  const toPts = (it, withAlt) => it.pts.map(p => withAlt ? { id: uid('w'), lat: p.lat, lon: p.lon, altM: t.altM } : { id: uid('w'), lat: p.lat, lon: p.lon });
  const dropLaunch = pts => (t.lat != null && pts.length && distM(t, pts[0]) < 50) ? pts.slice(1) : pts;
  return h('div', { class: 'note' },
    h('div', { class: 'row' }, h('b', null, `From ${k.file}:`), h('button', { class: 'small', onclick: () => { ui.kmlImport = null; render(); } }, '✕')),
    k.items.map(it => h('div', { class: 'row', style: 'margin-top:4px' },
      h('span', { style: 'flex:1' }, `${it.name} · ${it.kind === 'point' ? 'point' : `${it.kind} (${it.pts.length} pts)`}`),
      it.kind === 'point' ? [
        h('button', { class: 'small', onclick: () => { t.route.push(...toPts(it, true)); commit(); } }, 'Add as waypoint'),
        h('button', { class: 'small', onclick: () => { Object.assign(t, { lat: it.pts[0].lat, lon: it.pts[0].lon }); commit(); } }, 'Use as launch point'),
      ] : [
        h('button', { class: 'small', onclick: () => { t.route = dropLaunch(toPts(it, true)); ui.kmlImport = null; commit(); } }, 'Use as route'),
        h('button', { class: 'small', onclick: () => { t.pilotTrack = dropLaunch(toPts(it, false)); ui.kmlImport = null; commit(); } }, 'Use as pilot movement'),
      ])),
    h('div', { class: 'muted small-text', style: 'margin-top:4px' }, 'Heights are taken from the team\'s flying height (ATAK altitudes are ignored); adjust each waypoint\'s AGL after importing.'));
}

function importKml(t) {
  const inp = h('input', { type: 'file', accept: '.kml,.kmz,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz' });
  inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return;
    try { ui.kmlImport = { teamId: t.id, file: f.name, items: await readKmlFile(f) }; render(); } catch (e) { alert(`${f.name}: ${e.message}`); }
  };
  inp.click();
}

function routeSection(t) {
  const path = flightPath(t, null);
  const summary = t.route.length ? `${t.route.length} waypoint${t.route.length === 1 ? '' : 's'} · ${fmtDist(path?.length ?? 0)}${t.rtl === true ? ' · returns to launch' : ' · one-way'}` : 'none — aircraft fly anywhere in the radius';
  return h('div', null,
    h('div', { class: 'section-label' }, `Route (${summary})`),
    t.route.map((w, i) => pointRow(t, 'route', w, i)),
    h('div', { class: 'row' },
      h('button', { class: 'small', disabled: t.lat == null || null, onclick: () => startDraw(t, 'route') }, '✏️ Draw on map'),
      h('button', { class: 'small', onclick: () => { const w = { id: uid('w'), lat: null, lon: null, altM: t.route[t.route.length - 1]?.altM ?? t.altM }; t.route.push(w); ui.focusCoord = w.id; commit(); } }, '+ Waypoint'),
      h('button', { class: 'small', onclick: () => importKml(t) }, 'Import from ATAK (KML/KMZ)')),
    kmlChooser(t),
    routeIssues(t).map(m => h('div', { class: 'warn-box' }, m)),
    t.route.length ? h('div', { class: 'row', style: 'margin-top:6px' },
      chk('Return to launch at the end (default: one-way)', t, 'rtl'),
      h('label', { class: 'f', title: 'How far aircraft may stray either side of the route (used for interference)' }, 'Corridor ± m',
        h('input', { type: 'number', min: 0, value: t.corridorM ?? 150, style: 'width:80px', onchange: e => { t.corridorM = Number(e.target.value) || 0; commit(); } }))) : null,
    t.route.some(w => w.lat != null) ? h('div', { class: 'row', style: 'margin-top:6px' }, h('span', { class: 'muted small-text' }, 'Export route:'),
      h('button', { class: 'small', onclick: () => downloadTeamRoute(t, 'waypoints') }, '⬇ Mission Planner'),
      h('button', { class: 'small', onclick: () => downloadTeamRoute(t, 'plan') }, '⬇ QGC'),
      h('button', { class: 'small', onclick: () => downloadTeamRoute(t, 'inav') }, '⬇ INAV'),
      h('button', { class: 'small', onclick: () => downloadTeamRoute(t, 'atak') }, '⬇ ATAK (KML)')) : null);
}

function pilotSection(t) {
  const n = t.pilotTrack.length;
  return h('div', null,
    h('div', { class: 'section-label' }, `Pilot movement (${n ? `${n} position${n === 1 ? '' : 's'} after launch` : 'pilots stay at the launch point'})`),
    t.pilotTrack.map((w, i) => pointRow(t, 'pilotTrack', w, i)),
    n ? h('div', { class: 'muted small-text' }, 'Pilots start at the launch point and move through these positions in step with the aircraft along the route.') : null,
    h('div', { class: 'row' },
      h('button', { class: 'small', disabled: t.lat == null || null, onclick: () => startDraw(t, 'pilotTrack') }, '✏️ Draw on map'),
      h('button', { class: 'small', onclick: () => { const w = { id: uid('w'), lat: null, lon: null }; t.pilotTrack.push(w); ui.focusCoord = w.id; commit(); } }, '+ Pilot position')));
}

function teamCard(t) {
  const ds = state.drones.filter(d => d.teamId === t.id);
  const pilots = new Set(ds.map(d => d.pilot).filter(Boolean)).size;
  return h('div', { class: 'card team-card', style: `border-top:4px solid ${t.color}` },
    h('div', { class: 'card-head' },
      h('input', { type: 'color', value: t.color, style: 'width:34px;padding:0;min-height:26px', title: 'Team colour', onchange: e => { t.color = e.target.value; commit(true); } }),
      h('input', { class: 'grow', value: t.name, 'aria-label': 'Team name', onchange: e => { t.name = e.target.value; commit(true); } }),
      h('button', { class: 'small danger', title: `Delete ${t.name}`, 'aria-label': `Delete ${t.name}`, onclick: () => deleteTeam(t) }, '✕')),
    coordField('Launch point (pilots + takeoff)', t, `${t.name}'s launch point`, 'team'),
    t.lat == null ? h('div', { class: 'warn-box' }, 'Set the launch point: type an MGRS grid or lat/long above and press Enter, or press 📍 Map and tap the map. Until then this team is left out of the plan.')
      : h('div', { class: 'muted small-text' }, `${ds.length} aircraft · ${pilots} pilot${pilots === 1 ? '' : 's'}`),
    h('div', { class: 'grid' },
      num(t.route?.length ? 'Flying radius (m, unused with a route)' : 'Flying radius (m)', t, 'radiusM', { min: 50, title: 'Furthest the drones go from the pilots when there is no route' }),
      num('Flying height AGL (m)', t, 'altM', { min: 1 }),
      num('Switch to flight power at (m from launch)', t, 'switchM', { min: 20, title: 'Pilots fly at takeoff power until this far from the launch point, then switch to flight power (and back before landing). The planner checks the video at takeoff power out to here.' }),
      txt('Start time', t, 'start', { type: 'time' }),
      txt('End time', t, 'end', { type: 'time' })),
    h('details', null, h('summary', { class: 'muted small-text' }, 'Advanced: spacing and antenna height'),
      h('div', { class: 'grid', style: 'margin-top:6px' },
        num('Takeoff spacing (m)', t, 'launchSepM', { min: 2, title: 'Closest a teammate takes off or lands (at takeoff power) to another pilot\'s goggles' }),
        num('In-flight spacing (m)', t, 'flightSepM', { min: 2, title: 'Closest a teammate\'s airborne drone (at flight power) gets to another pilot\'s goggles' }),
        num('Pilot antenna height (m)', t, 'pilotHeightM', { min: 0.5 }))),
    routeSection(t),
    pilotSection(t),
    h('div', { class: 'section-label' }, `Aircraft (${ds.length})`),
    ds.length ? ds.map(droneRow) : h('div', { class: 'muted small-text' }, 'No aircraft yet.'),
    h('button', {
      class: 'add-aircraft', onclick: () => { const d = newDrone(state, t.id); state.drones.push(d); ui.openDrone = d.id; commit(); },
    }, ds.length ? '+ Add aircraft (copies the previous one\'s setup)' : '+ Add aircraft'));
}

function renderTeamsTab() {
  const out = [];
  if (!state.teams.length) {
    out.push(h('div', { class: 'empty' },
      h('h3', null, 'Plan a mission'),
      h('ol', null,
        h('li', null, 'Add a team with its launch point: MGRS grid, lat/long, or a pin on the map.'),
        h('li', null, 'Add each aircraft: callsign, pilot, VTX, takeoff and flight power.'),
        h('li', null, 'Upload the VTX table pulled from each quad.'),
        h('li', null, 'Press ', h('b', null, 'Solve channels'), '.')),
      h('button', { class: 'primary', onclick: addTeam }, '+ Add first team'),
      h('div', { class: 'muted small-text', style: 'margin-top:10px' }, 'Want to look around first? ☰ → Load example. Full instructions: ', h('a', { href: 'manual.html', target: '_blank' }, 'User manual'), '.')));
    return h('div', null, out);
  }
  state.teams.forEach(t => out.push(teamCard(t)));
  out.push(h('div', { class: 'row' },
    h('button', { class: 'primary', onclick: addTeam }, '+ Add team'),
    h('button', { onclick: () => fitTeams(state) }, 'Fit map to teams')));
  const orphans = state.drones.filter(d => !byId(state.teams, d.teamId));
  if (orphans.length) { out.push(h('h3', null, 'Aircraft without a team')); orphans.forEach(d => out.push(droneRow(d))); }

  const placed = state.teams.filter(t => t.lat != null);
  if (placed.length > 1) {
    out.push(h('h3', null, 'Team separation'));
    const rows = [];
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i], b = placed[j];
      const ab = plan?.scn.teamCoupling.get(`${a.id}|${b.id}`), ba = plan?.scn.teamCoupling.get(`${b.id}|${a.id}`);
      const fmtC = c => !c ? '—' : !c.terrain ? 'no terrain' : c.los ? 'LOS' : `−${c.diffDb.toFixed(0)} dB`;
      rows.push(h('tr', null, h('td', null, `${a.name} ↔ ${b.name}`), h('td', null, fmtDist(distM(a, b))), h('td', null, fmtC(ba)), h('td', null, fmtC(ab))));
    }
    out.push(h('div', { class: 'scroll-x' }, h('table', { class: 't' },
      h('tr', null, h('th', null, 'Pair'), h('th', null, 'Distance'), h('th', { title: 'Worst case: any point of the first team\'s area to the second team\'s pilots' }, '1st drones → 2nd pilots'), h('th', null, '2nd drones → 1st pilots')), rows)));
  }
  if (terrainMsg) out.push(h('div', { class: 'note' }, terrainMsg));
  return h('div', null, out);
}

function deleteTeam(t) {
  state.teams = state.teams.filter(x => x !== t);
  state.drones = state.drones.filter(d => d.teamId !== t.id);
  if (ui.placing?.id === t.id) cancelPlacing();
  if (ui.selectedTeam === t.id) ui.selectedTeam = null;
  commit();
}

// New team appears inline at the bottom of the list with its launch point field focused.
function addTeam() {
  const t = newTeam(state);
  state.teams.push(t);
  ui.selectedTeam = t.id;
  ui.focusCoord = t.id;
  commit();
}

function contribText(c, nodes, ni) {
  if (!c) return '';
  if (c.kind === 'external') return `${c.name} (Δ${Math.round(c.df)} MHz)`;
  if (c.kind === 'imd') return `IMD ${nodes[c.j].drone.callsign}+${nodes[c.k].drone.callsign} → ${Math.round(c.f)} MHz`;
  return `${nodes[c.j].drone.callsign}${c.phase === 'takeoff' ? ' at takeoff' : ''} (Δ${Math.round(c.df)} MHz)`;
}

function spectrumSvg(scn, ev) {
  const fs = ev.res.map(r => r.freq);
  const ext = scn.ext[0] || [];
  const all = [...fs, ...ext.map(e => e.freq)];
  const lo = Math.min(5325, ...all) - 20, hi = Math.max(5945, ...all) + 20;
  const W = 460, rowH = 18, lanes = [];
  const items = scn.nodes.map((n, i) => ({ f: fs[i], bw: n.bw, label: n.drone.callsign, color: n.team.color, m: ev.res[i].margin }))
    .sort((a, b) => a.f - b.f);
  for (const it of items) {
    let lane = lanes.findIndex(end => end < it.f - it.bw / 2 - 2);
    if (lane < 0) { lane = lanes.length; lanes.push(0); }
    lanes[lane] = it.f + Math.max(it.bw / 2, 14);
    it.lane = lane;
  }
  const H = 30 + lanes.length * rowH + (ext.length ? rowH : 0);
  const x = f => (f - lo) / (hi - lo) * W;
  const parts = [`<svg class="spectrum" viewBox="0 0 ${W} ${H}" role="img" aria-label="Spectrum plan">`];
  for (let f = Math.ceil(lo / 50) * 50; f <= hi; f += 50) parts.push(`<line x1="${x(f)}" x2="${x(f)}" y1="0" y2="${H - 14}" stroke="currentColor" stroke-opacity=".12"/><text x="${x(f)}" y="${H - 3}" font-size="9" text-anchor="middle" fill="currentColor" fill-opacity=".6">${f}</text>`);
  ext.forEach(e => parts.push(`<rect x="${x(e.freq - e.bw / 2)}" y="${4 + lanes.length * rowH}" width="${Math.max(2, x(e.freq + e.bw / 2) - x(e.freq - e.bw / 2))}" height="${rowH - 3}" fill="#888" fill-opacity=".35"/><text x="${x(e.freq)}" y="${4 + lanes.length * rowH + 10}" font-size="9" text-anchor="middle" fill="currentColor">${e.name.slice(0, 18)}</text>`));
  for (const it of items) {
    const y = 4 + it.lane * rowH;
    parts.push(`<rect x="${x(it.f - it.bw / 2)}" y="${y}" width="${x(it.f + it.bw / 2) - x(it.f - it.bw / 2)}" height="${rowH - 3}" rx="3" fill="${it.color}" fill-opacity=".75" stroke="${it.m < 0 ? '#c62828' : 'none'}" stroke-width="2"><title>${it.label} ${it.f} MHz</title></rect><text x="${x(it.f)}" y="${y + 10}" font-size="9" text-anchor="middle" fill="#fff" font-weight="700">${it.label}</text>`);
  }
  parts.push('</svg>');
  return h('div', { html: parts.join('') });
}

function profileSvg(lp, color) {
  const W = 460, H = 96, pad = 22;
  const vals = lp.samples.filter(s => !s.loiter).map(s => s.dbm);
  // keep the scale readable: ignore the moments the aircraft is right over the pilots, floor deep blockage
  const lo = Math.max(lp.threshold - 30, Math.min(lp.threshold - 6, ...vals)), hi = Math.min(lp.threshold + 40, Math.max(lp.threshold + 6, ...vals));
  const x = a => pad + (a / (lp.length || 1)) * (W - pad - 4), y = v => 6 + (hi - v) / (hi - lo || 1) * (H - 24);
  const clip = v => Math.min(hi, Math.max(lo, v));
  const line = lp.samples.filter(s => !s.loiter).map((s, i) => `${i ? 'L' : 'M'}${x(s.along).toFixed(1)},${y(clip(s.dbm)).toFixed(1)}`).join('');
  const blocked = lp.runs.map(r => `<rect x="${x(r.from)}" y="4" width="${Math.max(2, x(r.to) - x(r.from))}" height="${H - 20}" fill="#c62828" fill-opacity=".18"/>`).join('');
  const chart = h('div', { html: `<svg class="spectrum profile" viewBox="0 0 ${W} ${H}" role="img" aria-label="Video signal along route — hover to see the point on the map">
    ${blocked}
    <line x1="${pad}" x2="${W - 4}" y1="${y(lp.threshold)}" y2="${y(lp.threshold)}" stroke="#c62828" stroke-dasharray="4 3" stroke-width="1"/>
    <text x="${W - 6}" y="${y(lp.threshold) - 3}" font-size="9" text-anchor="end" fill="#c62828">picture breaks up</text>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2"/>
    <text x="${pad}" y="${H - 4}" font-size="9" fill="currentColor" fill-opacity=".6">0</text>
    <text x="${W - 4}" y="${H - 4}" font-size="9" text-anchor="end" fill="currentColor" fill-opacity=".6">${fmtDist(lp.length)}</text>
    <text x="2" y="${y(hi) + 8}" font-size="9" fill="currentColor" fill-opacity=".6">${Math.round(hi)}</text>
    <text x="2" y="${y(lo)}" font-size="9" fill="currentColor" fill-opacity=".6">${Math.round(lo)}</text>
    <g class="cursor" style="display:none"><line y1="2" y2="${H - 16}" stroke="currentColor" stroke-opacity=".7" stroke-width="1"/><circle r="3.5" fill="${color}" stroke="#fff" stroke-width="1.5"/></g></svg>` });

  // Hover / touch: cursor + readout on the chart, aircraft and pilot positions on the map.
  const wrap = h('div', { class: 'profile-wrap' }, chart, h('div', { class: 'profile-tip', hidden: true }));
  const svg = chart.querySelector('svg'), cur = svg.querySelector('.cursor'), tip = wrap.querySelector('.profile-tip');
  const pts = lp.samples.filter(q => !q.loiter);
  const pick = e => {
    const r = svg.getBoundingClientRect();
    const vx = (e.clientX - r.left) / r.width * W;
    const along = Math.min(lp.length, Math.max(0, (vx - pad) / (W - pad - 4) * lp.length));
    let best = pts[0];
    for (const q of pts) if (Math.abs(q.along - along) < Math.abs(best.along - along)) best = q;
    return best;
  };
  const show = e => {
    const q = pick(e);
    const cx = x(q.along), cy = y(clip(q.dbm));
    cur.style.display = '';
    cur.querySelector('line').setAttribute('x1', cx); cur.querySelector('line').setAttribute('x2', cx);
    cur.querySelector('circle').setAttribute('cx', cx); cur.querySelector('circle').setAttribute('cy', cy);
    const margin = q.dbm - lp.threshold;
    tip.hidden = false;
    tip.replaceChildren(
      h('b', null, `${fmtDist(q.along)} along`), ` · ${Math.round(q.dbm)} dBm (${margin >= 0 ? '+' : ''}${margin.toFixed(0)} dB) · `,
      h('span', { class: q.los ? 'ok-text' : 'bad-text' }, q.los ? 'clear line of sight' : `blocked by terrain (−${Math.round(q.diffDb)} dB)`),
      h('br'), `Aircraft ${toMgrs(q.drone.lat, q.drone.lon) ?? ''} · ${Math.round(q.drone.alt)} m AGL · ${fmtDist(distM(q.drone, q.pilot))} from pilots`);
    const pct = Math.min(Math.max(cx / W, 0.15), 0.85);
    tip.style.left = `${pct * 100}%`;
    showHover(q.drone, q.pilot, q.los, color);
  };
  const hide = () => { cur.style.display = 'none'; tip.hidden = true; clearHover(); };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', e => { show(e); const q = pick(e); getMap().panTo([q.drone.lat, q.drone.lon]); });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('pointercancel', hide);
  return wrap;
}

function linkSection(scn) {
  const items = scn.nodes.map((n, i) => ({ n, lp: plan.profiles?.[i] })).filter(x => x.lp);
  if (!items.length) return [];
  const out = [h('h3', null, 'Video link along routes')];
  out.push(h('div', { class: 'muted small-text' }, 'Each aircraft\'s own video signal along its route, with terrain between it and the pilots (pilots moving in step if they have a pilot track). Red bands are where a ridge blocks the line of sight. Hover over a chart (or drag a finger along it) to see that moment on the map; click to centre the map there.'));
  for (const { n, lp } of items) {
    const low = lp.samples.filter(s => !s.loiter && s.dbm < lp.threshold).length;
    out.push(h('div', { class: 'card' },
      h('div', { class: 'row' }, h('span', { class: 'swatch', style: `background:${n.team.color}` }), h('b', null, n.drone.callsign), n.drone.pilot ? h('span', { class: 'muted' }, n.drone.pilot) : null,
        h('span', { class: `st ${lp.runs.length || lp.loiterBlocked ? 'bad' : low ? 'warn' : 'good'}` }, lp.runs.length || lp.loiterBlocked ? 'terrain blocks video' : low ? 'weak in places' : 'clear')),
      profileSvg(lp, n.team.color),
      !lp.terrain ? h('div', { class: 'muted small-text' }, 'Terrain not loaded for the whole route — blocked sections may be missing.') : null,
      lp.runs.map(r => h('div', { class: 'warn-box row' },
        h('span', { style: 'flex:1' }, `Blocked ${fmtDist(r.from)}–${fmtDist(r.to)} along the route. ${r.minAgl ? `Needs about ${r.minAgl} m AGL there to see the pilots` : 'Not visible even at 1000 m AGL'}, or move the pilots.`),
        h('button', { class: 'small', onclick: () => getMap().setView([r.lat, r.lon], 14) }, 'Show'))),
      lp.loiterBlocked ? h('div', { class: 'warn-box' }, `Part of a loiter circle is hidden from the pilots by terrain (${lp.loiterBlocked} point${lp.loiterBlocked === 1 ? '' : 's'}).`) : null));
  }
  return out;
}

function renderResultsTab() {
  const out = [h('h3', null, 'Channel plan')];
  out.push(h('div', { class: 'row' },
    h('button', { class: 'primary', onclick: runSolve, disabled: ui.solving }, ui.solving ? 'Solving…' : 'Solve'),
    h('span', { class: 'muted small-text' }, 'Plans every aircraft\'s channel, takeoff/landing power and in-flight power.')));
  const letters = [...new Set(state.drones.flatMap(d => d.vtx.bands.map(b => b.letter)))];
  out.push(h('div', { class: 'row small-text', style: 'margin-top:6px' }, h('span', { class: 'muted' }, 'Allowed bands:'),
    letters.map(L => h('label', { class: 'chk' }, h('input', {
      type: 'checkbox', checked: !state.mission.bandFilter?.length || state.mission.bandFilter.includes(L),
      onchange: e => {
        let f = state.mission.bandFilter?.length ? [...state.mission.bandFilter] : [...letters];
        f = e.target.checked ? [...new Set([...f, L])] : f.filter(x => x !== L);
        state.mission.bandFilter = f.length === letters.length ? [] : f;
        commit();
      },
    }), L))));
  if (!plan?.ev) { out.push(h('div', { class: 'note' }, 'Add placed teams and drones, then Solve.')); return h('div', null, out); }
  const { scn, ev } = plan;
  const unassigned = scn.nodes.filter(n => !n.drone.assign).length;
  for (const w of scn.warnings) out.push(h('div', { class: 'warn-box' }, w));
  if (unassigned) out.push(h('div', { class: 'warn-box' }, `${unassigned} drone(s) unassigned — press Solve. Figures below use their first available channel.`));
  out.push(h('div', { class: 'card' },
    h('div', { class: 'row' }, h('b', null, 'Worst link margin:'), h('span', { class: `st ${status(ev.minMargin)}` }, `${ev.minMargin.toFixed(1)} dB · ${statusText(ev.minMargin)}`)),
    h('div', { class: 'muted small-text', style: 'margin-top:4px' }, 'Margin = how far each pilot\'s video is above the level where noise or interference becomes a problem (soft-min of noise and interference margins). ≥ 3 dB OK, 0–3 marginal, < 0 conflict.')));
  out.push(spectrumSvg(scn, ev));
  const rows = scn.nodes.map((n, i) => {
    const r = ev.res[i], c = n.cands[plan.assign[i]];
    const top = r.contrib?.find(x => x.I > n.noiseDbm - 3);
    const range = `range/noise (${fmtDist(n.desiredRangeM)})`;
    const why = r.limitedPhase === 'takeoff' && r.marginT < 3
      ? `own video at takeoff power (${fmtDist(n.switchM)})`
      : r.mN < r.mI - 3 || !top ? range : contribText(top, scn.nodes, i) + (r.mN < 3 ? ' + range' : '');
    return h('tr', null,
      h('td', null, h('span', { class: 'swatch', style: `background:${n.team.color};margin-right:4px;vertical-align:-2px` }), n.drone.callsign, n.drone.pilot ? h('span', { class: 'muted' }, ` ${n.drone.pilot}`) : null),
      h('td', null, h('b', null, c.name), ` ${c.freq}`),
      h('td', { title: 'Planned VTX power: takeoff/landing → in flight' }, `${powerLabel(n.vtx, n.tIdx, n.drone.firmware)} → ${powerLabel(n.vtx, plan.pIdx[i], n.drone.firmware)}`),
      h('td', { title: 'Desired signal at edge of area (incl. fade margin)' }, r.S.toFixed(0)),
      h('td', null, r.snr.toFixed(0)), h('td', null, r.sir > 90 ? '—' : r.sir.toFixed(0)),
      h('td', { class: `m-${status(r.margin)}` }, r.margin.toFixed(1)),
      h('td', { class: 'small-text' }, r.margin < 6 ? why : ''));
  });
  out.push(h('div', { class: 'scroll-x' }, h('table', { class: 't' },
    h('tr', null, ['Drone', 'Channel', 'Power', 'Sig dBm', 'SNR', 'SIR', 'Margin', 'Limited by'].map(x => h('th', null, x))), rows)));

  // pair matrix
  const M = pairMatrix(scn, plan.assign, plan.pIdx);
  const reqs = scn.nodes.map(n => n.reqSir);
  out.push(h('h3', null, 'Pairwise C/I (dB)'));
  out.push(h('div', { class: 'muted small-text' }, 'Row = receiver (pilot goggles), column = interfering VTX. Each cell is desired signal minus that single interferer after receiver filtering. Blank = not airborne at the same time.'));
  out.push(h('div', { class: 'scroll-x' }, h('table', { class: 't matrix' },
    h('tr', null, h('th', null, 'RX \\ TX'), scn.nodes.map(n => h('th', { style: `color:${n.team.color}` }, n.drone.callsign))),
    scn.nodes.map((n, i) => h('tr', null, h('th', { style: `color:${n.team.color}` }, n.drone.callsign),
      M[i].map((v, j) => i === j ? h('td', null, '·') : v == null ? h('td', null, '') :
        h('td', { class: `m-${status(v - reqs[i])}`, title: `${n.drone.callsign} ← ${scn.nodes[j].drone.callsign}` }, v > 99 ? '99+' : v.toFixed(0))))))));

  // IMD warnings
  const imd = [];
  scn.nodes.forEach((n, i) => ev.res[i].contrib?.filter(c => c.kind === 'imd' && c.I > n.noiseDbm - 6).forEach(c => imd.push(`${n.drone.callsign} ← IMD from ${scn.nodes[c.j].drone.callsign}+${scn.nodes[c.k].drone.callsign} at ${Math.round(c.f)} MHz (${c.I.toFixed(0)} dBm)`)));
  if (imd.length) { out.push(h('h3', null, 'Intermodulation')); imd.slice(0, 20).forEach(t => out.push(h('div', { class: 'warn-box' }, t))); }
  out.push(...linkSection(scn));
  if (terrainMsg) out.push(h('div', { class: 'note' }, terrainMsg));
  return h('div', null, out);
}

function renderEquipmentTab() {
  const out = [];
  out.push(h('h3', null, 'Receivers / goggles'));
  out.push(h('div', { class: 'note' }, 'Selectivity, noise figure and IIP3 are estimates. Required SIR/SNR set how much margin you demand for a clean picture.'));
  for (const r of state.receivers) {
    const ranges = { v: r.ranges.map(x => x.join('-')).join(', ') };
    out.push(h('details', { class: 'card' }, h('summary', null, h('b', null, r.name), ` · ${r.type} · ${ranges.v} MHz`),
      h('div', { class: 'grid', style: 'margin-top:8px' }, txt('Name', r, 'name'),
        sel('Type', r, 'type', [['analog', 'Analog'], ['digital', 'Digital (HDZero)']]),
        h('label', null, 'Tunable ranges (MHz)', h('input', { value: ranges.v, onchange: e => { r.ranges = e.target.value.split(',').map(s => s.split('-').map(Number)).filter(a => a.length === 2 && a.every(Number.isFinite)); commit(); } })),
        sel('Selectivity', r, 'selectivity', [['standard', 'Standard'], ['improved', 'Improved'], ['digital', 'Digital']]),
        num('Noise figure (dB)', r, 'noiseFigureDb'), num('IIP3 (dBm)', r, 'iip3Dbm'),
        num('Required SIR (dB)', r, 'reqSirDb'), num('Required SNR (dB)', r, 'reqSnrDb'),
        num('Antenna gain (dBi, blank = set per aircraft)', r, 'antennaGainDbi', { title: 'Applied to an aircraft\'s goggle antenna gain when this receiver is chosen' })),
      r.note ? h('div', { class: 'note' }, r.note) : null,
      h('button', { class: 'small danger', disabled: state.drones.some(d => d.receiverId === r.id) || null, onclick: () => { state.receivers = state.receivers.filter(x => x !== r); commit(); } }, 'Delete')));
  }
  out.push(h('button', { onclick: () => { state.receivers.push({ id: uid('rx'), name: 'New receiver', type: 'analog', ranges: [[5300, 6000]], noiseFigureDb: 9, selectivity: 'standard', iip3Dbm: -15, reqSirDb: 15, reqSnrDb: 6 }); commit(); } }, '+ Receiver'));
  return h('div', null, out);
}

function renderEnvTab() {
  const s = site(), m = state.mission;
  const out = [h('h3', null, 'Site & environment')];
  out.push(h('div', { class: 'note' }, h('b', null, s.name), s.note ? ` — ${s.note}` : ''));
  out.push(h('div', { class: 'grid' },
    num('Noise rise (dB)', m, 'envNoiseDb', { title: 'Raises the noise floor: urban RF clutter, broadband noise' }),
    num('Extra loss when blocked (dB)', m, 'nlosExtraDb', { title: 'Additional loss on obstructed paths for foliage/buildings not in the bare-earth DEM. 0 = conservative.' }),
    num('Fade margin on own link (dB)', m, 'fadeMarginDb')));
  out.push(h('h3', null, 'External emitters'));
  out.push(h('div', { class: 'note' }, 'Signals on or near your band that you don\'t control: Wi-Fi access points (5.8 GHz U-NII-3 overlaps the A/B/F bands), other units\' drones, video links. Placing them lets the solver steer around them.'));
  for (const e of state.emitters) {
    out.push(h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('input', { class: 'grow', value: e.name, onchange: ev => { e.name = ev.target.value; commit(); } }),
        h('button', { class: 'small danger', title: `Delete ${e.name}`, 'aria-label': `Delete ${e.name}`, onclick: () => { state.emitters = state.emitters.filter(x => x !== e); if (ui.placing?.id === e.id) cancelPlacing(); commit(); } }, '✕')),
      coordField('Location', e, e.name, 'emitter'),
      h('div', { class: 'grid' }, num('Center freq (MHz)', e, 'freqMHz'), num('Bandwidth (MHz)', e, 'bwMHz'), num('EIRP (dBm)', e, 'eirpDbm'), num('Height AGL (m)', e, 'heightM'))));
  }
  const addEm = (name, f, bw, eirp) => { const e = { id: uid('e'), name, lat: null, lon: null, heightM: 10, freqMHz: f, bwMHz: bw, eirpDbm: eirp }; state.emitters.push(e); commit(); };
  out.push(h('div', { class: 'row' },
    h('button', { onclick: () => addEm('Other drone (analog)', 5800, 18, 27) }, '+ Other drone'),
    h('button', { onclick: () => addEm('Wi-Fi ch149 20 MHz', 5745, 20, 30) }, '+ Wi-Fi ch149'),
    h('button', { onclick: () => addEm('Wi-Fi ch155 80 MHz', 5775, 80, 30) }, '+ Wi-Fi 80 MHz'),
    h('button', { onclick: () => addEm('Custom emitter', 5800, 20, 20) }, '+ Custom')));
  const ts = terrainStats();
  out.push(h('h3', null, 'Terrain'));
  out.push(h('div', { class: 'note' }, `${terrainMsg || 'Not loaded yet.'} Tiles in memory: ${ts.loaded}. Source: AWS Terrain Tiles (USGS 3DEP in the US), ~30 m at zoom ${DEM_Z}. Bare earth — trees and buildings are not included.`));
  out.push(h('h3', null, 'Notes'));
  out.push(h('textarea', { rows: 4, value: m.notes, onchange: e => { m.notes = e.target.value; commit(true); } }));
  return h('div', null, out);
}

// ---------- dialogs ----------
function dialog(title, content, buttons = []) {
  $('#dlgBody').replaceChildren(h('h3', null, title), content);
  $('#dlgMenu').replaceChildren(...buttons, h('button', { value: 'close' }, 'Close'));
  $('#dlg').showModal();
}

function cliDialog() {
  const pick = h('select', null, h('option', { value: '' }, 'All drones'),
    state.drones.filter(d => d.active).map(d => h('option', { value: d.id }, `${d.callsign} (${FIRMWARES[d.firmware || 'betaflight'].name})`)));
  const ta = h('textarea', { rows: 20, readonly: true });
  const refresh = () => { ta.value = firmwareCommands(state, pick.value || null); };
  pick.onchange = refresh; refresh();
  const fileName = () => {
    const d = byId(state.drones, pick.value);
    if (!d) return `${state.mission.name}-vtx.txt`;
    return d.firmware === 'ardupilot' ? `${d.callsign}-vtx.param` : `${d.callsign}-vtx.txt`;
  };
  dialog('Flight controller commands', h('div', null,
    h('div', { class: 'row', style: 'margin-bottom:6px' }, h('span', { class: 'muted' }, 'Show:'), pick,
      h('a', { href: 'manual.html#firmware', target: '_blank' }, 'How to apply these')), ta), [
    h('button', { type: 'button', onclick: () => navigator.clipboard?.writeText(ta.value) }, 'Copy'),
    h('button', { type: 'button', onclick: () => downloadText(fileName(), ta.value, 'text/plain') }, 'Download')]);
}

function printCard() {
  $('#printArea').innerHTML = channelCardHtml(state, plan, site().name);
  window.print();
}

async function cacheDialog() {
  const m = getMap(), b = m.getBounds(), z0 = Math.max(8, m.getZoom() - 2), z1 = Math.min(16, m.getZoom() + 2);
  const baseSel = h('select', null, Object.keys(BASEMAPS).map(k => h('option', { value: k }, k)));
  const tiles = [];
  for (let z = z0; z <= z1; z++) tiles.push(...tilesForBounds(b.getSouth(), b.getWest(), b.getNorth(), b.getEast(), z));
  const dem = tilesForBounds(b.getSouth(), b.getWest(), b.getNorth(), b.getEast(), DEM_Z);
  const prog = h('div', { class: 'note' }, `Current view: ${tiles.length} map tiles (zoom ${z0}–${z1}) + ${dem.length} terrain tiles. Zoom/pan the map to the mission area first.`);
  const go = h('button', {
    class: 'primary', type: 'button', onclick: async () => {
      if (tiles.length > 4000) { alert('Too many tiles — zoom in further.'); return; }
      go.disabled = true;
      const tpl = BASEMAPS[baseSel.value];
      const urls = [...tiles.map(t => tpl.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y)), ...dem.map(t => DEM_URL(t.z, t.x, t.y))];
      const cache = await caches.open(TILE_CACHE);
      let done = 0, fail = 0;
      const worker = async () => {
        while (urls.length) {
          const u = urls.pop();
          try { if (!(await cache.match(u))) { const r = await fetch(u, { mode: 'cors' }); if (r.ok) await cache.put(u, r); else fail++; } } catch { fail++; }
          done++;
          if (done % 10 === 0 || !urls.length) prog.textContent = `Downloaded ${done}/${tiles.length + dem.length}${fail ? ` (${fail} failed)` : ''}…`;
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
      prog.textContent = `Done: ${done - fail} tiles cached for offline use${fail ? `, ${fail} failed` : ''}.`;
      go.disabled = false;
    },
  }, 'Download');
  dialog('Save area for offline use', h('div', null, h('label', { class: 'f' }, 'Basemap', baseSel), prog,
    h('div', { class: 'muted small-text' }, 'Tiles are stored in this browser/app. The planner itself works offline once it has been opened once.')), [go]);
}

function helpDialog() {
  dialog('How it works', h('div', { class: 'small-text', html: `
<p><b>Workflow:</b> Teams &amp; Aircraft (add a team, place it, add each aircraft with pilot, VTX, takeoff and flight power, and upload its <code>vtxtable</code>) → Environment (Wi-Fi, other emitters) → <b>Solve</b> → print the channel card and export the flight controller commands.</p>
<p><b>Model, per pilot:</b> desired signal = own drone at the edge of the team circle, line-of-sight, minus fade margin. Interference = every other airborne VTX at its <i>worst-case</i> position (13+6 sample points in its circle) using terrain-aware path loss: free-space + Deygout knife-edge diffraction over a ~30 m DEM with 4/3-earth curvature. Teammates are checked both in flight (in-flight spacing, flight power) and at takeoff (takeoff spacing, takeoff power), taking the worse case. Polarization: RHCP vs LHCP ≈15 dB on clear LOS, 3 dB when obstructed.</p>
<p><b>Receiver:</b> off-channel rejection vs frequency offset (minus VTX tolerances and wide-band digital spill), plus 3rd-order intermodulation (2f₁−f₂) from every pair of strong signals. Margin is the soft-minimum of interference margin (SIR − required) and noise margin (SNR − required).</p>
<p><b>Solver:</b> simulated annealing over every channel each VTX table and goggle supports, maximizing the worst pilot's margin, then optionally stepping VTX power down while nobody falls below 3 dB.</p>
<p>Full instructions, including Betaflight, INAV and ArduPilot setup: <a href=\"manual.html\" target=\"_blank\">User manual</a>.</p>
<p><b>Limits:</b> estimates, not measurements. Bare-earth terrain (no trees/buildings — use "Extra loss when blocked" if you want credit for them). Receiver figures are generic. Always do a goggle/spectrum check on site.</p>` }));
}

// ---------- top bar wiring ----------
$('#siteSel').append(...Object.entries(SITES).map(([k, s]) => h('option', { value: k }, s.name)));
$('#siteSel').onchange = e => {
  const k = e.target.value, s = SITES[k];
  state.mission.site = k; state.mission.envNoiseDb = s.envNoiseDb; state.mission.nlosExtraDb = s.nlosExtraDb;
  setView(s); renderSiteOverlays(s);
  if (state.teams.length && confirm(`Load the example mission for ${s.name}? (Cancel keeps your teams and only moves the map.)`)) { state = exampleMission(k); fitTeams(state); }
  commit();
};
$('#missionName').onchange = e => { state.mission.name = e.target.value; commit(true); };
$('#btnSolve').onclick = runSolve;
$('#tabs').onclick = e => { const t = e.target.closest('button')?.dataset.tab; if (t) { ui.tab = t; render(); } };
$('#btnPanelToggle').onclick = () => document.body.classList.toggle('panel-hidden');
$('#btnMenu').onclick = e => { e.stopPropagation(); $('#menu').hidden = !$('#menu').hidden; };
document.addEventListener('click', () => { $('#menu').hidden = true; });
$('#menu').onclick = e => {
  const act = e.target.dataset.act;
  if (!act) return;
  $('#menu').hidden = true;
  if (act === 'new' && confirm('Start a new empty mission? Unsaved changes are lost.')) { state = emptyMission(state.mission.site); commit(); }
  if (act === 'example' && confirm('Replace the current mission with the example?')) { state = exampleMission(state.mission.site in { mwtc: 1, dc: 1 } ? state.mission.site : 'mwtc'); fitTeams(state); commit(); }
  if (act === 'open') $('#fileOpen').click();
  if (act === 'save') downloadText(`${state.mission.name.replace(/[^\w-]+/g, '_')}.fpvplan.json`, JSON.stringify(state, null, 1));
  if (act === 'card') printCard();
  if (act === 'cli') cliDialog();
  if (act === 'kml') downloadText(`${state.mission.name.replace(/[^\w-]+/g, '_')}.kml`, toKml(state), 'application/vnd.google-earth.kml+xml');
  if (act === 'cache') cacheDialog();
  if (act === 'help') helpDialog();
  if (act === 'manual') window.open('manual.html', '_blank');
};
$('#fileOpen').onchange = async e => {
  try {
    const s = migrate(JSON.parse(await e.target.files[0].text()));
    if (!s) throw new Error('Not a planner mission file.');
    state = s; fitTeams(state); commit();
  } catch (err) { alert(err.message); }
  e.target.value = '';
};
const updateOnline = () => { $('#offlineBadge').hidden = navigator.onLine; };
addEventListener('online', updateOnline); addEventListener('offline', updateOnline); updateOnline();

// ---------- boot ----------
setView(site());
renderSiteOverlays(site());
if (state.teams.some(t => t.lat != null)) fitTeams(state);
render();
recompute();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  // When an update takes over, reload once so every file comes from the same version.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || sessionStorage.getItem('fpv-sw-reloaded')) return;
    sessionStorage.setItem('fpv-sw-reloaded', '1');
    save(state);
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
