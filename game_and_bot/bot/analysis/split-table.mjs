import { gamesDir } from './paths.mjs';
// Split quality table: node style2.mjs <label=dir> ...  (human = your recordings)
import { readdirSync } from 'node:fs';
import { load, heading } from './splits.mjs';
import { presses } from './quality.mjs';
import { ROOT } from './paths.mjs';
const cols = process.argv.slice(2).map((a) => a.split('='));
const rows = [];
const put = (name, vals) => rows.push([name, ...vals]);
const res = [];
for (const [label, dir] of cols) {
  const human = dir === 'human';
  const base = human ? ROOT + 'recordings/' : gamesDir(dir) + '/';
  const files = readdirSync(base).filter((f) => f.endsWith('.jsonl.gz'));
  let P = [], secs = 0, frames = 0, smallCells = 0, twins = 0, cellsN = 0, losses = 0, trap = 0, presses4 = 0;
  for (const f of files) {
    const rec = load(base + f, human ? 1250 : 625);
    P.push(...presses(rec));
    secs += (rec.end - rec.start) / 25;
    losses += rec.r.events.filter((e) => e.ev === 'reset').length;
    for (let T = rec.start; T <= rec.end; T += 25) {
      const fr = rec.byTick.get(T); if (!fr || rec.bad.has(T)) continue;
      const tot = fr.reduce((a, c) => a + c.mass, 0), k = 35000 / tot;
      frames++; smallCells += fr.filter((c) => c.mass * k < 400).length;
      for (const u of [0, 1]) { const ms = fr.filter((c) => c.u === u).map((c) => c.mass); for (const m of ms) { cellsN++; if (ms.filter((q) => Math.abs(q - m) < 0.02 * m).length > 1) twins++; } }
    }
  }
  const allPress = []; // all split events (incl. at 16) for rates
  for (const f of files) { const rec = load(base + f, human ? 1250 : 625); allPress.push(...rec.r.events.filter((e) => e.ev === 'split' && e.tick >= rec.start && e.tick <= rec.end)); }
  const pct = (f) => (100 * P.filter(f).length / P.length).toFixed(0) + '%';
  res.push({ label, n: files.length, secs, rate: allPress.length / secs, full: allPress.filter((e) => (e.n ?? 1) >= 4).length / secs,
    whole: pct((p) => p.k <= 8), small: pct((p) => p.splitMasses.some((m) => m < 400)), light: pct((p) => !p.canEat && p.share < 0.5),
    lightDead: pct((p) => !p.canEat && p.share < 0.35), k: (P.reduce((a, p) => a + p.k, 0) / P.length).toFixed(1),
    massSplit: (100 * P.reduce((a, p) => a + p.splitMasses.reduce((x, y) => x + y, 0) / p.unitMasses.reduce((x, y) => x + y, 0), 0) / P.length).toFixed(0) + '%',
    smallAt: (smallCells / frames).toFixed(1), twins: (100 * twins / cellsN).toFixed(0) + '%', losses });
}
const W = 16;
const line = (name, f) => console.log(name.padEnd(64) + res.map((r) => String(f(r)).padStart(W)).join(''));
line('', (r) => r.label);
line('games (time after the start)', (r) => `${r.n} (${(r.secs / 60).toFixed(0)} min)`);
line('units lost', (r) => (r.label === 'you' ? '-' : r.losses));
line('split presses per s', (r) => r.rate.toFixed(2));
line('  of them full splits per s', (r) => r.full.toFixed(2));
line('cells in the splitting unit at a press (mean)', (r) => r.k);
line('presses that split the whole unit (8 cells or fewer)', (r) => r.whole);
line('share of the unit\'s mass that splits', (r) => r.massSplit);
line('presses that split a cell under 400', (r) => r.small);
line('presses where no half can eat, by the lighter unit', (r) => r.light);
line('  ... and that unit has under 35% of the mass', (r) => r.lightDead);
line('cells under 400 mass at a time', (r) => r.smallAt);
line('cells with a same-size twin in their unit', (r) => r.twins);
