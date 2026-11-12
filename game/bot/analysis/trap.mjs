// How often a unit is trapped: the lighter unit holds under `share` of the mass and none of its
// cells can eat any cell of the other unit, so it can only be eaten. Your recordings against
// game sets; also how often that holds in the 10 s before a lost unit.
//   node bot/analysis/trap.mjs <game set> ...
import { readdirSync } from 'node:fs';
import { load } from './splits.mjs';
import { ROOT, gamesDir } from './paths.mjs';

const trapped = (f, share) => {
  const a = f.filter((c) => c.u === 0), b = f.filter((c) => c.u === 1); if (!a.length || !b.length) return null;
  const S = (x) => x.reduce((s, c) => s + c.mass, 0), mx = (x) => Math.max(...x.map((c) => c.mass)), mn = (x) => Math.min(...x.map((c) => c.mass));
  const ma = S(a), mb = S(b);
  return ma < mb ? ma / (ma + mb) < share && mx(a) <= 1.3 * mn(b) : mb / (ma + mb) < share && mx(b) <= 1.3 * mn(a);
};
const sets = [['you', ROOT + 'recordings/', 1250], ...process.argv.slice(2).map((d) => [d, gamesDir(d) + '/', 625])];
for (const share of [0.2, 0.3, 0.4]) {
  const out = [];
  for (const [who, dir, skip] of sets) {
    let n = 0, t = 0, pre = 0, preN = 0; const streak = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl.gz'))) {
      const r = load(dir + f, skip), resets = r.r.events.filter((e) => e.ev === 'reset').map((e) => e.tick);
      let run = 0;
      for (let T = r.start; T <= r.end; T += 5) {
        const fr = r.byTick.get(T); if (!fr || r.bad.has(T)) continue;
        const x = trapped(fr, share); if (x == null) continue;
        n++; if (x) { t++; run += 5; } else { if (run) streak.push(run); run = 0; }
        if (resets.some((R) => R > T && R - T <= 250)) { preN++; if (x) pre++; }
      }
    }
    streak.sort((a, b) => a - b);
    out.push(`${who}: ${(100 * t / n).toFixed(1)}% of the time, longest ${((streak.at(-1) ?? 0) / 25).toFixed(1)} s` + (preN ? `, 10 s before a loss ${(100 * pre / preN).toFixed(0)}%` : ''));
  }
  console.log(`trap at share ${share}: ${out.join(' | ')}`);
}
