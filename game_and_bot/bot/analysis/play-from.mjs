// Plays the bot on from one moment of a recorded bot game (the position rebuilt as in
// futures-at.mjs), to try a change on a known bad spot: every 2 s the units' shares and
// cells, the keys pressed and the speed.
//   node bot/analysis/play-from.mjs <recording> <seconds> [overrideJSON] [play seconds=30] [runs=1]
import { load } from './splits.mjs';
import { stateAt } from './futures-at.mjs';
import { Game } from '../sim.mjs';
import { Brain } from '../brain.mjs';
import { loadParams } from '../run.mjs';

const [file, sec, over = '{}', len = 30, runs = 1, dump = null] = process.argv.slice(2); // dump: list the futures at this second of the play
const rec = load(file, 0), T = rec.r.t0 + Math.round(+sec * 25);
const goal = (+(/_(-?\d+)\.jsonl/.exec(file)?.[1] ?? 0) * Math.PI) / 180, G = { x: Math.cos(goal), y: Math.sin(goal) };
const params = { ...loadParams(), ...JSON.parse(over) };
for (let run = 0; run < +runs; run++) {
  const g = new Game(stateAt(rec, T)), brain = new Brain(params, goal), c0 = g.centre();
  let keys = [], last = 0, lost = false, minShare = 1, low = 0, share = 0;
  const along = () => { const c = g.centre(); return (c.x - c0.x) * G.x + (c.y - c0.y) * G.y; };
  const lines = [];
  for (let t = 0; t < +len * 25 && !lost; t++) {
    const s0 = g.splits, t0 = g.tabs, act = g.active;
    if (dump != null && t === Math.round(+dump * 25)) {
      const rows = []; brain.trace = (r) => rows.push(r);
      brain.futures(g, brain.player, 0, brain.p.samples); brain.trace = null;
      const sh = (q) => { const m = [0, 1].map((u) => q.cells(u).reduce((a, c) => a + c.mass, 0)); return `${(100 * m[0] / (m[0] + m[1])).toFixed(0)}/${(100 * m[1] / (m[0] + m[1])).toFixed(0)}% cells ${q.cells(0).length}/${q.cells(1).length}`; };
      const c = g.centre();
      for (const u of [0, 1]) console.log(`   u${u}${g.active === u ? '*' : ' '} ` + [...g.cells(u)].sort((a, b) => b.mass - a.mass).map((k) => `${Math.round(k.mass)}@${Math.round((k.x - c.x) * G.x + (k.y - c.y) * G.y)},${Math.round(-(k.x - c.x) * G.y + (k.y - c.y) * G.x)}`).join('  '));
      for (const r of rows.sort((a, b) => b.v - a.v).slice(0, 14)) console.log(`   ${String(r.i).padStart(3)} ${r.v.toFixed(0).padStart(8)}  ${sh(r.game)}  ${r.tag ?? ''} ${r.keys.join(' ')}`);
    }
    brain.act(g, t);
    if (g.tabs > t0) keys.push('tab'); if (g.splits > s0) keys.push(`S${g.player.active.splitQueue}u${g.active}`);
    g.step();
    lost = !g.cells(0).length || !g.cells(1).length;
    const m = [0, 1].map((u) => g.cells(u).reduce((a, c) => a + c.mass, 0)), M = m[0] + m[1];
    share = Math.min(m[0], m[1]) / M; minShare = Math.min(minShare, share); if (share < 0.25) low++;
    if ((t + 1) % 50 === 0 || lost) {
      const a = along();
      lines.push(`${String(((t + 1) / 25).toFixed(0)).padStart(4)}s ${((a - last) / 2).toFixed(0).padStart(5)} u/s  u0 ${String(g.cells(0).length).padStart(2)} cells ${(100 * m[0] / M).toFixed(0).padStart(3)}% | u1 ${String(g.cells(1).length).padStart(2)} cells ${(100 * m[1] / M).toFixed(0).padStart(3)}% | ${keys.join(' ')}${lost ? '  LOST A UNIT' : ''}`);
      keys = []; last = a;
    }
  }
  if (+runs === 1) console.log(lines.join('\n'));
  console.log(`run ${run + 1}: ${lost ? 'LOST A UNIT' : 'ok'}  lowest share ${(100 * minShare).toFixed(0)}%, at the end ${(100 * share).toFixed(0)}%, under 25% for ${(low / 25).toFixed(0)} s  ${(along() / (g.tick / 25)).toFixed(0)} u/s over ${(g.tick / 25).toFixed(0)} s`);
}
