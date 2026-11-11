// "Would you split here?": a small network that tells your split presses from the bot's, from
// the situation at the moment of the press. A split walks the unit's cells in creation order
// (oldest first) and every cell of 44+ mass splits until the unit has 16, so it sees exactly
// which cells will split: how many, how big, how much of the unit, whether the halves can eat
// a cell of the other unit or will be eaten by it, each unit's share of the mass, which unit
// is in front, the rhythm (time since the last split and Tab, same unit again) and where the
// cursor is. The planner adds wPress x its log-odds for every split in a future (brain.mjs),
// so of the splits your habits would make, it keeps the ones made where you make them.
//   node bot/press.mjs --from <dir> [--test]   your recordings vs bot recordings in <dir>
// Writes data/press.json.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MLP } from './policy.mjs';
import { loadRecording } from './recording.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export const PRESS_INPUTS = 24;
export const PRESS_SIZES = [PRESS_INPUTS, 32, 16, 1];
const SKIP = 1205; // your recordings: from 48.2 s on
const SMALL = 400; // at 35,000 total mass

// cells: [{ unit, x, y, mass }] with each unit's cells in creation order; unit: the one that
// splits; full: the full-split key; H: the run's direction; aim: the cursor; ctx: { sinceSplit,
// sinceTab, sameUnit } in ticks. Masses and distances are scaled to 35,000 total mass.
export function pressInput(cells, unit, full, H, aim, ctx, out = new Float32Array(PRESS_INPUTS)) {
  out.fill(0);
  const mine = [], other = [];
  let M = 0, um = 0, mx = 0, my = 0, om = 0, ox = 0, oy = 0;
  for (const c of cells) {
    M += c.mass;
    if (c.unit === unit) { mine.push(c); um += c.mass; mx += c.x * c.mass; my += c.y * c.mass; }
    else { other.push(c); om += c.mass; ox += c.x * c.mass; oy += c.y * c.mass; }
  }
  if (!mine.length || !other.length) return out;
  const s2 = M / 35000, s = Math.sqrt(s2);
  mx /= um; my /= um; ox /= om; oy /= om;
  const k = mine.length, slots = Math.max(0, 16 - k);
  const splitting = []; for (const c of mine) { if (splitting.length >= slots) break; if (c.mass >= 44) splitting.push(c); }
  let minOther = Infinity, maxOther = 0, maxMine = 0, splitMass = 0, small = 0, minS = Infinity, maxS = 0, edible = 0, along = 0;
  for (const o of other) { if (o.mass < minOther) minOther = o.mass; if (o.mass > maxOther) maxOther = o.mass; }
  for (const c of mine) if (c.mass > maxMine) maxMine = c.mass;
  let canEat = 0;
  for (const c of splitting) {
    splitMass += c.mass;
    if (c.mass / s2 < SMALL) small++;
    if (c.mass < minS) minS = c.mass; if (c.mass > maxS) maxS = c.mass;
    if (c.mass / 2 > 1.3 * minOther) canEat = 1;
    if (maxOther > 1.3 * c.mass / 2) edible++;
    along += ((c.x - mx) * H.x + (c.y - my) * H.y) * c.mass;
  }
  const n = splitting.length, share = um / M;
  const ahead = (mx - ox) * H.x + (my - oy) * H.y;
  const ax = aim.x - mx, ay = aim.y - my, ad = Math.hypot(ax, ay) || 1;
  out[0] = full ? 1 : 0;
  out[1] = full && k <= 7 ? 1 : 0;                       // a full split that does more than a single one
  out[2] = k / 16; out[3] = other.length / 16;
  out[4] = share;
  out[5] = ahead >= 0 ? 1 : -1;                           // the splitting unit is in front
  out[6] = splitMass / um;                                // how much of the unit splits
  out[7] = n / 8; out[8] = small / 8;
  out[9] = n ? Math.log10(minS / s2) / 4 : 0; out[10] = n ? Math.log10(maxS / s2) / 4 : 0;
  out[11] = canEat;                                       // a half can eat a cell of the other unit
  out[12] = n ? edible / n : 0;                           // halves the other unit's biggest can eat
  out[13] = Math.max(-2, Math.min(2, Math.log(maxMine / maxOther))) / 2;
  out[14] = k + n >= 16 ? 1 : 0;                          // takes the unit to 16 cells
  out[15] = share < 0.35 && !canEat ? 1 : 0;              // the lighter unit splits and can eat nothing
  out[16] = Math.min(ctx.sinceSplit, 50) / 50; out[17] = ctx.sameUnit ? 1 : 0; out[18] = Math.min(ctx.sinceTab, 50) / 50;
  out[19] = Math.min(Math.hypot(mx - ox, my - oy) / s, 8000) / 4000;
  out[20] = mine[0].mass === maxMine ? 1 : 0;             // the oldest cell (first to split) is the biggest
  out[21] = splitMass ? Math.max(-1, Math.min(1, along / splitMass / s / 2000)) : 0; // splitting cells ahead of / behind the unit
  out[22] = (ax * H.x + ay * H.y) / ad;                    // cursor: ahead (1) .. behind (-1)
  out[23] = (ax * -H.y + ay * H.x) / ad;                   // cursor: to the side
  return out;
}
const flip = (x) => { const y = Float32Array.from(x); y[23] = -y[23]; return y; };

