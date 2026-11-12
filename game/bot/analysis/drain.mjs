// How much of the time the lighter unit is drained: under 15 % and under 25 % of the mass
// (once a second, from 25 s on), and the drains: stretches of 5 s or more that start with
// the lighter unit under 25 % and last until it is back over 32 % (or the unit is lost).
//   node bot/analysis/drain.mjs human <game set> ... [--list]     --list: every drain, as "file second length"
// A listed moment can be looked at with futures-at.mjs and played on from with play-from.mjs.
import { gamesDir } from './paths.mjs';
import { readdirSync } from 'node:fs';
import { load } from './splits.mjs';
import { ROOT } from './paths.mjs';
const args = process.argv.slice(2), list = args.includes('--list');
for (const d of args.filter((a) => a !== '--list')) {
  const human = d === 'human', base = human ? ROOT + 'recordings/' : gamesDir(d) + '/';
  let n = 0, low = 0, low25 = 0; const drains = [];
  for (const f of readdirSync(base).filter((x) => x.endsWith('.jsonl.gz'))) {
    const r = load(base + f, human ? 1250 : 625);
    const share = (T) => { const fr = r.byTick.get(T); if (!fr || r.bad.has(T)) return null;
      const a = fr.filter((c) => c.u === 0).reduce((s, c) => s + c.mass, 0), b = fr.filter((c) => c.u === 1).reduce((s, c) => s + c.mass, 0);
      return a + b ? Math.min(a, b) / (a + b) : null; };
    for (let T = r.start; T <= r.end; T += 25) { const sh = share(T); if (sh == null) continue; n++; if (sh < 0.15) low++; if (sh < 0.25) low25++; }
    const resets = r.r.events.filter((e) => e.ev === 'reset').map((e) => e.tick);
    let start = null;
    for (let T = r.r.t0; T <= r.end; T += 5) {
      const sh = share(T); if (sh == null) { start = null; continue; }
      const lost = resets.some((R) => R > T - 5 && R <= T);
      if (start == null) { if (sh < 0.25 && !lost) start = T; }
      else if (sh > 0.32 || lost || T + 5 > r.end) { if (T - start >= 125) drains.push({ f, at: (start - r.r.t0) / 25, len: (T - start) / 25, lost }); start = null; }
    }
  }
  const total = drains.reduce((a, x) => a + x.len, 0), longest = Math.max(0, ...drains.map((x) => x.len));
  console.log(`${d.padEnd(10)} lighter unit under 15%: ${(100 * low / n).toFixed(1)}% of the time; under 25%: ${(100 * low25 / n).toFixed(1)}%; drains of 5 s+: ${drains.length}, ${total.toFixed(0)} s in all, longest ${longest.toFixed(0)} s, ended in a lost unit: ${drains.filter((x) => x.lost).length}`);
  if (list) for (const x of drains) console.log(`  ${x.f} ${x.at.toFixed(1)} ${x.len.toFixed(1)}${x.lost ? ' LOST' : ''}`);
}
