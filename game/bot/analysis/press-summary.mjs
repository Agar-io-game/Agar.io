import { readFileSync } from 'node:fs';
const D = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const pct = (a, f) => (a.length ? (100 * a.filter(f).length / a.length).toFixed(0) + '%' : '-');
const mean = (a, f) => (a.length ? (a.reduce((s, x) => s + f(x), 0) / a.length) : NaN);
const med = (a, f) => { const v = a.map(f).sort((x, y) => x - y); return v.length ? v[v.length >> 1] : NaN; };
const dead = (p) => p.moved < 0.01, eat = (p) => p.d25 > 0.01, feed = (p) => p.d25 < -0.01;
for (const who of ['human', 'bot']) {
  const P = D[who];
  console.log(`\n== ${who}: ${P.length} presses`);
  console.log(`  key: single ${pct(P, (p) => p.n === 1)}, double ${pct(P, (p) => p.n === 2)}, full ${pct(P, (p) => p.n === 4)}`);
  console.log(`  next 1 s: no mass moves between units ${pct(P, dead)} | this unit eats ${pct(P, eat)} | this unit is eaten ${pct(P, feed)}  | mass moved per split ${(100 * mean(P, (p) => p.moved)).toFixed(1)}% of total`);
  console.log(`  progress next 2 s (scaled): mean ${mean(P, (p) => p.prog2).toFixed(0)}  after a dead split ${mean(P.filter(dead), (p) => p.prog2).toFixed(0)}  after a live split ${mean(P.filter((p) => !dead(p)), (p) => p.prog2).toFixed(0)}`);
  console.log(`  same unit as the press before ${pct(P, (p) => p.sameUnit)}; of those dead ${pct(P.filter((p) => p.sameUnit), dead)}; other unit before: dead ${pct(P.filter((p) => !p.sameUnit), dead)}`);
  console.log(`  splitting unit is the front one ${pct(P, (p) => p.front)};  pieces made per press: median ${med(P, (p) => p.made)}`);
  console.log('  by cells in the splitting unit before the press:');
  for (const [lo, hi] of [[1, 2], [2, 3], [3, 5], [5, 9], [9, 13], [13, 17]]) {
    const S = P.filter((p) => p.k >= lo && p.k < hi);
    console.log(`    ${String(lo).padStart(2)}-${String(hi - 1).padEnd(2)} cells: ${pct(P, (p) => p.k >= lo && p.k < hi).padStart(4)} of presses | full ${pct(S, (p) => p.n === 4).padStart(4)} | dead ${pct(S, dead).padStart(4)} | eats ${pct(S, eat).padStart(4)} | eaten ${pct(S, feed).padStart(4)} | progress 2 s ${mean(S, (p) => p.prog2).toFixed(0).padStart(4)}`);
  }
  const F = P.filter((p) => p.n === 4), S1 = P.filter((p) => p.n === 1);
  console.log(`  full splits (${F.length}): cells before median ${med(F, (p) => p.k)} (single: ${med(S1, (p) => p.k)}); unit's share of mass ${mean(F, (p) => p.share).toFixed(2)} (single ${mean(S1, (p) => p.share).toFixed(2)}); front unit ${pct(F, (p) => p.front)} (single ${pct(S1, (p) => p.front)})`);
  console.log(`     biggest own cell median ${med(F, (p) => p.maxMine).toFixed(0)} (single ${med(S1, (p) => p.maxMine).toFixed(0)}); biggest other cell ${med(F, (p) => p.maxOther).toFixed(0)} (single ${med(S1, (p) => p.maxOther).toFixed(0)})`);
  console.log(`     after a full split: dead ${pct(F, dead)}, eats ${pct(F, eat)}, eaten ${pct(F, feed)}, progress 2 s ${mean(F, (p) => p.prog2).toFixed(0)};  single: dead ${pct(S1, dead)}, progress ${mean(S1, (p) => p.prog2).toFixed(0)}`);
  console.log(`     gap since previous press: full median ${med(F, (p) => p.gap)} ticks, single ${med(S1, (p) => p.gap)}; since Tab: full ${med(F, (p) => p.sinceTab)} single ${med(S1, (p) => p.sinceTab)}`);
  // halves edible by the other unit's biggest cell
  console.log(`  halves of the splitting cells small enough for the other unit's biggest to eat: mean ${(100 * mean(P, (p) => p.edibleByOther)).toFixed(0)}%`);
  // runs of presses on the same unit
  let runs = [], cur = 0; for (const p of P) { if (p.sameUnit) cur++; else { if (cur) runs.push(cur + 1); cur = 0; } }
  console.log(`  runs of 3+ presses on one unit without the other unit pressing in between: ${runs.filter((r) => r >= 3).length} (${(runs.filter((r) => r >= 3).length / P.length * 1000).toFixed(1)} per 1000 presses)`);
}
