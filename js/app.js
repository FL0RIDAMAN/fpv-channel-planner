import { SITES, ANTENNAS } from './data.js';
import { load, save, emptyMission, exampleMission, newTeam, newDrone, uid, clone, migrate, TEMPLATES, templateKey, vtxFromTemplate } from './store.js';
import { buildScenario, evaluate, pairMatrix } from './rf.js';
import { solve } from './solver.js';
import { parseAny, channelsOf, chanName } from './vtxtable.js';
import { ensureBounds, terrainStats, DEM_Z, DEM_URL, TILE_CACHE } from './terrain.js';
import { initMap, setView, renderSiteOverlays, renderTeams, renderEmitters, fitTeams, getMap, BASEMAPS } from './mapview.js';
import { firmwareCommands, channelCardHtml, downloadText, powerLabel } from './export.js';
import { FIRMWARES, fwSupports } from './firmware.js';
import { distM, fmtDist, tilesForBounds } from './geo.js';
import { parseCoord, toMgrs, fmtLatLon } from './coords.js';

// ---------- state ----------
let state = load() || emptyMission('mwtc');
let plan = null;          // { scn, assign, pIdx, ev }
let terrainMsg = '';
const ui = { tab: 'teams', placing: null, selectedTeam: null, openDrone: null, optimizePower: true, solving: false };

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
}

async function runSolve() {
  ui.solving = true; render();
  await recompute();
  await new Promise(r => setTimeout(r, 30));
  const scn = plan.scn;
  if (!scn.nodes.length) { ui.solving = false; render(); alert('Nothing to solve — add teams (placed on the map) and drones.'); return; }
  const best = solve(scn, { optimizePower: ui.optimizePower, iterations: 4000, restarts: 6, seed: Date.now() });
  scn.nodes.forEach((n, i) => {
    const c = n.cands[best.assign[i]];
    n.drone.assign = { bandIdx: c.bandIdx, chIdx: c.chIdx };
    if (ui.optimizePower) n.drone.flightPowerIdx = best.pIdx[i];
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
    const { kind, id } = ui.placing;
    const obj = kind === 'team' ? byId(state.teams, id) : byId(state.emitters, id);
    if (obj) { obj.lat = p.lat; obj.lon = p.lon; }
    ui.placing = null;
    document.body.classList.remove('panel-hidden');
    commit();
  },
  onTeamMoved: (id, p) => { const t = byId(state.teams, id); Object.assign(t, p); commit(); },
  onEmitterMoved: (id, p) => { const e = byId(state.emitters, id); Object.assign(e, p); commit(); },
  onTeamClick: id => { ui.selectedTeam = id; ui.tab = 'teams'; render(); document.querySelectorAll('.team-card')[state.teams.findIndex(t => t.id === id)]?.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
});

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
  const inp = h('input', { class: 'coord-input', value: has ? (toMgrs(obj.lat, obj.lon) ?? fmtLatLon(obj.lat, obj.lon)) : '', placeholder: 'MGRS or lat, long', autocomplete: 'off', spellcheck: 'false', 'aria-label': label });
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
  inp.onchange = () => { const p = check(); if (p) { obj.lat = p.lat; obj.lon = p.lon; getMap().setView([p.lat, p.lon], Math.max(getMap().getZoom(), 13)); commit(); } };
  inp.onkeydown = e => { if (e.key === 'Enter') inp.blur(); };
  return h('div', { class: 'coord-field' },
    h('div', { class: 'f-label' }, label),
    h('div', { class: 'row' }, inp,
      h('button', { class: 'small', title: 'Pick on the map', onclick: () => startPlacing(kind, obj.id, pickLabel) }, '📍 Map'),
      has ? h('button', { class: 'small', title: 'Centre map here', onclick: () => getMap().setView([obj.lat, obj.lon], 14) }, 'Zoom') : null),
    preview);
}