let NET;
export function pressNet() {
  if (NET === undefined) { const f = here('./data/press.json'); NET = existsSync(f) ? new MLP(PRESS_SIZES, JSON.parse(readFileSync(f, 'utf8'))) : null; }
  return NET;
}
// For the planner: the log-odds that a split of the active unit of Game g, with the cursor at
// `aim`, is one you would make. H: the run's direction.
export function pressLogit(net, g, full, H, aim, ctx, buf) {
  const cells = [];
  for (let u = 0; u < 2; u++) for (const k of g.cells(u)) cells.push({ unit: u, x: k.x, y: k.y, mass: k.mass });
  return net.forward(pressInput(cells, g.active, full, H, aim, ctx, buf))[0];
}

// Every split press of a recording (that splits something), as network inputs.
export function recordingPresses(rec, skip = 0) {
  const byTick = new Map(rec.frames.map((f) => [f.tick, f]));
  const bad = new Set(); let on = null; // ticks around W held (feeding) are left out
  for (const e of rec.events) if (e.ev === 'feedHold') { if (e.on) on = e.tick; else if (on != null) { for (let t = on - 25; t <= e.tick + 75; t++) bad.add(t); on = null; } }
  const resets = rec.events.filter((e) => e.ev === 'reset').map((e) => e.tick);
  const cen = (cs) => { let m = 0, x = 0, y = 0; for (const c of cs) { m += c.mass; x += c.x * c.mass; y += c.y * c.mass; } return m ? { x: x / m, y: y / m } : null; };
  const out = [], t0 = rec.frames[0].tick + skip, aims = {};
  let lastSplit = -1e9, lastTab = -1e9, lastUnit = -1;
  for (const e of rec.events) {
    if (e.ev === 'aim') { aims[e.pid & 1] = { x: e.x, y: e.y }; continue; }
    if (e.ev === 'tab') { lastTab = e.tick; continue; }
    if (e.ev !== 'split') continue;
    const T = e.tick, u = e.pid & 1, ctx = { sinceSplit: T - lastSplit, sinceTab: T - lastTab, sameUnit: u === lastUnit };
    lastSplit = T; lastUnit = u;
    if (T < t0 || bad.has(T) || resets.some((r) => r >= T - 25 && r <= T)) continue;
    const f = byTick.get(T), back = byTick.get(T - 50); if (!f || !back || !aims[u]) continue;
    const cells = f.cells.map(([id, pid, x, y, mass]) => ({ id, unit: pid & 1, x, y, mass })).sort((a, b) => a.id - b.id);
    const mine = cells.filter((c) => c.unit === u);
    if (!mine.length || mine.length >= 16 || mine.length === cells.length || !mine.some((c) => c.mass >= 44)) continue;
    const a = cen(back.cells.map(([, , x, y, mass]) => ({ x, y, mass }))), b = cen(cells); if (!a || !b) continue;
    const d = Math.hypot(b.x - a.x, b.y - a.y); if (d < 50) continue;
    out.push(pressInput(cells, u, (e.n ?? 1) >= 4, { x: (b.x - a.x) / d, y: (b.y - a.y) / d }, aims[u], ctx));
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { trainClassifier, separation } = await import('./look.mjs');
  const args = process.argv.slice(2);
  const from = args[args.indexOf('--from') + 1];
  if (!args.includes('--from') || !from) { console.log('usage: node bot/press.mjs --from <dir with bot recordings> [--test]'); process.exit(1); }
  const human = readdirSync(here('../../recordings')).filter((f) => f.endsWith('.jsonl.gz')).sort();
  const Hs = human.map((f) => recordingPresses(loadRecording(here('../../recordings/' + f)), SKIP));
  const bots = readdirSync(from).filter((f) => f.endsWith('.jsonl.gz')).sort();
  const Bs = bots.map((f) => recordingPresses(loadRecording(from + '/' + f), 625));
  console.log(`your presses: ${Hs.map((x) => x.length).join(' + ')}; bot presses: ${Bs.flat().length} in ${bots.length} games`);
  // held out: your last recording and the last 1/8 of the bot games
  const cut = Math.floor(Bs.length * 7 / 8);
  const net = trainClassifier(Hs.slice(0, -1).flat(), Bs.slice(0, cut).flat(), { sizes: PRESS_SIZES, flip, epochs: 30, quiet: true });
  const sep = separation(net, Hs.at(-1), Bs.slice(cut).flat());
  console.log(`held out: accuracy ${(100 * sep.acc).toFixed(1)}%, AUC ${sep.auc.toFixed(3)}; mean "yours" on your presses ${sep.meanP.yours.toFixed(2)}, on the bot's ${sep.meanP.bot.toFixed(2)}`);
  if (!args.includes('--test')) {
    const full = trainClassifier(Hs.flat(), Bs.flat(), { sizes: PRESS_SIZES, flip, epochs: 30, quiet: true });
    writeFileSync(here('./data/press.json'), JSON.stringify({ trainedAt: new Date().toISOString(), yours: Hs.flat().length, bot: Bs.flat().length, botGames: from, heldOut: { acc: sep.acc, auc: sep.auc }, ...full.save() }));
    console.log('saved data/press.json');
  }
}
