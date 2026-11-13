// Flight-controller firmware VTX support. Tables verified against source (Nov 2026):
//  INAV:      src/main/io/vtx_string.c, io/vtx_tramp.c, io/vtx_msp.c, fc/settings.yaml
//  ArduPilot: libraries/AP_VideoTX/AP_VideoTX.cpp
// Betaflight uses the VTX's own vtxtable, so it has no fixed table here.

const A = [5865, 5845, 5825, 5805, 5785, 5765, 5745, 5725];
const B = [5733, 5752, 5771, 5790, 5809, 5828, 5847, 5866];
const E = [5705, 5685, 5665, 5645, 5885, 5905, 5925, 5945];
const F = [5740, 5760, 5780, 5800, 5820, 5840, 5860, 5880];
const R = [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917];
const L = [5362, 5399, 5436, 5473, 5510, 5547, 5584, 5621];
const G13A = [1080, 1120, 1160, 1200, 1240, 1280, 1320, 1360];
const G13B = [1080, 1120, 1160, 1200, 1258, 1280, 1320, 1360];

// INAV: vtx_band 1..5, vtx_channel 1..8 (1-based). 1.3 GHz needs vtx_frequency_group = FREQUENCYGROUP_1G3.
const INAV_58 = [['A', A], ['B', B], ['E', E], ['F', F], ['R', R]];
const INAV_1G3 = [['A', G13A], ['B', G13B]];

// ArduPilot: VTX_BAND 0..10, VTX_CHANNEL 0..7 (0-based), VTX_POWER in mW.
export const AP_BANDS = [
  ['A', 'Band A', A], ['B', 'Band B', B], ['E', 'Band E', E], ['F', 'Airwave', F], ['R', 'RaceBand', R], ['L', 'Low RaceBand', L],
  ['1G3_A', '1G3 Band A', G13A], ['1G3_B', '1G3 Band B', G13B],
  ['X', 'Band X', [4990, 5020, 5050, 5080, 5110, 5140, 5170, 5200]],
  ['3G3_A', '3G3 Band A', [3330, 3350, 3370, 3390, 3410, 3430, 3450, 3470]],
  ['3G3_B', '3G3 Band B', [3170, 3190, 3210, 3230, 3250, 3270, 3290, 3310]],
];
const AP_POWERS = [25, 100, 200, 400, 500, 600, 800, 1000]; // VTX_POWER rounds down to a supported level

const INAV_TRAMP_58 = max => max >= 800 ? [25, 100, 200, 500, 800] : max >= 600 ? [25, 100, 200, 400, 600] : max >= 400 ? [25, 100, 200, 400] : max >= 200 ? [25, 100, 200] : [25, 100, 200, 400, 600];
const INAV_TRAMP_1G3 = max => max >= 2000 ? [25, 200, 2000] : [25, 200, 800];
const INAV_MSP = [25, 200, 500, 1000]; // vtx_power 1..4

export const FIRMWARES = {
  betaflight: { name: 'Betaflight' },
  inav: { name: 'INAV' },
  ardupilot: { name: 'ArduPilot' },
};

const find = (bands, f) => { for (let b = 0; b < bands.length; b++) { const c = bands[b][bands[b].length - 1].indexOf(f); if (c >= 0) return { b, c }; } return null; };

// Firmware-native band/channel for a frequency, or null if that firmware cannot command it.
export function fwLookup(fw, freq) {
  if (fw === 'inav') {
    let r = find(INAV_58, freq);
    if (r) return { band: r.b + 1, channel: r.c + 1, label: `${INAV_58[r.b][0]}${r.c + 1}`, group: 'FREQUENCYGROUP_5G8' };
    r = find(INAV_1G3, freq);
    if (r) return { band: r.b + 1, channel: r.c + 1, label: `1G3 ${INAV_1G3[r.b][0]}${r.c + 1}`, group: 'FREQUENCYGROUP_1G3' };
    return null;
  }
  if (fw === 'ardupilot') {
    const r = find(AP_BANDS, freq);
    return r ? { band: r.b, channel: r.c, label: `${AP_BANDS[r.b][1]} ch${r.c + 1}` } : null;
  }
  return { native: true };
}
export const fwSupports = (fw, freq) => !!fwLookup(fw || 'betaflight', freq);

const roundDown = (list, mw) => { let best = null; for (const v of list) if (v <= mw) best = v; return best ?? list[0]; };
const maxMw = vtx => Math.max(0, ...vtx.powers.map(p => p.mW || 0));
const is1G3 = vtx => vtx.bands.some(b => b.freqs.some(f => f > 0 && f < 2000));

function inavTable(vtx) {
  const proto = (vtx.protocol || '').toLowerCase();
  if (proto.includes('tramp')) return is1G3(vtx) ? INAV_TRAMP_1G3(maxMw(vtx)) : INAV_TRAMP_58(maxMw(vtx));
  if (proto.includes('msp') || vtx.type === 'digital') return INAV_MSP;
  return null; // SmartAudio 2.1: the VTX reports its own list, same order as its vtxtable
}

// The mW the VTX will actually transmit when this firmware is asked for `mw`.
export function fwPowerMw(fw, vtx, mw) {
  if (mw == null) return null;
  if (fw === 'ardupilot') return roundDown(AP_POWERS, Math.min(mw, 1000));
  if (fw === 'inav') { const t = inavTable(vtx); return t ? roundDown(t, mw) : mw; }
  return mw;
}

// Firmware power setting for a planned power index. Returns {value, note}.
export function fwPowerSetting(fw, vtx, idx) {
  const mw = vtx.powers[idx]?.mW;
  if (fw === 'ardupilot') {
    const v = fwPowerMw(fw, vtx, mw);
    return { value: v, note: mw > 1000 ? 'ArduPilot VTX_POWER max is 1000 mW' : v !== mw ? `rounds down from ${mw} mW` : '' };
  }
  if (fw === 'inav') {
    const t = inavTable(vtx);
    if (!t) return { value: idx + 1, note: `power level ${idx + 1} as reported by the VTX — confirm it is ${mw} mW in the OSD/Configurator` };
    const v = roundDown(t, mw);
    return { value: t.indexOf(v) + 1, note: `${v} mW in INAV's ${(vtx.protocol || 'MSP')} table` };
  }
  return { value: idx + 1, note: '' };
}
