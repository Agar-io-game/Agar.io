import { gamesDir } from './paths.mjs';
// Every split press, human vs bot: the situation and what came of it in the next 1 s / 2 s.
//   node quality.mjs <botdir> [maxFiles]
import { readdirSync, writeFileSync } from 'node:fs';
import { load, heading } from './splits.mjs';
import { ROOT } from './paths.mjs';
const cen = (cs) => { let m = 0, x = 0, y = 0; for (const c of cs) { m += c.mass; x += c.x * c.mass; y += c.y * c.mass; } return m ? { x: x / m, y: y / m, m } : null; };
export function presses(rec) {
  const out = []; const ev = rec.r.events;
  const resets = ev.filter((e) => e.ev === 'reset').map((e) => e.tick);
  let lastUnit = null, lastTick = -99, lastTab = -99;
  for (const e of ev) {
    if (e.ev === 'tab') { lastTab = e.tick; continue; }
    if (e.ev !== 'split') continue;
    const T = e.tick, u = e.pid & 1;
    const prevUnit = lastUnit, gap = T - lastTick; lastUnit = u; lastTick = T;
    if (T < rec.start || T + 50 > rec.end || rec.bad.has(T) || resets.some((r) => r >= T - 25 && r <= T + 50)) continue;
    const f0 = rec.byTick.get(T), f25 = rec.byTick.get(T + 25), f50 = rec.byTick.get(T + 50), H = heading(rec, T);
    if (!f0 || !f25 || !f50 || !H) continue;
    const mine = f0.filter((c) => c.u === u).sort((a, b) => a.id - b.id), other = f0.filter((c) => c.u !== u);
    if (!mine.length || !other.length) continue;
    const total = cen(f0).m, s = Math.sqrt(total / 35000);
    const mU = (f, k) => f.filter((c) => c.u === k).reduce((a, c) => a + c.mass, 0);
    const d25 = (mU(f25, u) - mU(f0, u)) / total, d50 = (mU(f50, u) - mU(f0, u)) / total;
    // exchanged mass in the next 1 s in either direction (sum of |unit mass change| tick by tick)
    let moved = 0; for (let t = T; t < T + 25; t++) { const a = rec.byTick.get(t), b = rec.byTick.get(t + 1); if (a && b) moved += Math.abs(mU(b, u) - mU(a, u)); }
    const C0 = cen(f0), C1 = cen(f25), C2 = cen(f50);
    const prog1 = ((C1.x - C0.x) * H.x + (C1.y - C0.y) * H.y) / s, prog2 = ((C2.x - C0.x) * H.x + (C2.y - C0.y) * H.y) / s;
    const ids0 = new Set(f0.map((c) => c.id));
    const made = new Set(); for (let t = T + 1; t <= T + 5; t++) for (const c of rec.byTick.get(t) ?? []) if (c.u === u && !ids0.has(c.id)) made.add(c.id);
    const al = (c) => ((c.x - C0.x) * H.x + (c.y - C0.y) * H.y) / s;
    const front = al(cen(mine)) > al(cen(other));
    const maxMine = Math.max(...mine.map((c) => c.mass)) / s / s, maxOther = Math.max(...other.map((c) => c.mass)) / s / s;
    // can the oldest splitting cells' halves be eaten by / eat the other unit? (biggest other cell vs half of mine)
    const k = mine.length, slots = 16 - k, elig = mine.filter((c) => c.mass >= 44);
    const splitting = elig.slice(0, Math.max(0, slots));
    const halfMax = splitting.length ? Math.max(...splitting.map((c) => c.mass / 2)) : 0;
    const minOther = Math.min(...other.map((c) => c.mass));
    const canEat = splitting.some((c) => c.mass / 2 > 1.3 * minOther);          // a half can eat some cell of the other unit
    const unitCanEat = mine.some((c) => c.mass > 1.3 * minOther);               // some cell of this unit can
    const otherCanEat = other.some((o) => splitting.some((c) => o.mass > 1.3 * c.mass / 2));
    const edibleByOther = splitting.filter((c) => maxOther * s * s > 1.3 * c.mass / 2).length / Math.max(1, splitting.length);
    out.push({ n: e.n ?? 1, u, k, ko: other.length, share: mU(f0, u) / total, front, made: made.size, d25, d50, moved: moved / total, prog1, prog2,
      sameUnit: prevUnit === u, gap, sinceTab: T - lastTab, maxMine, maxOther, halfMax: halfMax / s / s, edibleByOther, canEat, unitCanEat, otherCanEat, T,
      splitMasses: splitting.map((c) => c.mass / s / s), unitMasses: mine.map((c) => c.mass / s / s), otherMasses: other.map((c) => c.mass / s / s) });
  }
  return out;
}
if (process.argv[1]?.endsWith('quality.mjs')) {
const human = readdirSync(ROOT + 'recordings').filter((f) => f.endsWith('.gz')).map((f) => presses(load(ROOT + 'recordings/' + f, 1250)));
const botdir = gamesDir(process.argv[2]), maxF = +(process.argv[3] ?? 999);
const bot = readdirSync(botdir).filter((f) => f.endsWith('.gz')).slice(0, maxF).map((f) => presses(load(botdir + '/' + f, 625)));
writeFileSync(process.argv[4] ?? 'quality.json', JSON.stringify({ human: human.flat(), bot: bot.flat() }));
console.log('human presses', human.flat().length, 'bot presses', bot.flat().length);
}
