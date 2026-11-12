// Checks bot/v3/sim.mjs against the server's own rules (server/world.mjs): both play the same
// random keys from the four start positions and every cell is compared every tick.
//   node bot/v3/validate-sim.mjs [ticks]
import { World, Player, Type } from '../../server/world.mjs';
import baseConfig from '../../server/config.mjs';
import { Sim } from './sim.mjs';
import { place } from './starts.mjs';

const TICKS = Number(process.argv[2] ?? 300000);
const cfg = { ...baseConfig, infiniteField: true, decayBase: 0, decayPerMass: 0, pelletCount: 0, virusCount: 0 };

function makeWorld(state) {
  const w = new World({ ...cfg }), p = new Player(2);
  p.noDecay = true; w.players.set(2, p); w.now = state.now;
  for (const s of state.cells) {
    const unit = p.units[s.unit], c = w.add(Type.PLAYER, s.x, s.y, s.mass);
    w.cells.delete(c.id); c.id = s.id; w.cells.set(c.id, c);
    c.owner = unit.playerId; c.unit = unit; c.boost = s.boost; c.angle = s.angle; c.born = s.born; c.mergeAt = s.mergeAt;
    unit.cells.push(c);
  }
  w.nextId = state.nextId; p.playing = true; p.activeUnit = state.active;
  for (const u of [0, 1]) { p.units[u].aim = { ...state.aim[u] }; p.units[u].splitQueue = state.splitQueue[u]; }
  return { w, p };
}

let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
let pos = 0, state = place(pos, { angle: rnd() * 6.28 });
let { w, p } = makeWorld(state); const sim = new Sim().load(state);
let worst = 0, mismatches = 0, resets = 0, eats = 0, autos = 0, compared = 0;
const t0 = performance.now();
for (let t = 0; t < TICKS; t++) {
  // random keys, about as often as a player presses them
  if (rnd() < 0.12) {
    const u = p.activeUnit, cs = p.units[u].cells, c = cs[Math.floor(rnd() * cs.length)], o = p.units[u ^ 1].cells;
    const tgt = rnd() < 0.4 && o.length ? o[Math.floor(rnd() * o.length)] : c;
    const a = rnd() * 6.28, r = rnd() < 0.4 ? rnd() * 500 : 500 + rnd() * 4000;
    const x = tgt.x + Math.cos(a) * r, y = tgt.y + Math.sin(a) * r;
    p.units[u].aim = { x, y }; sim.aim(x, y);
  }
  if (rnd() < 0.05 && p.units[p.activeUnit ^ 1].cells.length) { p.activeUnit ^= 1; sim.tab(); }
  if (rnd() < 0.06) { const n = [1, 1, 1, 2, 4][Math.floor(rnd() * 5)]; w.requestSplit(p.active, n); sim.split(n); }
  w.tick(w.now + cfg.tickMs); sim.tick();
  // compare
  let bad = sim.active !== p.activeUnit || sim.autoSplits > autos;
  for (let u = 0; u < 2 && !bad; u++) {
    const cs = p.units[u].cells;
    if (cs.length !== sim.n(u)) { bad = true; break; }
    for (let k = 0; k < cs.length; k++) {
      const a = cs[k], b = sim.cell(u, k);
      const e = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.mass - b.mass), Math.abs(a.boost - b.boost), Math.abs((a.mergeAt ?? 0) - b.mergeAt), a.id === b.id ? 0 : 1e9);
      if (e > worst) worst = e;
      if (e > 0.01) bad = true;   // (the sim uses sqrt where the server uses hypot: the last digit can differ)
      compared++;
    }
  }
  const auto = sim.autoSplits > autos; autos = sim.autoSplits; eats = sim.eats;
  if (bad && !auto) { mismatches++; if (mismatches <= 5) console.log(`MISMATCH at tick ${t}: cells ${p.units.map((u) => u.cells.length)} vs ${sim.n(0)},${sim.n(1)}`); }
  const lost = !p.units[0].cells.length || !p.units[1].cells.length;
  if (bad || lost || t % 3000 === 2999) { // an auto split throws in a random direction: start both again
    resets++; pos++;
    const cx = p.center() ?? { x: 0, y: 0 };
    state = place(pos, { at: cx, angle: rnd() * 6.28, now: w.now, idBase: w.nextId });
    ({ w, p } = makeWorld(state)); sim.load(state); autos = 0;
  }
}
const secs = (performance.now() - t0) / 1000;
console.log(`${TICKS} ticks, ${compared} cell states compared, ${eats} eats in the last stretch, ${resets} restarts`);
// The sim uses sqrt(dx*dx+dy*dy) where the server uses Math.hypot (four times slower): the last
// digit can differ, and in a pile of cells sitting on one spot that grows to a few hundredths
// of a unit before the next restart. With Math.hypot in sim.mjs this prints 0 and 0.
console.log(`drifted apart by more than 0.01 units: ${mismatches} times in ${TICKS} ticks   largest difference in any number: ${worst.toExponential(2)}`);
// speed
{ const s = new Sim().load(place(1)); const t1 = performance.now(); let n = 0;
  for (let i = 0; i < 400000; i++) { if (i % 12 === 0) { const c = s.unitCentre(s.active); s.aim(c.x + 3000, c.y + (rnd() - 0.5) * 2000); if (!s.lost) { s.tab(); s.split(1); } else s.load(place(i)); } s.tick(); n++; }
  console.log(`sim speed: ${Math.round(n / (performance.now() - t1) * 1000)} ticks/s (both together above: ${Math.round(TICKS / secs)} ticks/s)`); }
process.exit(mismatches > TICKS / 10000 ? 1 : 0);
