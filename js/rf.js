// RF model: terrain-aware path loss (FSPL + Deygout knife-edge diffraction, 4/3 earth),
// polarization, receiver selectivity, 3rd-order IMD, and SINR per receiver.
import { distM, dest, lerp } from './geo.js';
import { elevationAt } from './terrain.js';
import { SELECTIVITY } from './data.js';
import { channelsOf } from './vtxtable.js';
import { fwSupports, fwPowerMw, FIRMWARES } from './firmware.js';
import { flightPath, flightSamples, pilotSamples, syncedPairs, pathKey } from './paths.js';

const C = 299792458, RE = 8.49e6; // effective earth radius (k = 4/3)
export const REF_F = 5800;
const log10 = Math.log10;
export const dbm = mw => 10 * log10(Math.max(mw, 1e-6));
export const fspl = (dM, fMHz) => 20 * log10(Math.max(dM, 1) / 1000) + 20 * log10(fMHz) + 32.44;
const J = v => v <= -0.78 ? 0 : 6.9 + 20 * log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);

// a, b: {lat, lon, hAgl}. Returns loss in dB and diagnostics.
export function pathLoss(a, b, fMHz = REF_F) {
  const D = distM(a, b);
  const base = fspl(D, fMHz);
  if (D < 60) return { lossDb: base, fsplDb: base, diffDb: 0, los: true, terrain: false, distM: D };
  const n = Math.min(400, Math.max(16, Math.ceil(D / 30)));
  const el = new Float64Array(n + 1);
  for (let k = 0; k <= n; k++) {
    const p = lerp(a, b, k / n);
    const e = elevationAt(p.lat, p.lon);
    if (e === null) return { lossDb: base, fsplDb: base, diffDb: 0, los: true, terrain: false, distM: D };
    el[k] = e;
  }
  const lam = C / (fMHz * 1e6);
  const dist = k => D * k / n;
  const hA = el[0] + a.hAgl, hB = el[n] + b.hAgl;

  function worstEdge(i0, i1, h0, h1) {
    let best = -Infinity, bk = -1;
    const span = dist(i1) - dist(i0);
    for (let k = i0 + 1; k < i1; k++) {
      const d1 = dist(k) - dist(i0), d2 = span - d1;
      const los = h0 + (h1 - h0) * d1 / span;
      const h = el[k] + d1 * d2 / (2 * RE) - los;
      const v = h * Math.sqrt(2 * span / (lam * d1 * d2));
      if (v > best) { best = v; bk = k; }
    }
    return { v: best, k: bk };
  }
  function deygout(i0, i1, h0, h1, depth) {
    if (i1 - i0 < 2) return 0;
    const { v, k } = worstEdge(i0, i1, h0, h1);
    if (v <= -0.78) return 0;
    let L = J(v);
    if (depth > 0) {
      const he = el[k] + 0; // edge top
      L += deygout(i0, k, h0, he, depth - 1) + deygout(k, i1, he, h1, depth - 1);
    }
    return L;
  }
  const main = worstEdge(0, n, hA, hB);
  const diffDb = Math.min(80, deygout(0, n, hA, hB, 1));
  return { lossDb: base + diffDb, fsplDb: base, diffDb, los: main.v <= 0, terrain: true, distM: D, v: main.v };
}

export function polLoss(tx, rx, los) {
  const circ = p => p === 'RHCP' || p === 'LHCP';
  if (circ(tx) && circ(rx)) return tx === rx ? 0 : (los ? 15 : 3);
  if (circ(tx) !== circ(rx)) return 3;
  return 0;
}

export function rejection(curveName, dfEff) {
  const c = SELECTIVITY[curveName] || SELECTIVITY.standard;
  if (dfEff <= 0) return 0;
  if (dfEff >= 400) return 90; // different band entirely; front-end filtering
  for (let i = 1; i < c.length; i++) {
    if (dfEff <= c[i][0]) {
      const [x0, y0] = c[i - 1], [x1, y1] = c[i];
      return y0 + (y1 - y0) * (dfEff - x0) / (x1 - x0);
    }
  }
  return c[c.length - 1][1];
}

