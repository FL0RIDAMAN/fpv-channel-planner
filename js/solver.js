// Channel (and optional power) assignment.
// Channels: simulated annealing with restarts, maximizing the worst receiver's margin,
// then the sum of (capped) margins. Power: raise VTXs that are range-limited when that
// helps the worst link, then step power down while every link keeps a healthy margin.
import { evaluate } from './rf.js';

export const POWER_FLOOR_DB = 3; // target margin for power steps (fade margin is already in the link budget)

function anneal(scn, start, pIdx, { iterations, restarts, rand }) {
  const { nodes } = scn;
  const free = nodes.map((n, i) => n.locked ? -1 : i).filter(i => i >= 0);
  let best = { assign: [...start], ...evaluate(scn, start, pIdx) };
  if (!free.length) return best;
  for (let r = 0; r < restarts; r++) {
    const a = nodes.map((n, i) => (r === 0 || n.locked) ? start[i] : Math.floor(rand() * n.cands.length));
    let cur = evaluate(scn, a, pIdx).score;
    const T0 = 300, T1 = 1;
    for (let it = 0; it < iterations; it++) {
      const T = T0 * (T1 / T0) ** (it / iterations);
      const i = free[Math.floor(rand() * free.length)];
      const old = a[i];
      a[i] = Math.floor(rand() * nodes[i].cands.length);
      if (a[i] === old) continue;
      const s = evaluate(scn, a, pIdx).score;
      if (s >= cur || rand() < Math.exp((s - cur) / T)) {
        cur = s;
        if (s > best.score) best = { assign: [...a], ...evaluate(scn, a, pIdx) };
      } else a[i] = old;
    }
  }
  return best;
}

export function solve(scn, { iterations = 4000, restarts = 6, optimizePower = false, seed = 1 } = {}) {
  const { nodes } = scn;
  if (!nodes.length) return null;
  let rng = seed >>> 0 || 1;
  const rand = () => ((rng = (rng * 1664525 + 1013904223) >>> 0) / 4294967296);
  let pIdx = nodes.map(n => n.pIdx);
  let best = anneal(scn, nodes.map(n => n.cur), pIdx, { iterations, restarts, rand });
  if (optimizePower) {
    for (let round = 0; round < 2; round++) {
      pIdx = raisePower(scn, best.assign, pIdx);
      pIdx = reducePower(scn, best.assign, pIdx);
      best = anneal(scn, best.assign, pIdx, { iterations: Math.floor(iterations / 2), restarts: 2, rand });
    }
  }
  return { ...best, pIdx };
}

const usable = (n, k) => k >= 0 && k < n.powersMw.length && n.powersMw[k] != null;

// Raise power on the worst range-limited link while it improves the overall worst margin.
export function raisePower(scn, assign, pIdx0) {
  const { nodes } = scn;
  const p = [...pIdx0];
  for (let guard = 0; guard < 50; guard++) {
    const base = evaluate(scn, assign, p);
    const order = base.res.map((r, i) => i).filter(i => base.res[i].margin < POWER_FLOOR_DB && base.res[i].mN < base.res[i].mI)
      .sort((a, b) => base.res[a].margin - base.res[b].margin);
    let improved = false;
    for (const i of order) {
      if (nodes[i].drone.powerLocked) continue;
      let k = p[i] + 1;
      while (k < nodes[i].powersMw.length && !usable(nodes[i], k)) k++;
      if (!usable(nodes[i], k)) continue;
      const trial = [...p]; trial[i] = k;
      const r = evaluate(scn, assign, trial);
      if (r.minMargin > base.minMargin + 0.05 || (r.minMargin >= base.minMargin - 0.01 && r.res[i].margin > base.res[i].margin + 0.5)) {
        p[i] = k; improved = true; break;
      }
    }
    if (!improved) break;
  }
  return p;
}

// Step each VTX down while nobody's margin falls below min(their margin, POWER_FLOOR_DB).
export function reducePower(scn, assign, pIdx0) {
  const { nodes } = scn;
  const p = [...pIdx0];
  let changed = true;
  while (changed) {
    changed = false;
    const base = evaluate(scn, assign, p);
    const floor = base.res.map(x => Math.min(x.margin, POWER_FLOOR_DB));
    const order = nodes.map((n, i) => i).sort((a, b) => (nodes[b].powersMw[p[b]] || 0) - (nodes[a].powersMw[p[a]] || 0));
    for (const i of order) {
      if (nodes[i].drone.powerLocked) continue;
      let k = p[i] - 1;
      while (k >= 0 && !usable(nodes[i], k)) k--;
      if (k < 0) continue;
      const trial = [...p]; trial[i] = k;
      const r = evaluate(scn, assign, trial);
      if (r.res.every((x, idx) => x.margin >= floor[idx] - 0.01)) { p[i] = k; changed = true; break; }
    }
  }
  return p;
}
