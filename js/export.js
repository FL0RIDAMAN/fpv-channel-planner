import { chanName } from './vtxtable.js';
import { toMgrs } from './coords.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

import { FIRMWARES, fwLookup, fwPowerMw, fwPowerSetting } from './firmware.js';

const fmtMw = m => m >= 1000 ? `${m / 1000} W` : `${m} mW`;

// fw (optional): show what that firmware will actually transmit.
export function powerLabel(vtx, idx, fw) {
  const p = vtx?.powers[idx];
  if (!p) return '?';
  if (p.mW == null) return p.label;
  const eff = fw ? fwPowerMw(fw, vtx, p.mW) : p.mW;
  return eff !== p.mW ? `${fmtMw(eff)}*` : fmtMw(p.mW);
}

function droneBlock(d, team) {
  const v = d.vtx;
  const fw = d.firmware || 'betaflight';
  const who = d.pilot ? ` — pilot ${d.pilot}` : '';
  const head = `${d.callsign} (${team?.name ?? '?'})${who} — ${v?.brand} ${v?.model} — ${FIRMWARES[fw].name}`;
  if (!v || !d.assign) return { fw, lines: [`# ${head}`, '#   NOT ASSIGNED — run Solve'] };
  const f = v.bands[d.assign.bandIdx]?.freqs[d.assign.chIdx];
  const ch = chanName(v, d.assign.bandIdx, d.assign.chIdx);
  const to = fwPowerSetting(fw, v, d.takeoffPowerIdx), fl = fwPowerSetting(fw, v, d.flightPowerIdx);
  const toL = powerLabel(v, d.takeoffPowerIdx, fw), flL = powerLabel(v, d.flightPowerIdx, fw);
  const sw = d.switchCh >= 5 && d.switchCh <= 16 ? d.switchCh : null;
  const lines = [`# ${head}`, `#   ${ch} ${f} MHz · takeoff ${toL} → flight ${flL}`];
  if (fw === 'betaflight') {
    lines.push(`set vtx_band = ${d.assign.bandIdx + 1}`, `set vtx_channel = ${d.assign.chIdx + 1}`, `set vtx_power = ${to.value}`);
    if (sw) {
      lines.push(`# power switch on RC channel ${sw} (AUX${sw - 4}): low = takeoff, high = flight`,
        `vtx 0 ${sw - 5} 0 0 ${to.value} 900 1500`, `vtx 1 ${sw - 5} 0 0 ${fl.value} 1525 2100`);
    } else lines.push(`#   after takeoff raise to power level ${fl.value} (${flL}) — OSD menu, radio VTX menu, or set a power switch in the planner`);
    lines.push('save');
  } else if (fw === 'inav') {
    const n = fwLookup('inav', f);
    if (!n) return { fw, lines: [...lines, `#   ERROR: ${f} MHz is not in INAV's band table — re-solve`] };
    if (to.note) lines.push(`#   takeoff power: ${to.note}`);
    lines.push(`#   after takeoff raise to power level ${fl.value} (${flL})${fl.note ? ` — ${fl.note}` : ''} via OSD menu or an adjustment switch`);
    if (n.group !== 'FREQUENCYGROUP_5G8') lines.push(`set vtx_frequency_group = ${n.group}`);
    lines.push(`set vtx_band = ${n.band}`, `set vtx_channel = ${n.channel}`, `set vtx_power = ${to.value}`, 'save');
  } else if (fw === 'ardupilot') {
    const n = fwLookup('ardupilot', f);
    if (!n) return { fw, lines: [...lines, `#   ERROR: ${f} MHz is not in ArduPilot's band table — re-solve`] };
    lines.push(`#   ${n.label}${to.note ? ` · takeoff ${to.note}` : ''}${fl.note ? ` · flight ${fl.note}` : ''}`);
    lines.push('VTX_ENABLE,1', `VTX_BAND,${n.band}`, `VTX_CHANNEL,${n.channel}`, `VTX_POWER,${to.value}`);
    if (sw) {
      lines.push(`# RC${sw} = VTX power switch (6 positions over 1200-1800 us). Top = VTX_MAX_POWER (flight power).`,
        '# BOTTOM = pit mode (0 mW, no usable video). Middle positions give intermediate levels derived from',
        '# VTX_MAX_POWER — use a 3-position switch, take off in the middle and confirm that level on the OSD.',
        `RC${sw}_OPTION,94`, `VTX_MAX_POWER,${fl.value}`);
    } else lines.push(`#   after takeoff set VTX_POWER to ${fl.value} (OSD parameter menu / GCS), or set a power switch in the planner`);
  }
  return { fw, lines };
}

const FW_HEADERS = {
  betaflight: ['# ===== Betaflight — paste into the CLI tab =====',
    '# band/channel/power indices refer to the quad\'s own vtxtable. If the quad\'s table differs from',
    '# the one in the planner, upload its `vtxtable` on its aircraft card and re-solve.'],
  inav: ['# ===== INAV — paste into the CLI tab =====',
    '# INAV uses its built-in band table (bands 1-5 = A,B,E,F,R; channels 1-8).'],
  ardupilot: ['# ===== ArduPilot — Mission Planner parameter file (NAME,VALUE) =====',
    '# Load per drone: Config > Full Parameter List > Load from file > Write Params, then reboot.',
    '# VTX_BAND / VTX_CHANNEL are 0-based. Serial port setup (SERIALx_PROTOCOL etc.) is not included.'],
};

