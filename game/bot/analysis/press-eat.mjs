import { readFileSync } from 'node:fs';
const D = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const pct = (a, f) => (a.length ? (100 * a.filter(f).length / a.length).toFixed(1) + '%' : '-');
const mean = (a, f) => (a.length ? (a.reduce((s, x) => s + f(x), 0) / a.length) : NaN);
for (const who of ['human', 'bot']) {
  const P = D[who];
  console.log(`\n== ${who}`);
  console.log(`  presses where no half can eat anything of the other unit: ${pct(P, (p) => !p.canEat)}`);
  console.log(`     ... and the splitting unit is the lighter one: ${pct(P, (p) => !p.canEat && p.share < 0.5)}; lighter and under 35%: ${pct(P, (p) => !p.canEat && p.share < 0.35)}`);
  for (const [lab, f] of [['halves can eat', (p) => p.canEat], ['no half can eat', (p) => !p.canEat]]) {
    const S = P.filter(f);
    console.log(`  ${lab.padEnd(16)}: unit mass change next 2 s ${(100 * mean(S, (p) => p.d50)).toFixed(1)}%, progress 2 s ${mean(S, (p) => p.prog2).toFixed(0)}, cells before ${mean(S, (p) => p.k).toFixed(1)}, share ${mean(S, (p) => p.share).toFixed(2)}`);
  }
  const L = P.filter((p) => p.share < 0.35);
  console.log(`  light unit (<35%) presses: ${pct(P, (p) => p.share < 0.35)}; of them no half can eat: ${pct(L, (p) => !p.canEat)}; mass change 2 s: can eat ${(100 * mean(L.filter((p) => p.canEat), (p) => p.d50)).toFixed(1)}% / cannot ${(100 * mean(L.filter((p) => !p.canEat), (p) => p.d50)).toFixed(1)}%`);
}
