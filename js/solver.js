// Channel and power planning.
// Channels: simulated annealing with restarts, maximizing the worst pilot's margin, then the sum
// of (capped) margins. Powers: the planner sets BOTH the takeoff/landing power and the in-flight
// power for every aircraft — raised where a link is range-limited, then stepped down while every
// pilot keeps a healthy margin, so each aircraft uses the least power that keeps everyone clear.
import { evaluate } from './rf.js';

export const POWER_FLOOR_DB = 3; // target margin for power steps (fade margin is already in the link budget)

function anneal(scn, start, P, { iterations, restarts, rand }) {
  const { nodes } = scn;
  const free = nodes.map((n, i) => n.locked ? -1 : i).filter(i => i >= 0);
  const ev = a => evaluate(scn, a, P.F, false, P.T);
  let best = { assign: [...start], ...ev(start) };
  if (!free.length) return best;
  for (let r = 0; r < restarts; r++) {
    const a = nodes.map((n, i) => (r === 0 || n.locked) ? start[i] : Math.floor(rand() * n.cands.length));
    let cur = ev(a).score;
    const T0 = 300, T1 = 1;
    for (let it = 0; it < iterations; it++) {
      const T = T0 * (T1 / T0) ** (it / iterations);
      const i = free[Math.floor(rand() * free.length)];
      const old = a[i];
      a[i] = Math.floor(rand() * nodes[i].cands.length);
      if (a[i] === old) continue;
      const s = ev(a).score;
      if (s >= cur || rand() < Math.exp((s - cur) / T)) {
        cur = s;
        if (s > best.score) best = { assign: [...a], ...ev(a) };
      } else a[i] = old;
    }
  }
  return best;
}

const usable = (n, k) => k >= 0 && k < n.powersMw.length && n.powersMw[k] != null;
const mw = (n, k) => n.powersMw[k] ?? 0;
const isLocked = (n, ph) => ph === 'F' ? !!n.drone.powerLocked : !!n.drone.takeoffLocked;
const lowest = n => { for (let k = 0; k < n.powersMw.length; k++) if (usable(n, k)) return k; return 0; };

// One step of a power index in a direction, keeping takeoff ≤ flight.
function step(n, P, i, ph, dir) {
  let k = P[ph][i] + dir;
  while (k >= 0 && k < n.powersMw.length && !usable(n, k)) k += dir;
  if (!usable(n, k)) return null;
  if (ph === 'T' && mw(n, k) > mw(n, P.F[i])) return null;
  if (ph === 'F' && mw(n, k) < mw(n, P.T[i])) return null;
  return k;
}

// Raise power on the worst range-limited links while that helps without hurting the worst pilot.
function raise(scn, assign, P) {
  const { nodes } = scn;
  for (let guard = 0; guard < 80; guard++) {
    const base = evaluate(scn, assign, P.F, false, P.T);
    const order = base.res.map((r, i) => i).filter(i => base.res[i].margin < POWER_FLOOR_DB).sort((a, b) => base.res[a].margin - base.res[b].margin);
    let improved = false;
    for (const i of order) {
      const r = base.res[i];
      const ph = r.marginT < r.marginF ? 'T' : 'F';
      const lim = ph === 'T' ? r.takeoff : r;
      if (lim.mN >= lim.mI || isLocked(nodes[i], ph)) continue; // only range-limited links gain from more power
      const k = step(nodes[i], P, i, ph, +1);
      if (k == null) continue;
      const trial = { F: [...P.F], T: [...P.T] }; trial[ph][i] = k;
      const t = evaluate(scn, assign, trial.F, false, trial.T);
      if (t.minMargin > base.minMargin + 0.05 || (t.minMargin >= base.minMargin - 0.01 && t.res[i].margin > base.res[i].margin + 0.5)) {
        P[ph][i] = k; improved = true; break;
      }
    }
    if (!improved) break;
  }
}

// Step powers down (biggest first) while nobody's margin falls below min(their margin, floor).
function reduce(scn, assign, P) {
  const { nodes } = scn;
  let changed = true;
  while (changed) {
    changed = false;
    const base = evaluate(scn, assign, P.F, false, P.T);
    const floor = base.res.map(x => Math.min(x.margin, POWER_FLOOR_DB));
    const moves = [];
    nodes.forEach((n, i) => { for (const ph of ['F', 'T']) if (!isLocked(n, ph)) moves.push({ i, ph, w: mw(n, P[ph][i]) }); });
    moves.sort((a, b) => b.w - a.w);
    for (const { i, ph } of moves) {
      const k = step(nodes[i], P, i, ph, -1);
      if (k == null) continue;
      const trial = { F: [...P.F], T: [...P.T] }; trial[ph][i] = k;
      const t = evaluate(scn, assign, trial.F, false, trial.T);
      if (t.res.every((x, idx) => x.margin >= floor[idx] - 0.01)) { P[ph][i] = k; changed = true; break; }
    }
  }
}

export function solve(scn, { iterations = 4000, restarts = 6, seed = 1 } = {}) {
  const { nodes } = scn;
  if (!nodes.length) return null;
  let rng = seed >>> 0 || 1;
  const rand = () => ((rng = (rng * 1664525 + 1013904223) >>> 0) / 4294967296);
  // Start: takeoff at the lowest level, flight at the current/highest level (unless fixed by hand).
  const P = {
    F: nodes.map(n => n.pIdx),
    T: nodes.map(n => n.drone.takeoffLocked ? n.tIdx : lowest(n)),
  };
  nodes.forEach((n, i) => { if (mw(n, P.T[i]) > mw(n, P.F[i])) P.T[i] = P.F[i]; });
  let best = anneal(scn, nodes.map(n => n.cur), P, { iterations, restarts, rand });
  for (let round = 0; round < 2; round++) {
    raise(scn, best.assign, P);
    reduce(scn, best.assign, P);
    best = anneal(scn, best.assign, P, { iterations: Math.floor(iterations / 2), restarts: 2, rand });
  }
  return { ...evaluate(scn, best.assign, P.F, false, P.T), assign: best.assign, pIdx: P.F, tIdx: P.T };
}
