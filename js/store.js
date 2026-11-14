import { VTX_PRESETS, RECEIVER_PRESETS, SITES, TEAM_COLORS } from './data.js';
import { dest } from './geo.js';

const KEY = 'fpv-chanplan-v1';
export const VERSION = 2;
export const uid = (p = 'id') => `${p}_${Math.random().toString(36).slice(2, 9)}`;
export const clone = o => JSON.parse(JSON.stringify(o));

export const templateKey = v => `${v.brand} ${v.model}`;
export const TEMPLATES = VTX_PRESETS;

// A drone's own VTX record, started from a template; replaced by an uploaded table later.
export function vtxFromTemplate(key) {
  const t = TEMPLATES.find(v => templateKey(v) === key) || TEMPLATES[0];
  return { ...clone(t), template: templateKey(t), source: 'template', uploadedAt: null };
}

const lastUsable = v => { for (let i = v.powers.length - 1; i >= 0; i--) if (v.powers[i].mW) return i; return 0; };
const firstUsable = v => Math.max(0, v.powers.findIndex(p => p.mW));

export function newDrone(state, teamId) {
  const team = state.teams.find(t => t.id === teamId);
  const mates = state.drones.filter(d => d.teamId === teamId);
  const prefix = (team?.name || 'D').replace(/^Team\s+/i, '').replace(/\s+/g, '').slice(0, 4) || 'D';
  const callsign = `${prefix}${mates.length + 1}`;
  const prev = mates[mates.length - 1];
  if (prev) { // same team usually flies the same kit — copy it
    return { ...clone(prev), id: uid('d'), callsign, pilot: '', assign: null, locked: false, active: true, target: null, powerPlanned: false,
      vtx: { ...clone(prev.vtx), source: prev.vtx.source === 'uploaded' ? 'copied' : prev.vtx.source, copiedFrom: prev.callsign } };
  }
  const vtx = vtxFromTemplate(templateKey(TEMPLATES[0]));
  return {
    id: uid('d'), callsign, pilot: '', teamId, vtx, firmware: 'betaflight', receiverId: state.receivers[0]?.id,
    takeoffPowerIdx: firstUsable(vtx), flightPowerIdx: lastUsable(vtx), powerLocked: false, switchCh: null,
    txGainDbi: 2, txPol: 'RHCP', rxGainDbi: 2, rxPol: 'RHCP', freqOffsetMHz: 0,
    assign: null, locked: false, active: true, maxRangeM: null,
    flightMode: 'manual', target: null,
  };
}

export function newTeam(state, at) {
  const i = state.teams.length;
  return {
    id: uid('t'), name: `Team ${String.fromCharCode(65 + (i % 26))}`, color: TEAM_COLORS[i % TEAM_COLORS.length],
    lat: at?.lat ?? null, lon: at?.lon ?? null, radiusM: 800, altM: 60, pilotHeightM: 1.5,
    launchSepM: 20, flightSepM: 100, start: '', end: '',
    route: [], rtl: true, corridorM: 150, pilotTrack: [], switchM: 150,
  };
}

export function emptyMission(siteKey = 'mwtc') {
  const site = SITES[siteKey];
  return {
    version: VERSION,
    mission: { name: 'New mission', site: siteKey, envNoiseDb: site.envNoiseDb, nlosExtraDb: site.nlosExtraDb, fadeMarginDb: 6, bandFilter: [], notes: '' },
    receivers: RECEIVER_PRESETS.map(r => ({ id: uid('rx'), ...clone(r) })),
    teams: [], drones: [], emitters: [],
  };
}

