// Parse / serialize Betaflight VTX tables (CLI `vtxtable` dump and configurator JSON).

export function labelToMw(label, value) {
  const s = String(label ?? '').trim().toUpperCase();
  let m = s.match(/^([\d.]+)\s*(MW|W)?$/);
  if (m) {
    const n = parseFloat(m[1]);
    if (m[2] === 'W' || (!m[2] && n < 10 && s.includes('.'))) return Math.round(n * 1000);
    if (!m[2] && n <= 5) return Math.round(n * 1000); // "1", "2" usually mean watts
    return Math.round(n);
  }
  // Fall back to numeric value: SmartAudio 2.1 uses dBm, Tramp uses mW.
  const v = Number(value);
  if (Number.isFinite(v) && v > 0) return v <= 40 ? Math.round(10 ** (v / 10)) : Math.round(v);
  return null; // e.g. "PIT", "MAX"
}

export function parseCli(text) {
  const bands = [];
  let labels = [], values = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^#\s*/, '');
    const t = line.split(/\s+/);
    if (t[0] !== 'vtxtable') continue;
    if (t[1] === 'band') {
      const idx = parseInt(t[2], 10) - 1;
      const name = t[3], letter = t[4], factory = (t[5] || '').toUpperCase() === 'FACTORY';
      const freqs = t.slice(6).map(Number).filter(n => Number.isFinite(n));
      bands[idx] = { name, letter, factory, freqs };
    } else if (t[1] === 'powervalues') values = t.slice(2);
    else if (t[1] === 'powerlabels') labels = t.slice(2);
  }
  const n = Math.max(labels.length, values.length);
  const powers = [];
  for (let i = 0; i < n; i++) {
    powers.push({ label: (labels[i] ?? values[i] ?? '').trim(), value: values[i] ?? null, mW: labelToMw(labels[i], values[i]) });
  }
  const clean = bands.filter(Boolean);
  if (!clean.length) throw new Error('No `vtxtable band` lines found.');
  return { bands: clean, powers };
}

export function parseJson(obj) {
  const vt = obj.vtx_table || obj;
  if (!vt.bands_list) throw new Error('Not a Betaflight VTX table JSON (missing vtx_table.bands_list).');
  const bands = vt.bands_list.map(b => ({
    name: b.name, letter: b.letter, factory: !!b.is_factory_band, freqs: b.frequencies.map(Number),
  }));
  const powers = (vt.powerlevels_list || []).map(p => ({ label: String(p.label).trim(), value: p.value, mW: labelToMw(p.label, p.value) }));
  return { bands, powers };
}

export function parseAny(text) {
  const s = text.trim();
  if (s.startsWith('{')) return parseJson(JSON.parse(s));
  return parseCli(s);
}

export function toCli(vtx) {
  const chans = Math.max(...vtx.bands.map(b => b.freqs.length));
  const out = [
    `vtxtable bands ${vtx.bands.length}`,
    `vtxtable channels ${chans}`,
    ...vtx.bands.map((b, i) => `vtxtable band ${i + 1} ${b.name} ${b.letter} ${b.factory ? 'FACTORY' : 'CUSTOM'} ${b.freqs.join(' ')}`),
    `vtxtable powerlevels ${vtx.powers.length}`,
    `vtxtable powervalues ${vtx.powers.map(p => p.value ?? p.mW ?? 0).join(' ')}`,
    `vtxtable powerlabels ${vtx.powers.map(p => String(p.label).replace(/\s+/g, '').slice(0, 3)).join(' ')}`,
  ];
  return out.join('\n');
}

// All usable channels for a VTX: [{bandIdx, chIdx, freq, name}]; duplicate frequencies keep first.
export function channelsOf(vtx) {
  const seen = new Set(), out = [];
  vtx.bands.forEach((b, bi) => b.freqs.forEach((f, ci) => {
    if (!f || seen.has(f)) return;
    seen.add(f);
    out.push({ bandIdx: bi, chIdx: ci, freq: f, name: `${b.letter}${ci + 1}` });
  }));
  return out;
}

export function chanName(vtx, bandIdx, chIdx) {
  const b = vtx?.bands[bandIdx];
  return b ? `${b.letter}${chIdx + 1}` : '?';
}
