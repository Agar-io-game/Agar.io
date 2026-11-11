// What you do in your recordings: key rhythm, cursor, shapes, speed.
//   node bot/v3/analysis/human.mjs
import { loadRecording } from '../recording.mjs';
import { readdirSync } from 'node:fs';
const dir = new URL('../../../recordings/', import.meta.url);
const pct = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const q = (a, d = 0) => `p10 ${pct(a, 0.1).toFixed(d)} p25 ${pct(a, 0.25).toFixed(d)} p50 ${pct(a, 0.5).toFixed(d)} p75 ${pct(a, 0.75).toFixed(d)} p90 ${pct(a, 0.9).toFixed(d)} p99 ${pct(a, 0.99).toFixed(d)} max ${Math.max(...a).toFixed(d)} mean ${mean(a).toFixed(d + 1)}`;
const A = { gapAll: [], gapUnit: [], tabToSplit: [], splitToTab: [], cellsAt: [], shareAt: [], aimDist: [], aimAng: [], aimToOther: [], path1: [], net10: [], net30: [], net60: [], grams: {}, secs: 0, splits: 0, fulls: 0, tabs: 0, feeds: 0, lost: 0, eatsX: 0, merges: 0, turn: [], sep: [], cellsU: [], pathLen: 0 };
const cen = (cs) => { let m = 0, x = 0, y = 0; for (const c of cs) { m += c[4]; x += c[2] * c[4]; y += c[3] * c[4]; } return m ? { x: x / m, y: y / m, m } : null; };
for (const f of readdirSync(dir).filter((f) => f.endsWith('.gz')).sort()) {
  const r = loadRecording(new URL(f, dir));
  const byTick = new Map(r.frames.map((fr) => [fr.tick, fr]));
  const startFr = r.frames.find((fr) => fr.cells.reduce((s, c) => s + c[4], 0) > 30000);
  const t0 = startFr.tick + 250, t1 = r.frames.at(-1).tick;
  const secs = (t1 - t0) / 25; A.secs += secs;
  const L = { splits: 0, fulls: 0, tabs: 0, feeds: 0 };
  const unitOf = (fr, pid) => fr.cells.filter((c) => c[1] === pid);
  let prevFr = null;
  const cents = [];
  for (let t = t0; t <= t1; t++) {
    const fr = byTick.get(t); if (!fr) { cents.push(null); continue; }
    cents.push(cen(fr.cells));
    const pids = new Set(fr.cells.map((c) => c[1]));
    if (prevFr) {
      const ppids = new Set(prevFr.cells.map((c) => c[1]));
      if (ppids.size === 2 && pids.size === 1) { A.lost++; console.log('  lost a unit at', ((t - r.t0) / 25).toFixed(1), 's'); }
      const now = new Map(fr.cells.map((c) => [c[0], c])), was = new Map(prevFr.cells.map((c) => [c[0], c]));
      for (const [id, c] of was) if (!now.has(id)) {
        let best = null;
        for (const [id2, n] of now) { const w = was.get(id2); if (w && Math.abs(n[4] - w[4] - c[4]) < 0.02 * c[4] + 1) best = n; }
        if (best) { if (best[1] === c[1]) A.merges++; else A.eatsX++; }
      }
    }
    if (pids.size === 2 && t % 5 === 0) {
      const ps = [...pids]; const a = cen(unitOf(fr, ps[0])), b = cen(unitOf(fr, ps[1]));
      A.sep.push(Math.hypot(a.x - b.x, a.y - b.y)); A.cellsU.push(unitOf(fr, ps[0]).length, unitOf(fr, ps[1]).length);
    }
    prevFr = fr;
  }
  for (const [n, arr] of [[25, A.path1], [250, A.net10], [750, A.net30], [1500, A.net60]])
    for (let i = 0; i + n < cents.length; i += n) { const a = cents[i], b = cents[i + n]; if (a && b) arr.push(Math.hypot(b.x - a.x, b.y - a.y) / (n / 25)); }
  { let ph = null; for (let i = 0; i + 50 < cents.length; i += 50) { const a = cents[i], b = cents[i + 50]; if (!a || !b) continue; const h = Math.atan2(b.y - a.y, b.x - a.x); if (ph !== null) { let d = h - ph; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; A.turn.push(Math.abs(d) * 180 / Math.PI); } ph = h; } }
  const aimOf = {}; const seq = [];
  let lastSplit = null, lastKey = null, lastTab = null; const lastByUnit = {};
  for (const e of r.events) {
    if (e.ev === 'aim') { aimOf[e.pid] = e; continue; }
    if (e.tick < t0) continue;
    if (e.ev === 'feedHold' && e.on) { L.feeds++; seq.push('W'); continue; }
    if (e.ev === 'tab') { L.tabs++; seq.push('T'); if (lastSplit != null && lastKey === 'S') A.splitToTab.push(e.tick - lastSplit); lastKey = 'T'; lastTab = e.tick; continue; }
    if (e.ev !== 'split') continue;
    const fr = byTick.get(e.tick) ?? byTick.get(e.tick - 1); if (!fr) continue;
    const mine = unitOf(fr, e.pid), other = fr.cells.filter((c) => c[1] !== e.pid);
    if (!mine.length) continue;
    if (mine.length >= 16) { seq.push('x'); continue; }
    L.splits++; if (e.n === 4) L.fulls++;
    seq.push(e.n === 4 ? 'F' : e.n === 2 ? 'D' : 'S');
    if (lastSplit != null) A.gapAll.push(e.tick - lastSplit);
    if (lastByUnit[e.pid] != null) A.gapUnit.push(e.tick - lastByUnit[e.pid]);
    if (lastKey === 'T') A.tabToSplit.push(e.tick - lastTab);
    lastSplit = e.tick; lastByUnit[e.pid] = e.tick; lastKey = 'S';
    const c = cen(mine), o = cen(other), all = cen(fr.cells);
    A.cellsAt.push(mine.length); A.shareAt.push(c.m / all.m);
    const am = aimOf[e.pid];
    if (am) {
      const dx = am.x - c.x, dy = am.y - c.y; A.aimDist.push(Math.hypot(dx, dy));
      const i = e.tick - t0, a0 = cents[i], a1 = cents[Math.min(cents.length - 1, i + 75)];
      if (a0 && a1) { let d = Math.atan2(dy, dx) - Math.atan2(a1.y - a0.y, a1.x - a0.x); while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; A.aimAng.push(Math.abs(d) * 180 / Math.PI); }
      if (o) { let inside = 0; for (const oc of other) if (Math.hypot(am.x - oc[2], am.y - oc[3]) < Math.sqrt(100 * oc[4])) inside = 1; A.aimToOther.push(inside); }
    }
  }
  const s = seq.join('');
  for (const n of [2, 3, 4, 6]) for (let i = 0; i + n <= s.length; i++) { const g = s.slice(i, i + n); (A.grams[n] ??= {})[g] = (A.grams[n][g] || 0) + 1; }
  A.splits += L.splits; A.fulls += L.fulls; A.tabs += L.tabs; A.feeds += L.feeds;
  console.log(`${f}: ${secs.toFixed(0)} s  splits ${(L.splits / secs).toFixed(2)}/s (full ${(L.fulls / secs).toFixed(2)})  tabs ${(L.tabs / secs).toFixed(2)}/s  W ${L.feeds}`);
}
console.log(`\nALL ${A.secs.toFixed(0)} s: splits ${(A.splits / A.secs).toFixed(3)}/s  fulls ${(A.fulls / A.secs).toFixed(3)}/s  tabs ${(A.tabs / A.secs).toFixed(3)}/s  W presses ${A.feeds}  units lost ${A.lost}  cross-unit eats ${(A.eatsX / A.secs).toFixed(2)}/s  same-unit merges ${(A.merges / A.secs).toFixed(3)}/s`);
console.log('gap between split presses, ticks:          ', q(A.gapAll));
console.log('gap between splits of the same unit, ticks:', q(A.gapUnit));
console.log('tab -> split, ticks:', q(A.tabToSplit)); console.log('split -> tab, ticks:', q(A.splitToTab));
console.log('cells in the unit at a split:', q(A.cellsAt)); console.log('unit mass share at a split:', q(A.shareAt, 2));
console.log('cursor distance from the unit centre at a split:', q(A.aimDist)); console.log('cursor angle off the course (deg):', q(A.aimAng));
console.log('cursor inside a cell of the other unit:', (100 * mean(A.aimToOther)).toFixed(0) + '%');
console.log('speed, 1 s net:', q(A.path1)); console.log('speed, 10 s net:', q(A.net10)); console.log('speed, 30 s net:', q(A.net30)); console.log('speed, 60 s net:', q(A.net60));
console.log('turn between 2 s windows (deg):', q(A.turn)); console.log('distance between the units:', q(A.sep)); console.log('cells per unit:', q(A.cellsU));
for (const n of [2, 3, 4, 6]) { const tot = Object.values(A.grams[n]).reduce((a, b) => a + b, 0); console.log(`${n}-grams:`, Object.entries(A.grams[n]).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([g, c]) => `${g} ${(100 * c / tot).toFixed(1)}%`).join('  ')); }