// droneId: null for all drones
export function firmwareCommands(state, droneId = null) {
  const teams = new Map(state.teams.map(t => [t.id, t]));
  const ds = state.drones.filter(d => d.active && (!droneId || d.id === droneId));
  const groups = { betaflight: [], inav: [], ardupilot: [] };
  for (const d of ds) { const b = droneBlock(d, teams.get(d.teamId)); groups[b.fw].push(b.lines.join('\n')); }
  const out = [`# ${state.mission.name} — generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}Z`, ''];
  for (const fw of Object.keys(groups)) if (groups[fw].length) out.push(...FW_HEADERS[fw], '', groups[fw].join('\n\n'), '');
  return out.join('\n');
}

export function channelCardHtml(state, plan, siteName) {
  const rxs = new Map(state.receivers.map(r => [r.id, r]));
  const resBy = new Map();
  if (plan?.ev) plan.scn.nodes.forEach((n, i) => resBy.set(n.drone.id, plan.ev.res[i]));
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  let html = `<h2>${esc(state.mission.name)} — Channel Card</h2><div>${esc(siteName)} · generated ${stamp}${plan?.ev ? ` · worst margin ${plan.ev.minMargin.toFixed(1)} dB` : ''}</div>`;
  for (const t of state.teams) {
    const ds = state.drones.filter(d => d.teamId === t.id && d.active);
    if (!ds.length) continue;
    html += `<div class="team-block"><h3>${esc(t.name)}</h3><div>Launch point <b>${t.lat != null ? (toMgrs(t.lat, t.lon) ?? '') : 'not set'}</b>${t.lat != null ? ` (${t.lat.toFixed(5)}, ${t.lon.toFixed(5)})` : ''} · radius ${t.radiusM} m · ${t.altM} m AGL${t.start ? ` · ${t.start}–${t.end}` : ''}</div>`;
    const rt = (t.route || []).filter(w => w.lat != null);
    if (rt.length) html += `<div>Route: ${rt.map((w, k) => `${w.type === 'launch' ? 'Launch' : w.type === 'land' ? 'Land' : w.type === 'loiter' ? `Loiter${w.loiterMin ? ` ${w.loiterMin} min` : ''}` : `WP${k + 1}`} ${toMgrs(w.lat, w.lon) ?? ''}${w.type === 'land' ? '' : ` @ ${w.altM ?? t.altM} m AGL`}`).join(' → ')}${t.rtl !== false && !rt.some(w => w.type === 'land') ? ' → RTL' : ''}</div>`;
    const pt = (t.pilotTrack || []).filter(w => w.lat != null);
    if (pt.length) html += `<div>Pilot movement: ${pt.map(w => toMgrs(w.lat, w.lon) ?? '').join(' → ')}</div>`;
    const tg = ds.filter(d => d.target?.lat != null);
    if (tg.length) html += `<div>Targets: ${tg.map(d => `${esc(d.callsign)} ${toMgrs(d.target.lat, d.target.lon) ?? ''}${d.flightMode === 'auto' ? ' (auto)' : ''}`).join(' · ')}</div>`;
    html += '<table><tr><th>Callsign</th><th>Pilot</th><th>VTX</th><th>Channel</th><th>MHz</th><th>Takeoff → flight</th><th>FC</th><th>Receiver</th><th>Margin</th><th>✓</th></tr>';
    for (const d of ds) {
      const v = d.vtx, r = resBy.get(d.id);
      const ch = d.assign && v ? chanName(v, d.assign.bandIdx, d.assign.chIdx) : '—';
      const f = d.assign && v ? v.bands[d.assign.bandIdx]?.freqs[d.assign.chIdx] : '—';
      html += `<tr><td><b>${esc(d.callsign)}</b></td><td>${esc(d.pilot)}</td><td>${esc(v ? `${v.brand} ${v.model}` : '?')}${v?.source === 'uploaded' ? '' : ' <i>(no table uploaded)</i>'}</td><td><b>${ch}</b></td><td>${f}</td><td>${esc(powerLabel(v, d.takeoffPowerIdx, d.firmware))} → ${esc(powerLabel(v, d.flightPowerIdx, d.firmware))}</td><td>${FIRMWARES[d.firmware || 'betaflight'].name}</td><td>${esc(rxs.get(d.receiverId)?.name ?? '?')}</td><td>${r ? r.margin.toFixed(1) + ' dB' : ''}</td><td></td></tr>`;
    }
    html += '</table></div>';
  }
  if (state.mission.notes) html += `<h3>Notes</h3><div>${esc(state.mission.notes)}</div>`;
  html += '<p style="font-size:11px">Planning estimate only. Verify with a goggle/spectrum scan on site before launch.</p>';
  return html;
}

export function downloadText(filename, text, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
