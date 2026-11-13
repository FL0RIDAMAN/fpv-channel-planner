// Preset equipment, sites and reference curves.
// IMPORTANT: VTX presets are approximate templates. The authoritative source for
// any given quad is its own Betaflight `vtxtable` CLI dump — import that to replace
// a preset. Receiver selectivity / IIP3 figures are engineering estimates.

export const STD_BANDS = {
  A: { name: 'BOSCAM_A', letter: 'A', freqs: [5865, 5845, 5825, 5805, 5785, 5765, 5745, 5725] },
  B: { name: 'BOSCAM_B', letter: 'B', freqs: [5733, 5752, 5771, 5790, 5809, 5828, 5847, 5866] },
  E: { name: 'BOSCAM_E', letter: 'E', freqs: [5705, 5685, 5665, 5645, 5885, 5905, 5925, 5945] },
  F: { name: 'FATSHARK', letter: 'F', freqs: [5740, 5760, 5780, 5800, 5820, 5840, 5860, 5880] },
  R: { name: 'RACEBAND', letter: 'R', freqs: [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917] },
  L: { name: 'LOWRACE', letter: 'L', freqs: [5362, 5399, 5436, 5473, 5510, 5547, 5584, 5621] },
};

const bands = (...letters) => letters.map(l => ({ ...STD_BANDS[l], freqs: [...STD_BANDS[l].freqs], factory: true }));
const pw = (...mw) => mw.map(m => ({ label: m >= 1000 ? `${m / 1000}W` : `${m}`, mW: m }));

const TEMPLATE_NOTE = 'Approximate preset — paste this unit\'s Betaflight `vtxtable` dump to replace.';

export const VTX_PRESETS = [
  { brand: 'TBS', model: 'Unify Pro32 HV', type: 'analog', protocol: 'SmartAudio', bandwidthMHz: 18, freqTolMHz: 3, bands: bands('A', 'B', 'E', 'F', 'R'), powers: pw(25, 200, 500, 1000) },
  { brand: 'TBS', model: 'Unify Pro32 Nano', type: 'analog', protocol: 'SmartAudio', bandwidthMHz: 18, freqTolMHz: 3, bands: bands('A', 'B', 'E', 'F', 'R'), powers: pw(25, 100, 200, 400) },
  { brand: 'RushFPV', model: 'Tank Ultimate Plus', type: 'analog', protocol: 'SmartAudio', bandwidthMHz: 18, freqTolMHz: 3, bands: bands('A', 'B', 'E', 'F', 'R', 'L'), powers: pw(25, 400, 800) },
  { brand: 'RushFPV', model: 'Max Solo 1.6W', type: 'analog', protocol: 'SmartAudio', bandwidthMHz: 18, freqTolMHz: 3, bands: bands('A', 'B', 'E', 'F', 'R', 'L'), powers: pw(25, 400, 800, 1600) },
  { brand: 'Foxeer', model: 'Reaper Extreme 2.5W', type: 'analog', protocol: 'SmartAudio', bandwidthMHz: 18, freqTolMHz: 4, bands: bands('A', 'B', 'E', 'F', 'R'), powers: pw(25, 200, 500, 1500, 2500) },
  { brand: 'Foxeer', model: 'Reaper Nano 350mW', type: 'analog', protocol: 'SmartAudio', bandwidthMHz: 18, freqTolMHz: 4, bands: bands('A', 'B', 'E', 'F', 'R'), powers: pw(25, 200, 350) },
  { brand: 'GEPRC', model: '5.8G 1.6W (template)', type: 'analog', protocol: 'SmartAudio', bandwidthMHz: 18, freqTolMHz: 4, bands: bands('A', 'B', 'E', 'F', 'R', 'L'), powers: pw(25, 200, 400, 800, 1600) },
  { brand: 'GEPRC', model: '5.8G 800mW (template)', type: 'analog', protocol: 'SmartAudio', bandwidthMHz: 18, freqTolMHz: 4, bands: bands('A', 'B', 'E', 'F', 'R'), powers: pw(25, 200, 400, 800) },
  { brand: 'Fatshark', model: 'Legacy 600mW (F band, template)', type: 'analog', protocol: 'None', bandwidthMHz: 18, freqTolMHz: 5, bands: bands('F'), powers: pw(600) },
  {
    brand: 'Divimath', model: 'HDZero Freestyle V2 (digital)', type: 'digital', protocol: 'MSP', bandwidthMHz: 27, freqTolMHz: 1,
    bands: [
      { ...STD_BANDS.R, freqs: [...STD_BANDS.R.freqs], factory: true },
      { name: 'FATSHARK', letter: 'F', freqs: [0, 5760, 0, 5800, 0, 0, 0, 0], factory: true },
      { ...STD_BANDS.L, freqs: [...STD_BANDS.L.freqs], factory: true },
    ],
    powers: pw(25, 200, 500, 1000),
    note: 'HDZero is digital but shares the 5.8 GHz band with analog. Bandwidth 27 MHz (≈17 MHz in narrow mode). L-band support depends on VTX + firmware; delete it if unsupported.',
  },
  {
    brand: 'Divimath', model: 'HDZero Race V3 (digital)', type: 'digital', protocol: 'MSP', bandwidthMHz: 27, freqTolMHz: 1,
    bands: [
      { ...STD_BANDS.R, freqs: [...STD_BANDS.R.freqs], factory: true },
      { name: 'FATSHARK', letter: 'F', freqs: [0, 5760, 0, 5800, 0, 0, 0, 0], factory: true },
    ],
    powers: pw(25, 200),
  },
  { brand: 'Other', model: 'Unlisted 5.8 GHz analog (upload table)', type: 'analog', protocol: 'SmartAudio', bandwidthMHz: 18, freqTolMHz: 4, bands: bands('A', 'B', 'E', 'F', 'R', 'L'), powers: pw(25, 200, 500, 1000) },
  {
    brand: 'Generic', model: '1.3 GHz analog (template)', type: 'analog', protocol: 'Tramp', bandwidthMHz: 18, freqTolMHz: 5,
    bands: [{ name: '1G3', letter: 'X', freqs: [1080, 1120, 1160, 1200, 1240, 1280, 1320, 1360], factory: false }],
    powers: pw(200, 800),
  },
].map(v => ({ ...v, note: v.note || TEMPLATE_NOTE, verified: false }));