// Washington DC example: three teams converge on Hains Point along the rivers.
// Places from OpenStreetMap; routes follow the Potomac / Anacostia centerlines.
function dcExample() {
  const s = emptyMission('dc');
  s.mission.name = 'DC — Hains Point convergence (example)';
  s.mission.notes = 'Example plan: three teams fly to Hains Point at the same time and are recovered there (no return leg); pilots move along the shore with their aircraft. Accotink team (~32 km, pilots leapfrog north along the Virginia shore) is long-range — check aircraft endurance. All routes are inside the DC FRZ and near DCA approaches: flying requires FAA/TSA authorization and coordination.';
  const T = key => TEMPLATES.find(v => templateKey(v).includes(key));
  const R = txt => s.receivers.find(r => r.name.includes(txt)).id;
  const W = (pts, alt) => pts.map(([lat, lon]) => ({ id: uid('w'), lat, lon, altM: alt }));
  const P = pts => pts.map(([lat, lon]) => ({ id: uid('w'), lat, lon }));
  const hains = [38.85774, -77.02237];
  const teams = [
    {
      name: 'Accotink', color: '#e6194b', at: [38.7085, -77.1700], altM: 100, pilotHeightM: 3, rtl: false, corridorM: 200,
      route: W([[38.70, -77.1617], [38.686, -77.156], [38.68863, -77.11123], [38.69499, -77.08244], [38.70189, -77.05686],
        [38.71703, -77.03463], [38.73762, -77.0366], [38.76493, -77.0327], [38.78711, -77.0366], [38.822, -77.03], hains], 100),
      // pilots leapfrog north along the Virginia shore, keeping line of sight past the bluffs:
      // Fort Belvoir South Post shore, Fort Hunt Park, GW Parkway near Southdown Rd, Belle Haven Park, Jones Point Park, Daingerfield Island, Gravelly Point
      pilotTrack: P([[38.6935, -77.1500], [38.71466, -77.05319], [38.745, -77.047], [38.77905, -77.05102], [38.79326, -77.04264], [38.83118, -77.04124], [38.86504, -77.03951]]),
      aircraft: [
        { vtx: 'Foxeer Reaper Extreme', fw: 'ardupilot', mode: 'auto', rx: 'Rapidfire', rxGain: 12, flightMw: 2500, pilot: 'Ramirez', target: true },
        { vtx: 'RushFPV Max Solo', fw: 'inav', mode: 'auto', rx: 'TBS Fusion', rxGain: 12, flightMw: 1600, pilot: 'Okafor' },
        { vtx: 'RushFPV Max Solo', fw: 'betaflight', mode: 'manual', rx: 'Rapidfire', rxGain: 12, flightMw: 1600, pilot: 'Nguyen' },
      ],
    },
    {
      name: 'Little Island', color: '#3cb44b', at: [38.89112, -77.05986], altM: 60, pilotHeightM: 1.5, rtl: false, corridorM: 120,
      route: W([[38.89226, -77.05731], [38.88282, -77.0521], [38.87688, -77.0441], [38.8704, -77.03498], [38.86274, -77.02875], hains], 60),
      pilotTrack: P([[38.87559, -77.02653], [38.8625, -77.0245]]), // pilots move down Ohio Drive, East Potomac Park (mini golf, then the Blue Course)
      aircraft: [
        { vtx: 'GEPRC 5.8G 1.6W', fw: 'betaflight', mode: 'manual', rx: 'Generic analog', rxGain: 8, flightMw: 800, pilot: 'Hayes' },
        { vtx: 'TBS Unify Pro32 HV', fw: 'betaflight', mode: 'manual', rx: 'SteadyView', rxGain: 8, flightMw: 1000, pilot: 'Petrov' },
        { vtx: 'Foxeer Reaper Extreme', fw: 'inav', mode: 'manual', rx: 'Rapidfire', rxGain: 8, flightMw: 1500, pilot: 'Castillo' },
      ],
    },
    {
      name: 'Heritage Island', color: '#4363d8', at: [38.89237, -76.96627], altM: 60, pilotHeightM: 1.5, rtl: false, corridorM: 150, pol: 'LHCP',
      route: W([[38.89197, -76.96318], [38.88353, -76.96913], [38.87675, -76.97807], [38.87168, -76.98976], [38.87115, -77.00242], [38.86291, -77.0097], [38.85633, -77.01933], hains], 60),
      pilotTrack: P([[38.87336, -76.9834], [38.87318, -77.0015], [38.86488, -77.01069]]), // Anacostia Park, Yards Park, Buzzard Point Park
      aircraft: [
        { vtx: 'Divimath HDZero Freestyle', fw: 'betaflight', mode: 'manual', rx: 'HDZero', rxGain: 8, flightMw: 1000, pilot: 'Brennan', target: true },
        { vtx: 'Divimath HDZero Freestyle', fw: 'betaflight', mode: 'manual', rx: 'HDZero', rxGain: 8, flightMw: 1000, pilot: 'Ito' },
        { vtx: 'GEPRC 5.8G 1.6W', fw: 'ardupilot', mode: 'auto', rx: 'Rapidfire', rxGain: 8, flightMw: 1600, pilot: 'Walsh' },
      ],
    },
  ];
  for (const spec of teams) {
    const t = Object.assign(newTeam(s, { lat: spec.at[0], lon: spec.at[1] }), {
      name: spec.name, color: spec.color, altM: spec.altM, pilotHeightM: spec.pilotHeightM, rtl: spec.rtl, corridorM: spec.corridorM,
      route: spec.route, pilotTrack: spec.pilotTrack,
    });
    s.teams.push(t);
    const prefix = spec.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || 'T';
    spec.aircraft.forEach((a, k) => {
      const d = newDrone({ ...s, drones: [] }, t.id);
      d.callsign = `${prefix === 'A' ? 'AK' : prefix}${k + 1}`;
      d.pilot = a.pilot;
      d.vtx = vtxFromTemplate(templateKey(T(a.vtx)));
      d.takeoffPowerIdx = firstUsable(d.vtx);
      const near = d.vtx.powers.reduce((best, p, i) => p.mW && Math.abs(p.mW - a.flightMw) < Math.abs((d.vtx.powers[best].mW ?? 1e9) - a.flightMw) ? i : best, lastUsable(d.vtx));
      d.flightPowerIdx = near;
      d.firmware = a.fw; d.flightMode = a.mode;
      d.receiverId = R(a.rx); d.rxGainDbi = a.rxGain;
      if (spec.pol) { d.txPol = spec.pol; d.rxPol = spec.pol; }
      if (a.target) d.target = { id: uid('g'), lat: hains[0], lon: hains[1], altM: spec.altM, loiterM: 200, loiterMin: 5 };
      s.drones.push(d);
    });
  }
  s.emitters.push({ id: uid('e'), name: 'Wi-Fi APs at The Wharf (example)', lat: 38.87869, lon: -77.02376, heightM: 10, freqMHz: 5775, bwMHz: 80, eirpDbm: 30 });
  return s;
}