const toMin = s => { if (!s) return null; const [h, m] = s.split(':').map(Number); return h * 60 + (m || 0); };
export function timeOverlap(a, b) {
  const as = toMin(a.start), ae = toMin(a.end), bs = toMin(b.start), be = toMin(b.end);
  if (as === null || ae === null || bs === null || be === null) return true;
  const norm = (s, e) => e <= s ? [s, e + 1440] : [s, e];
  const [a0, a1] = norm(as, ae), [b0, b1] = norm(bs, be);
  return a0 < b1 && b0 < a1;
}

function circleSamples(team) {
  const c = { lat: team.lat, lon: team.lon };
  const pts = [c];
  const r = Math.max(10, team.radiusM);
  for (let k = 0; k < 12; k++) pts.push(dest(c, k * 30, r));
  pts.push(...[0, 60, 120, 180, 240, 300].map(b => dest(c, b, r / 2)));
  return pts.map(p => ({ ...p, alt: team.altM }));
}

// Where a team's (or one aircraft's) drones can be: along its route/target, or anywhere in the circle.
function txSamples(team, drone) {
  const path = flightPath(team, drone);
  return path ? flightSamples(path, team.corridorM ?? 150) : circleSamples(team);
}
// Where a team's pilots can be (launch point plus pilot track).
const rxSamples = team => pilotSamples(team);

// Worst-case (minimum) loss between any pilot position and any aircraft position. Memoised.
const couplingCache = new Map();
function coupling(rxTeam, rxPts, txPts) {
  const hRx = rxTeam.pilotHeightM ?? 1.5;
  const key = `${hRx}|${pathKey(rxPts)}|${pathKey(txPts)}`;
  const hit = couplingCache.get(key);
  if (hit && hit.terrain) return hit;
  let best = null;
  for (const r of rxPts) for (const t of txPts) {
    const res = pathLoss({ lat: t.lat, lon: t.lon, hAgl: t.alt }, { lat: r.lat, lon: r.lon, hAgl: hRx });
    if (!best || res.lossDb < best.lossDb) best = { ...res, at: t, pilotAt: r };
  }
  const c = distM(rxPts[0], txPts[0]);
  const out = { ...best, centerDistM: c };
  if (couplingCache.size > 2000) couplingCache.clear();
  couplingCache.set(key, out);
  return out;
}
const teamCoupling = (rxTeam, txTeam) => coupling(rxTeam, rxSamples(rxTeam), txSamples(txTeam, null));

