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
    return { ...clone(prev), id: uid('d'), callsign, pilot: '', assign: null, locked: false, active: true,
      vtx: { ...clone(prev.vtx), source: prev.vtx.source === 'uploaded' ? 'copied' : prev.vtx.source, copiedFrom: prev.callsign } };
  }
  const vtx = vtxFromTemplate(templateKey(TEMPLATES[0]));
  return {
    id: uid('d'), callsign, pilot: '', teamId, vtx, firmware: 'betaflight', receiverId: state.receivers[0]?.id,
    takeoffPowerIdx: firstUsable(vtx), flightPowerIdx: lastUsable(vtx), powerLocked: false, switchCh: null,
    txGainDbi: 2, txPol: 'RHCP', rxGainDbi: 2, rxPol: 'RHCP', freqOffsetMHz: 0,
    assign: null, locked: false, active: true, maxRangeM: null,
  };
}

export function newTeam(state, at) {
  const i = state.teams.length;
  return {
    id: uid('t'), name: `Team ${String.fromCharCode(65 + (i % 26))}`, color: TEAM_COLORS[i % TEAM_COLORS.length],
    lat: at?.lat ?? null, lon: at?.lon ?? null, radiusM: 800, altM: 60, pilotHeightM: 1.5,
    launchSepM: 20, flightSepM: 100, start: '', end: '',
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

export function exampleMission(siteKey = 'mwtc') {
  const s = emptyMission(siteKey);
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
  if (siteKey === 'dc') s.emitters.push({ id: uid('e'), name: 'Wi-Fi AP ch157 (example)', lat: c.lat + 0.004, lon: c.lon + 0.006, heightM: 15, freqMHz: 5785, bwMHz: 80, eirpDbm: 30 });
  return s;
}

// Upgrade a saved mission (v1 kept a shared VTX library and a single power).
export function migrate(s) {
  if (!s || !Array.isArray(s.drones)) return null;
  if (s.version === VERSION) return s;
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
  return s;
}

export function load() {
  try { return migrate(JSON.parse(localStorage.getItem(KEY))); } catch { return null; }
}
export function save(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage full or blocked */ }
}