export function exampleMission(siteKey = 'mwtc') {
  const s = emptyMission(siteKey);
  if (siteKey === 'dc') return dcExample();
  const site = SITES[siteKey];
  s.mission.name = siteKey === 'dc' ? 'DC example' : 'MWTC example';
  const c = { lat: site.lat, lon: site.lon };
  const spots = siteKey === 'dc' ? [[0, 0], [70, 2500], [200, 3200]] : [[0, 0], [60, 3500], [200, 5000]];
  const findT = txt => templateKey(TEMPLATES.find(v => templateKey(v).includes(txt)));
  const findR = txt => s.receivers.find(r => r.name.includes(txt)).id;
  const plan = [
    ['TBS Unify Pro32 HV', 'TBS Unify Pro32 HV', 'RushFPV Tank Ultimate', 'Foxeer Reaper Extreme'],
    ['GEPRC 5.8G 1.6W', 'GEPRC 5.8G 800mW', 'RushFPV Max Solo', 'Foxeer Reaper Nano'],
    ['Divimath HDZero Freestyle', 'Divimath HDZero Race', 'TBS Unify Pro32 Nano', 'Fatshark Legacy'],
  ];
  const pilots = ['Alvarez', 'Brooks', 'Chen', 'Diaz', 'Evans', 'Foster', 'Garcia', 'Hughes', 'Ito', 'Jones', 'Kim', 'Lopez'];
  spots.forEach(([brg, d], ti) => {
    const t = newTeam(s, dest(c, brg, d));
    s.teams.push(t);
    plan[ti].forEach((name, k) => {
      const dr = { ...newDrone({ ...s, drones: [] }, t.id), callsign: `${t.name.split(' ')[1]}${k + 1}`, pilot: pilots[ti * 4 + k] };
      dr.vtx = vtxFromTemplate(findT(name));
      dr.takeoffPowerIdx = firstUsable(dr.vtx);
      dr.flightPowerIdx = lastUsable(dr.vtx);
      dr.receiverId = dr.vtx.type === 'digital' ? findR('HDZero') : (k % 2 ? findR('Rapidfire') : findR('Generic analog'));
      if (k === 3 && ti === 2) dr.receiverId = findR('Fatshark');
      if (ti === 1 && k === 1) dr.firmware = 'ardupilot';
      if (ti === 2 && k === 2) dr.firmware = 'inav';
      s.drones.push(dr);
    });
  });
  if (siteKey === 'mwtc') { // a short route, moving pilots and one target so the route features are visible
    const A = s.teams[0];
    A.route = [[10, 1200, 80], [25, 2400, 100], [40, 3300, 100]].map(([b, dm, alt]) => ({ id: uid('w'), ...dest(A, b, dm), altM: alt }));
    A.pilotTrack = [{ id: uid('w'), ...dest(A, 20, 900) }];
    const a1 = s.drones.find(d => d.teamId === A.id);
    a1.target = { id: uid('g'), ...dest(A, 55, 3000), altM: 120, loiterM: 200, loiterMin: 5 };
    a1.flightMode = 'manual';
  }
  if (siteKey === 'dc') s.emitters.push({ id: uid('e'), name: 'Wi-Fi AP ch157 (example)', lat: c.lat + 0.004, lon: c.lon + 0.006, heightM: 15, freqMHz: 5785, bwMHz: 80, eirpDbm: 30 });
  return s;
}