// Build a frequency-independent scenario: gains per pair (excluding TX power).
export function buildScenario(state) {
  const teams = new Map(state.teams.map(t => [t.id, t]));
  const rxs = new Map(state.receivers.map(r => [r.id, r]));
  const warnings = [];
  const nodes = [];
  for (const d of state.drones) {
    if (!d.active) continue;
    const team = teams.get(d.teamId), vtx = d.vtx, rx = rxs.get(d.receiverId);
    if (!team || !vtx || !rx) { warnings.push(`${d.callsign}: missing team, VTX or receiver — skipped.`); continue; }
    if (team.lat == null) { warnings.push(`${d.callsign}: team ${team.name} not placed on map — skipped.`); continue; }
    if (vtx.type !== rx.type) warnings.push(`${d.callsign}: VTX is ${vtx.type} but receiver is ${rx.type}.`);
    const allowed = state.mission.bandFilter || null; // optional array of letters
    const fw = d.firmware || 'betaflight';
    const cands = channelsOf(vtx).filter(c =>
      rx.ranges.some(([lo, hi]) => c.freq >= lo && c.freq <= hi) && fwSupports(fw, c.freq) &&
      (!allowed || !allowed.length || allowed.includes(vtx.bands[c.bandIdx].letter)));
    if (!cands.length) { warnings.push(`${d.callsign}: no channel that the VTX, receiver and ${FIRMWARES[fw].name} all support.`); continue; }
    let cur = d.assign ? cands.findIndex(c => c.bandIdx === d.assign.bandIdx && c.chIdx === d.assign.chIdx) : -1;
    if (d.locked && cur < 0) warnings.push(`${d.callsign}: locked channel not tunable by receiver — unlocked.`);
    const powers = vtx.powers.map(p => p.mW).map(m => (m == null || m <= 0) ? null : fwPowerMw(fw, vtx, m));
    const fix = k => { k = Math.min(k ?? 0, vtx.powers.length - 1); return powers[k] == null ? powers.findIndex(m => m != null) : k; };
    const pIdx = fix(d.flightPowerIdx), tIdx = fix(d.takeoffPowerIdx);
    nodes.push({
      drone: d, team, vtx, rx, cands, cur: cur < 0 ? 0 : cur, locked: d.locked && cur >= 0,
      powersMw: powers, pIdx, tIdx,
      bw: vtx.bandwidthMHz || 18, tol: (vtx.freqTolMHz || 0) + (d.freqOffsetMHz ? Math.abs(d.freqOffsetMHz) : 0),
      curve: rx.selectivity, iip3: rx.iip3Dbm, reqSir: rx.reqSirDb, reqSnr: rx.reqSnrDb ?? 6,
      noiseDbm: -174 + 10 * log10((vtx.bandwidthMHz || 18) * 1e6) + rx.noiseFigureDb + (state.mission.envNoiseDb || 0),
    });
  }

  // Desired-link gain (excl. TX power): drone at its furthest point from the pilots, LOS assumed.
  // With a route this is the furthest synced pilot–aircraft distance; terrain blockage is reported separately.
  for (const n of nodes) {
    n.path = flightPath(n.team, n.drone);
    let r = Math.max(50, n.drone.maxRangeM || n.team.radiusM);
    if (n.path) {
      r = 50;
      for (const q of syncedPairs(n.team, n.path, 40)) r = Math.max(r, Math.hypot(distM(q.drone, q.pilot), q.drone.alt));
      if (n.drone.maxRangeM) r = Math.max(r, n.drone.maxRangeM);
    }
    const fixed = n.drone.txGainDbi + n.drone.rxGainDbi - polLoss(n.drone.txPol, n.drone.rxPol, true) - (state.mission.fadeMarginDb ?? 6);
    n.desiredGain = fixed - fspl(r, REF_F);
    // takeoff/landing phase: own aircraft out to the distance where the pilot switches to flight power
    n.switchM = Math.max(20, n.team.switchM ?? 150);
    n.desiredGainT = fixed - fspl(Math.hypot(n.switchM, n.team.altM ?? 60), REF_F);
    n.desiredRangeM = r;
  }

  // Team-pair coupling (cached per ordered pair).
  const tc = new Map();
  const getTC = (rt, tt) => {
    const k = rt.id + '|' + tt.id;
    if (!tc.has(k)) tc.set(k, teamCoupling(rt, tt));
    return tc.get(k);
  };
  const N = nodes.length;
  const gain = new Float64Array(N * N).fill(NaN);  // interferer in flight (flight power)
  const gainT = new Float64Array(N * N).fill(NaN); // interferer taking off / landing nearby (takeoff power)
  const info = new Array(N * N);
  const nlosExtra = state.mission.nlosExtraDb || 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    if (i === j) continue;
    const ri = nodes[i], tj = nodes[j];
    if (!timeOverlap(ri.team, tj.team)) continue;
    let loss, los, inf;
    const pol = l => polLoss(tj.drone.txPol, ri.drone.rxPol, l);
    if (ri.team.id === tj.team.id) {
      const launch = Math.max(2, ri.team.launchSepM ?? 20), fly = Math.max(launch, ri.team.flightSepM ?? 100);
      loss = fspl(fly, REF_F); los = true;
      gainT[i * N + j] = tj.drone.txGainDbi + ri.drone.rxGainDbi - fspl(launch, REF_F) - pol(true);
      inf = { distM: fly, launchM: launch, los: true, terrain: false, diffDb: 0, sameTeam: true };
    } else {
      const c = tj.path?.target ? coupling(ri.team, rxSamples(ri.team), txSamples(tj.team, tj.drone)) : getTC(ri.team, tj.team);
      loss = c.lossDb + (c.los ? 0 : nlosExtra); los = c.los;
      inf = { distM: c.distM, los: c.los, terrain: c.terrain, diffDb: c.diffDb, centerDistM: c.centerDistM };
    }
    gain[i * N + j] = tj.drone.txGainDbi + ri.drone.rxGainDbi - loss - pol(los);
    info[i * N + j] = inf;
  }

  // External emitters
  const ext = nodes.map(() => []);
  for (const e of state.emitters || []) {
    if (e.lat == null) continue;
    nodes.forEach((n, i) => {
      const p = coupling(n.team, rxSamples(n.team), [{ lat: e.lat, lon: e.lon, alt: e.heightM ?? 10 }]);
      const pw = e.eirpDbm + n.drone.rxGainDbi - p.lossDb - (p.los ? 0 : nlosExtra) - polLoss('LIN', n.drone.rxPol, p.los);
      ext[i].push({ name: e.name, freq: e.freqMHz, bw: e.bwMHz || 20, powDbm: pw, info: p });
    });
  }
  return { nodes, gain, gainT, info, ext, warnings, teamCoupling: tc };
}

