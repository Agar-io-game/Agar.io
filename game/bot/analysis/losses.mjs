import { gamesDir } from './paths.mjs';
// The presses in the 25 s before every lost unit in a set of bot games.
import { readdirSync } from 'node:fs';
import { load } from './splits.mjs';
const dir = gamesDir(process.argv[2]);
for (const f of readdirSync(dir).filter((x) => x.endsWith('.gz'))) {
  const rec = load(dir + '/' + f, 0);
  const resets = rec.r.events.filter((e) => e.ev === 'reset');
  for (const R of resets) {
    console.log(`\n== ${f} lost a unit at ${((R.tick - rec.r.t0) / 25).toFixed(1)} s`);
    const lines = [];
    for (let T = R.tick - 625; T < R.tick; T += 25) {
      const fr = rec.byTick.get(T); if (!fr) continue;
      const by = [0, 1].map((u) => fr.filter((c) => c.u === u));
      const tot = fr.reduce((a, c) => a + c.mass, 0);
      const pr = rec.r.events.filter((e) => e.tick >= T && e.tick < T + 25 && (e.ev === 'split' || e.ev === 'tab')).map((e) => (e.ev === 'tab' ? 'tab' : `S${e.n}u${e.pid & 1}`)).join(' ');
      lines.push(`${((T - rec.r.t0) / 25).toFixed(0).padStart(4)}s  u0 ${String(by[0].length).padStart(2)} cells ${(100 * by[0].reduce((a, c) => a + c.mass, 0) / tot).toFixed(0).padStart(3)}% max ${Math.round(Math.max(0, ...by[0].map((c) => c.mass))).toString().padStart(5)} | u1 ${String(by[1].length).padStart(2)} cells ${(100 * by[1].reduce((a, c) => a + c.mass, 0) / tot).toFixed(0).padStart(3)}% max ${Math.round(Math.max(0, ...by[1].map((c) => c.mass))).toString().padStart(5)} | ${pr}`);
    }
    console.log(lines.join('\n'));
  }
}