// ---------- rendering ----------
function render() {
  $('#missionName').value = state.mission.name;
  $('#siteSel').value = state.mission.site;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === ui.tab));
  $('#mapHint').hidden = !ui.placing;
  $('#btnSolve').textContent = ui.solving ? 'Solving…' : 'Solve channels';
  $('#btnSolve').disabled = ui.solving;
  const body = $('#tabBody');
  const scroll = body.scrollTop;
  body.replaceChildren(({ teams: renderTeamsTab, results: renderResultsTab, equipment: renderEquipmentTab, env: renderEnvTab })[ui.tab]());
  body.scrollTop = scroll;
  const links = new Map();
  if (plan?.scn) for (const [k, v] of plan.scn.teamCoupling) links.set(k, v);
  renderTeams(state, links, ui.selectedTeam);
  renderEmitters(state);
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
      sel('Goggles / receiver', d, 'receiverId', state.receivers.map(x => [x.id, x.name]))),
    h('div', { class: 'section-label' }, 'VTX'),
    h('div', { class: 'grid' }, templateSelect(d)),
    tableStatus(d),
    h('div', { class: 'row' },
      h('button', { class: 'primary small', onclick: () => uploadTableFile(d) }, '⬆ Upload VTX table file'),
      h('button', { class: 'small', onclick: () => pasteTableDialog(d) }, 'Paste table'),
      h('a', { class: 'small-text', href: 'manual.html#pull-table', target: '_blank' }, 'How do I pull it?')),
    h('div', { class: 'section-label' }, 'VTX power'),
    h('div', { class: 'grid' },
      sel('Takeoff / landing', d, 'takeoffPowerIdx', powerOpts, { numeric: true, title: 'Power while on the ground and near the launch point' }),
      sel('In flight', d, 'flightPowerIdx', powerOpts, { numeric: true, title: 'Power once airborne. The solver may change this unless locked.' })),
    h('div', { class: 'row' }, chk('Lock flight power (solver won\'t change it)', d, 'powerLocked')),
    (d.vtx.powers[d.flightPowerIdx]?.mW ?? 0) < (d.vtx.powers[d.takeoffPowerIdx]?.mW ?? 0) ? h('div', { class: 'warn-box' }, 'Flight power is lower than takeoff power — check these are the right way round.') : null,
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
      h('button', { class: 'small', onclick: () => { const c = newDrone(state, d.teamId); Object.assign(c, { ...clone(d), id: c.id, callsign: c.callsign, pilot: '', assign: null, locked: false }); c.vtx = { ...clone(d.vtx), source: d.vtx.source === 'uploaded' ? 'copied' : d.vtx.source, copiedFrom: d.callsign }; state.drones.splice(state.drones.indexOf(d) + 1, 0, c); ui.openDrone = c.id; commit(); } }, 'Duplicate'),
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
      h('span', { class: 'pw', title: 'takeoff → flight' }, `${powerLabel(v, d.takeoffPowerIdx, fw)} → ${powerLabel(v, d.flightPowerIdx, fw)}`),
      badge,
      r && d.assign ? h('span', { class: `st ${status(r.margin)}` }, `${r.margin.toFixed(1)} dB`) : null,
      h('span', { class: 'chev' }, open ? '▾' : '▸')),
    h('div', { class: 'drone-sub muted small-text' }, `${v.brand} ${v.model} · ${FIRMWARES[fw].name} · ${byId(state.receivers, d.receiverId)?.name ?? 'no goggles'}`),
    open ? droneEditor(d, r) : null);
}