const fAdj = f => 20 * log10(f / REF_F);

// Own video link along an aircraft's route, with the pilots moving in step. Terrain-aware.
// Returns samples [{along, dbm, los}] and blocked runs with the height needed to see the pilots.
export function linkProfile(scn, i, pIdx) {
  const n = scn.nodes[i];
  if (!n.path) return null;
  const hRx = n.team.pilotHeightM ?? 1.5;
  const f = n.cands[n.cur]?.freq ?? REF_F;
  const p = dbm(n.powersMw[pIdx] ?? 25) + n.drone.txGainDbi + n.drone.rxGainDbi;
  const threshold = n.noiseDbm + n.reqSnr;
  let terrain = true;
  const samples = syncedPairs(n.team, n.path, 60).map(q => {
    const r = pathLoss({ lat: q.drone.lat, lon: q.drone.lon, hAgl: q.drone.alt }, { lat: q.pilot.lat, lon: q.pilot.lon, hAgl: hRx }, f);
    if (!r.terrain && r.distM >= 60) terrain = false; // very short paths skip terrain by design
    return { ...q, dbm: p - r.lossDb - polLoss(n.drone.txPol, n.drone.rxPol, r.los), los: r.los, diffDb: r.diffDb };
  });
  const runs = [];
  let cur = null;
  for (const s of samples.filter(x => !x.loiter)) {
    if (!s.los) { if (!cur) runs.push(cur = { from: s.along, to: s.along, worst: s }); cur.to = s.along; if (s.diffDb > cur.worst.diffDb) cur.worst = s; }
    else cur = null;
  }
  const loiterBlocked = samples.filter(x => x.loiter && !x.los).length;
  for (const run of runs) {
    const w = run.worst;
    run.minAgl = null;
    for (let h = Math.ceil(w.drone.alt / 10) * 10 + 10; h <= 1000; h += 10) {
      const r = pathLoss({ lat: w.drone.lat, lon: w.drone.lon, hAgl: h }, { lat: w.pilot.lat, lon: w.pilot.lon, hAgl: hRx }, f);
      if (r.los) { run.minAgl = h; break; }
    }
    run.lat = w.drone.lat; run.lon = w.drone.lon;
  }
  return { samples, runs, loiterBlocked, threshold, terrain, length: n.path.length };
}

// Strongest received power (pre-filter) at receiver i from VTX j: in flight or at takeoff.
function pairPower(scn, i, j, pF, pT, fj) {
  const N = scn.nodes.length, g = scn.gain[i * N + j], gt = scn.gainT[i * N + j];
  if (Number.isNaN(g)) return null;
  const fl = pF[j] + g - fAdj(fj);
  if (Number.isNaN(gt)) return { P: fl, phase: 'flight' };
  const to = pT[j] + gt - fAdj(fj);
  return to > fl ? { P: to, phase: 'takeoff' } : { P: fl, phase: 'flight' };
}
const powersDbm = (nodes, idx) => nodes.map((n, i) => dbm(n.powersMw[idx[i]] ?? 25));