// Upgrade a saved mission (v1 kept a shared VTX library and a single power).
// Fill in fields added after a mission was saved (routes, pilot tracks, targets, new goggle presets).
function normalize(s) {
  for (const r of RECEIVER_PRESETS) if (!s.receivers.some(x => x.name === r.name)) s.receivers.push({ id: uid('rx'), ...clone(r) });
  for (const t of s.teams) {
    t.route ??= []; t.pilotTrack ??= []; t.rtl ??= true; t.corridorM ??= 150; t.switchM ??= 150;
    for (const w of [...t.route, ...t.pilotTrack]) w.id ??= uid('w');
    for (const w of t.route) w.type ??= 'wp';
  }
  for (const d of s.drones) { d.flightMode ??= 'manual'; d.target ??= null; if (d.target) d.target.id ??= uid('g'); }
  return s;
}

export function migrate(s) {
  if (!s || !Array.isArray(s.drones)) return null;
  if (s.version === VERSION) return normalize(s);
  if (s.version !== 1) return null;
  const models = new Map((s.vtxModels || []).map(v => [v.id, v]));
  for (const d of s.drones) {
    const m = models.get(d.vtxModelId);
    d.vtx = m ? { ...clone(m), template: templateKey(m), source: m.source === 'imported' ? 'uploaded' : 'template' } : vtxFromTemplate(templateKey(TEMPLATES[0]));
    delete d.vtx.id;
    d.flightPowerIdx = d.powerIdx ?? lastUsable(d.vtx);
    d.takeoffPowerIdx = firstUsable(d.vtx);
    d.pilot = d.pilot || '';
    delete d.powerIdx; delete d.vtxModelId;
  }
  for (const t of s.teams) { t.launchSepM = t.intraSepM ?? 20; t.flightSepM = 100; delete t.intraSepM; }
  delete s.vtxModels;
  s.version = VERSION;
  return normalize(s);
}

export function load() {
  try { return migrate(JSON.parse(localStorage.getItem(KEY))); } catch { return null; }
}
export function save(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage full or blocked */ }
}