function teamCard(t) {
  const ds = state.drones.filter(d => d.teamId === t.id);
  const pilots = new Set(ds.map(d => d.pilot).filter(Boolean)).size;
  return h('div', { class: 'card team-card', style: `border-top:4px solid ${t.color}` },
    h('div', { class: 'card-head' },
      h('input', { type: 'color', value: t.color, style: 'width:34px;padding:0;min-height:26px', title: 'Team colour', onchange: e => { t.color = e.target.value; commit(true); } }),
      h('input', { class: 'grow', value: t.name, 'aria-label': 'Team name', onchange: e => { t.name = e.target.value; commit(true); } }),
      h('button', { class: 'small danger', title: 'Delete team', onclick: () => { if (confirm(`Delete ${t.name} and its ${ds.length} aircraft?`)) { state.teams = state.teams.filter(x => x !== t); state.drones = state.drones.filter(d => d.teamId !== t.id); commit(); } } }, '✕')),
    coordField('Launch point (pilots + takeoff)', t, `${t.name}'s launch point`, 'team'),
    t.lat == null ? h('div', { class: 'warn-box' }, 'No launch point yet — this team is left out of the plan until it has one.')
      : h('div', { class: 'muted small-text' }, `${ds.length} aircraft · ${pilots} pilot${pilots === 1 ? '' : 's'}`),
    h('div', { class: 'grid' },
      num('Flying radius (m)', t, 'radiusM', { min: 50, title: 'Furthest the drones go from the pilots' }),
      num('Flying height AGL (m)', t, 'altM', { min: 1 }),
      txt('Start time', t, 'start', { type: 'time' }),
      txt('End time', t, 'end', { type: 'time' })),
    h('details', null, h('summary', { class: 'muted small-text' }, 'Advanced: spacing and antenna height'),
      h('div', { class: 'grid', style: 'margin-top:6px' },
        num('Takeoff spacing (m)', t, 'launchSepM', { min: 2, title: 'Closest a teammate takes off or lands (at takeoff power) to another pilot\'s goggles' }),
        num('In-flight spacing (m)', t, 'flightSepM', { min: 2, title: 'Closest a teammate\'s airborne drone (at flight power) gets to another pilot\'s goggles' }),
        num('Pilot antenna height (m)', t, 'pilotHeightM', { min: 0.5 }))),
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

function addTeam() {
  const t = newTeam(state);
  const name = h('input', { value: t.name, 'aria-label': 'Team name' });
  const coord = h('input', { class: 'coord-input', placeholder: 'e.g. 11S KC 79808 48321  or  38.3560, -119.5200', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Launch point' });
  const preview = h('div', { class: 'coord-preview' }, 'MGRS, decimal lat/long, or degrees-minutes-seconds (38°21\'22"N 119°31\'12"W).');
  let parsed = null;
  coord.oninput = () => {
    const v = coord.value.trim();
    parsed = null;
    if (!v) { preview.className = 'coord-preview'; preview.textContent = ''; return; }
    try {
      parsed = parseCoord(v);
      const far = farNote(parsed);
      preview.className = `coord-preview ${far ? 'bad' : 'ok'}`;
      preview.textContent = (parsed.kind === 'MGRS' ? `✓ MGRS → ${fmtLatLon(parsed.lat, parsed.lon)}` : `✓ lat/long → ${toMgrs(parsed.lat, parsed.lon) ?? 'outside MGRS area'}`) + far;
    } catch (e) { preview.className = 'coord-preview bad'; preview.textContent = e.message; }
  };
  const create = () => { t.name = name.value.trim() || t.name; state.teams.push(t); ui.selectedTeam = t.id; $('#dlg').close(); };
  const addBtn = h('button', {
    class: 'primary', type: 'button', onclick: () => {
      if (!parsed) { coord.oninput(); if (!parsed) { coord.focus(); preview.className = 'coord-preview bad'; preview.textContent ||= 'Enter a launch point, or use “Pick on map”.'; return; } }
      Object.assign(t, { lat: parsed.lat, lon: parsed.lon });
      create();
      getMap().setView([t.lat, t.lon], Math.max(getMap().getZoom(), 13));
      commit();
    },
  }, 'Add team');
  coord.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); } };
  dialog('Add team', h('div', null,
    h('label', { class: 'f' }, 'Team name', name),
    h('label', { class: 'f', style: 'margin-top:10px' }, 'Launch point', coord), preview,
    h('div', { class: 'muted small-text', style: 'margin-top:8px' }, 'The launch point is where the team\'s pilots stand and their aircraft take off.')), [
    h('button', { type: 'button', onclick: () => { create(); save(state); render(); startPlacing('team', t.id, `${t.name}'s launch point`); } }, '📍 Pick on map'),
    addBtn]);
  setTimeout(() => coord.focus(), 50);
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

function renderResultsTab() {
  const out = [h('h3', null, 'Channel plan')];
  out.push(h('div', { class: 'row' },
    h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: ui.optimizePower, onchange: e => { ui.optimizePower = e.target.checked; } }), 'Also adjust in-flight VTX power'),
    h('button', { class: 'primary', onclick: runSolve, disabled: ui.solving }, ui.solving ? 'Solving…' : 'Solve')));
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
    const why = r.mN < r.mI - 3 || !top ? range : contribText(top, scn.nodes, i) + (r.mN < 3 ? ' + range' : '');
    return h('tr', null,
      h('td', null, h('span', { class: 'swatch', style: `background:${n.team.color};margin-right:4px;vertical-align:-2px` }), n.drone.callsign, n.drone.pilot ? h('span', { class: 'muted' }, ` ${n.drone.pilot}`) : null),
      h('td', null, h('b', null, c.name), ` ${c.freq}`),
      h('td', { title: 'takeoff → flight' }, `${powerLabel(n.vtx, n.tIdx, n.drone.firmware)} → ${powerLabel(n.vtx, plan.pIdx[i], n.drone.firmware)}`),
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
        num('Required SIR (dB)', r, 'reqSirDb'), num('Required SNR (dB)', r, 'reqSnrDb')),
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
        h('button', { class: 'small danger', onclick: () => { state.emitters = state.emitters.filter(x => x !== e); commit(); } }, '✕')),
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
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