// assign: Int array of candidate indices; pIdx: Int array of power indices
// tIdx: takeoff/landing power indices (defaults to each node's current takeoff power).
export function evaluate(scn, assign, pIdx, detail = false, tIdx = null) {
  const { nodes, ext } = scn, N = nodes.length;
  const freq = nodes.map((n, i) => n.cands[assign[i]].freq);
  const pdbm = powersDbm(nodes, pIdx), ptdbm = powersDbm(nodes, tIdx || nodes.map(n => n.tIdx));
  const res = new Array(N);
  let minMargin = Infinity, sumMargin = 0;
  for (let i = 0; i < N; i++) {
    const ni = nodes[i], fi = freq[i];
    const S = pdbm[i] + ni.desiredGain - fAdj(fi);
    let lin = 0; // interference only (mW)
    const contrib = detail ? [] : null;
    const rx = []; // received (pre-rejection) power from each coupled tx
    for (let j = 0; j < N; j++) {
      if (j === i) continue;
      const pp = pairPower(scn, i, j, pdbm, ptdbm, freq[j]);
      if (!pp) continue;
      const nj = nodes[j], P = pp.P;
      rx.push({ j, P, f: freq[j] });
      const dfEff = Math.abs(fi - freq[j]) - ni.tol - nj.tol - Math.max(0, (nj.bw - 18) / 2);
      const I = P - rejection(ni.curve, dfEff);
      lin += 10 ** (I / 10);
      if (detail) contrib.push({ kind: 'cochannel', j, I, P, df: Math.abs(fi - freq[j]), phase: pp.phase });
    }
    // 3rd-order IMD generated in the receiver front end
    for (let a = 0; a < rx.length; a++) for (let b = a + 1; b < rx.length; b++) {
      const A = rx[a], B = rx[b];
      if (Math.abs(A.f - fi) > 500 || Math.abs(B.f - fi) > 500) continue;
      for (const [p1, p2, f] of [[A, B, 2 * A.f - B.f], [B, A, 2 * B.f - A.f]]) {
        const off = Math.abs(f - fi) - ni.tol - 2 * nodes[p1.j].tol - nodes[p2.j].tol;
        if (off > 60) continue;
        const Pimd = Math.min(Math.max(p1.P, p2.P), 2 * p1.P + p2.P - 2 * ni.iip3);
        const I = Pimd - rejection(ni.curve, off);
        lin += 10 ** (I / 10);
        if (detail) contrib.push({ kind: 'imd', j: p1.j, k: p2.j, I, f });
      }
    }
    for (const e of ext[i]) {
      const dfEff = Math.abs(fi - e.freq) - ni.tol - Math.max(0, (e.bw - 18) / 2);
      const I = e.powDbm - rejection(ni.curve, dfEff);
      lin += 10 ** (I / 10);
      if (detail) contrib.push({ kind: 'external', name: e.name, I, df: Math.abs(fi - e.freq) });
    }
    const nLin = 10 ** (ni.noiseDbm / 10);
    // soft-minimum of the interference and noise margins (both degrade the picture together)
    const phase = Sx => {
      const sir = lin > 0 ? Sx - 10 * log10(lin) : 99, snr = Sx - ni.noiseDbm;
      const mI = sir - ni.reqSir, mN = snr - ni.reqSnr;
      return { S: Sx, sir, snr, sinr: Sx - 10 * log10(lin + nLin), mI, mN, margin: -10 * log10(10 ** (-mI / 10) + 10 ** (-mN / 10)) };
    };
    const F = phase(S), T = phase(ptdbm[i] + ni.desiredGainT - fAdj(fi));
    const margin = Math.min(F.margin, T.margin);
    minMargin = Math.min(minMargin, margin);
    sumMargin += Math.min(margin, 10);
    res[i] = { ...F, margin, marginF: F.margin, marginT: T.margin, takeoff: T, limitedPhase: T.margin < F.margin ? 'takeoff' : 'flight', freq: fi };
    if (detail) { contrib.sort((x, y) => y.I - x.I); res[i].contrib = contrib; }
  }
  return { res, minMargin: N ? minMargin : 0, sumMargin, score: (N ? minMargin : 0) * 100 + sumMargin };
}

// Pairwise C/I matrix (desired at i vs single interferer j), for display.
export function pairMatrix(scn, assign, pIdx) {
  const { nodes } = scn, N = nodes.length;
  const pdbm = powersDbm(nodes, pIdx), ptdbm = powersDbm(nodes, nodes.map(n => n.tIdx));
  const M = [];
  for (let i = 0; i < N; i++) {
    const row = [];
    const fi = nodes[i].cands[assign[i]].freq;
    const S = pdbm[i] + nodes[i].desiredGain - fAdj(fi);
    for (let j = 0; j < N; j++) {
      const fj = nodes[j].cands[assign[j]].freq;
      const pp = i === j ? null : pairPower(scn, i, j, pdbm, ptdbm, fj);
      if (!pp) { row.push(null); continue; }
      const P = pp.P;
      const dfEff = Math.abs(fi - fj) - nodes[i].tol - nodes[j].tol - Math.max(0, (nodes[j].bw - 18) / 2);
      row.push(S - (P - rejection(nodes[i].curve, dfEff)));
    }
    M.push(row);
  }
  return M;
}