// Receiver selectivity: rejection (dB) vs effective frequency offset (MHz). Estimates.
export const SELECTIVITY = {
  standard: [[0, 0], [10, 3], [15, 8], [20, 14], [30, 24], [40, 32], [60, 41], [80, 48], [120, 56], [200, 63], [400, 70]],
  improved: [[0, 0], [10, 4], [15, 10], [20, 17], [30, 28], [40, 37], [60, 46], [80, 53], [120, 60], [200, 66], [400, 72]],
  digital:  [[0, 0], [10, 5], [15, 12], [20, 22], [30, 34], [40, 42], [60, 50], [80, 56], [120, 62], [200, 67], [400, 72]],
};

export const RECEIVER_PRESETS = [
  { name: 'Generic analog module (RX5808-class)', type: 'analog', ranges: [[5300, 6000]], noiseFigureDb: 9, selectivity: 'standard', iip3Dbm: -15, reqSirDb: 15, reqSnrDb: 6 },
  { name: 'ImmersionRC Rapidfire', type: 'analog', ranges: [[5300, 6000]], noiseFigureDb: 7, selectivity: 'improved', iip3Dbm: -12, reqSirDb: 12, reqSnrDb: 6 },
  { name: 'TBS Fusion', type: 'analog', ranges: [[5300, 6000]], noiseFigureDb: 7, selectivity: 'improved', iip3Dbm: -12, reqSirDb: 12, reqSnrDb: 6 },
  { name: 'Skyzone SteadyView', type: 'analog', ranges: [[5300, 6000]], noiseFigureDb: 8, selectivity: 'standard', iip3Dbm: -14, reqSirDb: 13, reqSnrDb: 6 },
  { name: 'Fatshark goggle + stock module', type: 'analog', ranges: [[5640, 5950]], noiseFigureDb: 9, selectivity: 'standard', iip3Dbm: -15, reqSirDb: 15, reqSnrDb: 6 },
  { name: 'HDZero Goggle (digital RX)', type: 'digital', ranges: [[5300, 6000]], noiseFigureDb: 6, selectivity: 'digital', iip3Dbm: -10, reqSirDb: 8, reqSnrDb: 5 },
  { name: 'Generic 1.3 GHz analog RX', type: 'analog', ranges: [[1000, 1400]], noiseFigureDb: 8, selectivity: 'standard', iip3Dbm: -15, reqSirDb: 15, reqSnrDb: 6 },
].map(r => ({ ...r, note: 'Selectivity, NF and IIP3 are estimates — tune from field experience.' }));

export const ANTENNAS = [
  { name: 'Omni 2 dBi', gainDbi: 2 },
  { name: 'Patch 8 dBi', gainDbi: 8 },
  { name: 'Helical 12 dBi', gainDbi: 12 },
  { name: 'Dipole 2 dBi (linear)', gainDbi: 2 },
];

export const SITES = {
  mwtc: {
    name: 'MCMWTC Bridgeport (Pickel Meadow)', lat: 38.356, lon: -119.520, zoom: 12,
    envNoiseDb: 0, nlosExtraDb: 0,
    note: 'Mountain terrain — ridgelines give large shielding; expect blocked links behind spurs.',
  },
  dc: {
    name: 'Washington, DC', lat: 38.8895, lon: -77.0353, zoom: 12,
    envNoiseDb: 6, nlosExtraDb: 0,
    note: 'Urban: dense 5.8 GHz Wi-Fi (U-NII-3 overlaps A/B/F bands). DEM is bare-earth — buildings are NOT modeled. Restricted airspace (FRZ/SFRA).',
    overlays: [
      { type: 'circle', lat: 38.8512, lon: -77.0377, radiusM: 24140, label: 'Approx. DC FRZ (~15 mi of DCA) — reference only, verify with FAA', color: '#d33' },
      { type: 'circle', lat: 38.8512, lon: -77.0377, radiusM: 48280, label: 'Approx. DC SFRA (~30 mi of DCA) — reference only', color: '#e90' },
    ],
  },
  custom: { name: 'Custom', lat: 39.0, lon: -98.0, zoom: 5, envNoiseDb: 0, nlosExtraDb: 0, note: '' },
};

export const TEAM_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324'];
