// When you press which key: the state of the unit you split (share of the mass, cells, biggest
// cell against the other unit's biggest), for single and full splits, and what gets eaten after.
//   node bot/v3/analysis/human-when.mjs
import { loadRecording } from '../recording.mjs';
import { readdirSync } from 'node:fs';
const dir = new URL('../../../recordings/', import.meta.url);
const pct = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const q = (a, d = 2) => `p10 ${pct(a, 0.1).toFixed(d)} p25 ${pct(a, 0.25).toFixed(d)} p50 ${pct(a, 0.5).toFixed(d)} p75 ${pct(a, 0.75).toFixed(d)} p90 ${pct(a, 0.9).toFixed(d)}`;
const K = { 1: {}, 4: {} };
for (const k of [1, 4]) K[k] = { share: [], cells: [], ocells: [], bigRatio: [], bigShare: [], obigShare: [], eatenMine: [], eatenTheirs: [], after: [], sameAsLast: 0, n: 0, heavier: 0, small: [], canEat: [] };
let lastUnit = null; const sinceFull = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith('.gz')).sort()) {
  const r = loadRecording(new URL(f, dir));
  const byTick = new Map(r.frames.map((fr) => [fr.tick, fr]));
  const start = r.frames.find((fr) => fr.cells.reduce((s, c) => s + c[4], 0) > 30000).tick + 250;
  let lastFull = null;
  for (const e of r.events) {
    if (e.ev !== 'split' || e.tick < start || (e.n !== 1 && e.n !== 4)) continue;
    const fr = byTick.get(e.tick), later = byTick.get(e.tick + 25); if (!fr || !later) continue;
    const mine = fr.cells.filter((c) => c[1] === e.pid), other = fr.cells.filter((c) => c[1] !== e.pid);
    if (!mine.length || !other.length || mine.length >= 16) continue;
    const S = K[e.n], M = fr.cells.reduce((s, c) => s + c[4], 0), mm = mine.reduce((s, c) => s + c[4], 0);
    const big = Math.max(...mine.map((c) => c[4])), obig = Math.max(...other.map((c) => c[4]));
    S.n++; S.share.push(mm / M); S.cells.push(mine.length); S.ocells.push(other.length); S.bigRatio.push(big / obig); S.bigShare.push(big / M); S.obigShare.push(obig / M);
    if (mm > M / 2) S.heavier++;
    if (lastUnit === e.pid) S.sameAsLast++; lastUnit = e.pid;
    // share of my mass that the other unit's biggest cell could eat once halved, and vice versa
    S.canEat.push(mine.filter((c) => obig >= 1.3 * c[4] / 2).reduce((s, c) => s + c[4], 0) / mm);
    // cells gone one second later
    const ids = new Set(later.cells.map((c) => c[0]));
    S.eatenMine.push(mine.filter((c) => !ids.has(c[0])).length); S.eatenTheirs.push(other.filter((c) => !ids.has(c[0])).length);
    const lm = later.cells.filter((c) => c[1] === e.pid).reduce((s, c) => s + c[4], 0); S.after.push(lm / M - mm / M);
    if (e.n === 4) { if (lastFull != null) sinceFull.push((e.tick - lastFull) / 25); lastFull = e.tick; }
  }
}
for (const k of [1, 4]) {
  const S = K[k];
  console.log(`\n${k === 1 ? 'SINGLE' : 'FULL'} splits: ${S.n}   by the heavier unit ${(100 * S.heavier / S.n).toFixed(0)}%   same unit as the split before ${(100 * S.sameAsLast / S.n).toFixed(0)}%`);
  console.log('  share of the mass in the unit:        ', q(S.share));
  console.log('  its cells:                            ', q(S.cells, 0), '  the other unit:', q(S.ocells, 0));
  console.log('  its biggest cell / all mass:          ', q(S.bigShare), '  the other unit:', q(S.obigShare));
  console.log('  its biggest / the other unit\'s biggest:', q(S.bigRatio));
  console.log('  share of its mass whose halves the other unit\'s biggest cell can eat:', q(S.canEat));
  console.log('  change of its share 1 s later:        ', q(S.after));
  console.log('  its cells from before gone 1 s later: ', q(S.eatenMine, 0), '  the other unit\'s:', q(S.eatenTheirs, 0));
}
console.log('\nseconds between full splits:', q(sinceFull, 1));
