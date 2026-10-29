// Unit tests for world rules that are easier to check without a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, Player } from './world.mjs';
import config from './config.mjs';

// Decay is off unless a test turns it on, so masses stay exact.
const make = (over = {}) => {
  const w = new World({ ...config, decayBase: 0, decayPerMass: 0, ...over });
  const p = new Player(2); w.players.set(2, p);
  return { w, p };
};
const tick = (w, ms) => { for (let t = 0; t < ms; t += config.tickMs) { w.tick(w.now + config.tickMs); } };

test('merge timer is 30 s + 2% of mass and starts at the split', () => {
  const { w, p } = make(); w.now = 1000;
  w.spawnUnit(p.units[0]);
  p.units[0].cells[0].mass = 2000;
  w.split(p.units[0], 1);
  for (const c of p.units[0].cells) assert.equal(c.mergeAt - 1000, (30 + 0.02 * 1000) * 1000); // halves are 1000 mass -> 50 s
});

test('cells do not merge before both timers expire, then do', () => {
  const { w, p } = make({ recombineBaseSec: 2, recombineMassFactor: 0 }); w.now = 0;
  w.spawnUnit(p.units[0]);
  const u = p.units[0];
  w.split(u, 1);
  u.aim = { x: u.cells[0].x, y: u.cells[0].y };
  tick(w, 1800);
  assert.equal(u.cells.length, 2, 'still split at 1.8 s');
  tick(w, 3000);
  assert.equal(u.cells.length, 1, 'merged after the 2 s timer');
});

test('re-splitting restarts the timer', () => {
  const { w, p } = make({ recombineBaseSec: 2, recombineMassFactor: 0 }); w.now = 0;
  w.spawnUnit(p.units[0]); const u = p.units[0];
  w.split(u, 1); tick(w, 1500);
  w.split(u, 1); // both previous halves split again at 1.5 s
  assert.ok(u.cells.every((c) => c.mergeAt >= 1500 + 2000 - config.tickMs));
});

test('infinite field: nothing is clamped', () => {
  const { w, p } = make();
  w.spawnUnit(p.units[0]); const c = p.units[0].cells[0];
  c.x = -50000; c.y = 90000; w.clamp(c);
  assert.deepEqual([c.x, c.y], [-50000, 90000]);
});

test('second unit spawns at the cursor when close, capped when far (no scatter)', () => {
  const { w, p } = make({ secondUnitScatter: 0 }); w.now = 0;
  w.spawnUnit(p.units[0]); const first = p.units[0].cells[0];
  first.x = 0; first.y = 0;
  p.pointer = { x: 500, y: 0 };
  w.spawnSecondUnit(p, p.units[1]);
  assert.deepEqual([p.units[1].cells[0].x, p.units[1].cells[0].y], [500, 0]);

  const { w: w2, p: p2 } = make({ secondUnitScatter: 0 }); w2.now = 0;
  w2.spawnUnit(p2.units[0]); const f2 = p2.units[0].cells[0];
  f2.x = 0; f2.y = 0;
  p2.pointer = { x: 0, y: 100000 };
  w2.spawnSecondUnit(p2, p2.units[1]);
  const s = p2.units[1].cells[0];
  const max = f2.r + config.secondUnitMaxDist;
  assert.ok(Math.abs(s.y - max) < 1e-6 && Math.abs(s.x) < 1e-6, `capped at ${s.y}, expected ${max}`);
});

test('second unit lands within secondUnitScatter of the cursor, in random spots (measured on Caffe)', () => {
  const spots = [];
  for (let k = 0; k < 40; k++) {
    const { w, p } = make(); w.now = 0;
    w.spawnUnit(p.units[0]); Object.assign(p.units[0].cells[0], { x: 0, y: 0 });
    p.pointer = { x: 1500, y: 0 };
    w.spawnSecondUnit(p, p.units[1]);
    const c = p.units[1].cells[0]; spots.push(Math.hypot(c.x - 1500, c.y));
  }
  assert.ok(spots.every((d) => d <= config.secondUnitScatter + 1e-6));
  assert.ok(new Set(spots.map(Math.round)).size > 30, 'random, not one fixed spot');
});

test('no pellets or viruses by default', () => {
  const { w } = make(); tick(w, 400);
  assert.equal(w.pelletCount, 0); assert.equal(w.virusCount, 0);
});

test('your two units can eat each other (split running)', () => {
  const { w, p } = make(); w.now = 0;
  w.spawnUnit(p.units[0]); const big = p.units[0].cells[0];
  big.x = 0; big.y = 0; big.mass = 1000;
  w.spawnUnit(p.units[1], { x: 0, y: 0 }); const small = p.units[1].cells[0];
  small.mass = 200; small.x = 20; small.y = 0;
  p.units.forEach((u) => (u.aim = { x: 0, y: 0 }));
  w.tick(40);
  assert.equal(p.units[1].cells.length, 0, 'unit 1 was eaten by unit 0');
  assert.ok(Math.abs(big.mass - 1200) < 1e-9);
  assert.ok(p.alive, 'still alive through unit 0');
});

test('cells of the same unit never eat each other before the merge timer', () => {
  const { w, p } = make(); w.now = 0;
  w.spawnUnit(p.units[0]); const u = p.units[0];
  u.cells[0].mass = 2000; w.split(u, 1);
  const [a, b] = u.cells; a.mass = 1800; b.mass = 200; b.x = a.x; b.y = a.y; b.boost = 0; u.aim = { x: a.x, y: a.y };
  tick(w, 2000);
  assert.equal(u.cells.length, 2);
});

test('the ownUnitsCanEatEachOther switch turns it off', () => {
  const { w, p } = make({ ownUnitsCanEatEachOther: false }); w.now = 0;
  w.spawnUnit(p.units[0]); p.units[0].cells[0].mass = 1000;
  w.spawnUnit(p.units[1], { x: p.units[0].cells[0].x, y: p.units[0].cells[0].y }); p.units[1].cells[0].mass = 200;
  w.tick(40);
  assert.equal(p.units[1].cells.length, 1);
});

test('Tab never spawns the second unit inside a cell that would eat it', () => {
  for (let t = 0; t < 200; t++) {
    const { w, p } = make({ secondUnitScatter: 3000 }); w.now = 0;
    w.spawnUnit(p.units[0], { x: 0, y: 0 }); p.units[0].cells[0].mass = 20000; // radius about 1414
    p.pointer = { x: 0, y: 0 };                                                // cursor right on it
    w.spawnSecondUnit(p, p.units[1]);
    const b = p.units[1].cells[0], a = p.units[0].cells[0];
    assert.ok(Math.hypot(b.x - a.x, b.y - a.y) >= a.r + b.r, 'not on top of it');
    w.tick(40);
    assert.equal(p.units[1].cells.length, 1, 'still alive after a tick');
  }
});

test('the unit you control dies: control goes to your other unit', () => {
  const { w, p } = make(); w.now = 0;
  w.spawnUnit(p.units[0], { x: 0, y: 0 }); w.spawnUnit(p.units[1], { x: 3000, y: 0 });
  p.activeUnit = 1;
  w.remove(p.units[1].cells[0], true);
  assert.equal(p.activeUnit, 0);
  // with no other unit alive, nothing to switch to
  w.remove(p.units[0].cells[0], true);
  assert.equal(p.activeUnit, 0);
});

test('viruses grow 16 per feed and shoot on the 7th', () => {
  const { w } = make(); w.now = 0;
  const v = w.add(2, 0, 0, 100); w.buildGrid();
  for (let i = 0; i < 6; i++) { const e = w.add(3, 0, 0, 15); e.angle = 0; w.buildGrid(); w.resolveVirusFeeding(); }
  assert.equal(v.mass, 196);
  const e = w.add(3, 0, 0, 15); e.angle = 0; w.buildGrid(); w.resolveVirusFeeding();
  assert.equal(v.mass, 100);
  assert.equal([...w.cells.values()].filter((x) => x.type === 2).length, 2);
});

test('continuous feed ejects from every cell on every tick (measured on Caffe)', () => {
  const { w, p } = make(); w.now = 0;
  w.spawnUnit(p.units[0]); const u = p.units[0];
  u.cells[0].mass = 2000; u.aim = { x: u.cells[0].x + 1000, y: u.cells[0].y };
  p.feedHold = true;
  const count = () => [...w.cells.values()].filter((c) => c.type === 3).length;
  for (let i = 0; i < 25; i++) w.tick(w.now + 40); // one second
  assert.equal(count(), 25);
});

// ---- split order: oldest cells first (Ogar's splitCells / Senpai's split order marker) ----
function unitWithCells(w, p, masses) {
  const u = p.units[0];
  w.spawnUnit(u); u.cells[0].mass = masses[0];
  for (let i = 1; i < masses.length; i++) {
    const c = w.add(0, u.cells[0].x + i * 300, u.cells[0].y, masses[i]);
    c.owner = u.playerId; c.unit = u; u.cells.push(c);
  }
  u.aim = { x: u.cells[0].x, y: u.cells[0].y - 1000 };
  return u;
}

test('split order: the oldest cells split first, not the biggest', () => {
  const { w, p } = make(); w.now = 0;
  // 16 cells, oldest first; the two newest are the biggest
  const masses = Array.from({ length: 16 }, (_, i) => (i >= 14 ? 5000 : 100 + i));
  const u = unitWithCells(w, p, masses);
  const oldest = u.cells.slice(0, 2), biggest = u.cells.slice(14);
  // an enemy eats two cells from the middle: 14 left, so 2 may split
  w.remove(u.cells[5]); w.remove(u.cells[6]);
  assert.equal(u.cells.length, 14);
  w.split(u, 1);
  assert.equal(u.cells.length, 16);
  assert.deepEqual(oldest.map((c) => c.mass), [50, 50.5], 'the two oldest halved');
  assert.deepEqual(biggest.map((c) => c.mass), [5000, 5000], 'the big new ones did not split');
  assert.deepEqual(u.cells.slice(14).map((c) => c.mass), [50, 50.5], 'their halves are appended as the newest');
});

test('split order: cells under the minimum mass are skipped without using a slot', () => {
  const { w, p } = make(); w.now = 0;
  const u = unitWithCells(w, p, [30, 40, 200, 300]); // 30 and 40 are under 44
  w.split(u, 1);
  assert.deepEqual(u.cells.map((c) => c.mass), [30, 40, 100, 150, 100, 150]);
});

test('split order: a double split is two passes; the first pass halves come last', () => {
  const { w, p } = make(); w.now = 0;
  const u = unitWithCells(w, p, [800, 400]);
  const [a, b] = u.cells;
  w.split(u, 2);
  // pass 1: a -> a,a1 ; b -> b,b1   => [a, b, a1, b1]
  // pass 2: each of those splits again, in that order => + [a2, b2, a1', b1']
  assert.equal(u.cells.length, 8);
  assert.equal(u.cells[0], a); assert.equal(u.cells[1], b);
  assert.deepEqual(u.cells.map((c) => c.mass), [200, 100, 200, 100, 200, 100, 200, 100]);
});

test('split order survives merging: the bigger cell keeps its place', () => {
  const { w, p } = make({ recombineBaseSec: 0, recombineMassFactor: 0 }); w.now = 0;
  const u = unitWithCells(w, p, [100, 900, 300]);
  const [old, big, last] = u.cells;
  big.x = old.x; big.y = old.y; big.mergeAt = 0; old.mergeAt = 0;
  w.resolveOwnCells(u);
  assert.deepEqual(u.cells, [big, last], 'old merged into big; big stays ahead of last');
});

test('auto split: a cell over 22500 throws half off in a random direction', () => {
  const { w, p } = make(); w.now = 0;
  w.spawnUnit(p.units[0]); const u = p.units[0];
  u.cells[0].mass = 22500; tick(w, 40);
  assert.equal(u.cells.length, 1, 'exactly at the limit does not split');
  u.cells[0].mass = 24000; tick(w, 40);
  assert.equal(u.cells.length, 2);
  assert.deepEqual(u.cells.map((c) => c.mass), [12000, 12000]);
  assert.ok(u.cells[1].boost > 0, 'the new half flies off with split speed');
  assert.ok(u.cells.every((c) => c.mergeAt > 0), 'both halves get a merge timer');
});

test('auto split: a huge cell keeps halving, one round per tick, until under the limit', () => {
  const { w, p } = make(); w.now = 0;
  w.spawnUnit(p.units[0]); const u = p.units[0];
  u.cells[0].mass = 60000;
  tick(w, 40); assert.equal(u.cells.length, 2);
  tick(w, 40); assert.equal(u.cells.length, 4);
  tick(w, 40); assert.equal(u.cells.length, 4, '15000 pieces are under the limit');
  assert.ok(u.cells.every((c) => c.mass <= 22500));
});

test('auto split: with 16 cells the mass is capped at the limit instead', () => {
  const { w, p } = make(); w.now = 0;
  w.spawnUnit(p.units[0]); const u = p.units[0];
  u.cells[0].mass = 6400; w.split(u, 4);
  assert.equal(u.cells.length, 16);
  u.cells[3].mass = 30000; tick(w, 40);
  assert.equal(u.cells.length, 16);
  assert.equal(u.cells[3].mass, 22500);
});

test('auto split can be turned off', () => {
  const { w, p } = make({ autoSplitMass: 0 }); w.now = 0;
  w.spawnUnit(p.units[0]); const u = p.units[0];
  u.cells[0].mass = 40000; tick(w, 200);
  assert.equal(u.cells.length, 1);
  assert.equal(u.cells[0].mass, 40000);
});

test('mass decay: every tick, faster for bigger cells (measured on Caffe)', () => {
  const { w, p } = make({ decayBase: config.decayBase, decayPerMass: config.decayPerMass }); w.now = 0;
  w.spawnUnit(p.units[0]); w.spawnUnit(p.units[1], { x: 5000, y: 0 });
  const [a] = p.units[0].cells, [b] = p.units[1].cells;
  a.mass = 3000; b.mass = 11400;
  p.units.forEach((u) => (u.aim = { x: u.cells[0].x, y: u.cells[0].y }));
  w.tick(40);
  assert.ok(a.mass < 3000 && a.mass > 2999.8, 'decays a little on every tick');
  for (let i = 1; i < 25; i++) w.tick(40 * (i + 1)); // one second in all
  const pa = (1 - a.mass / 3000) * 100, pb = (1 - b.mass / 11400) * 100;
  assert.ok(Math.abs(pa - 0.149) < 0.003, `3000 loses ~0.149 %/s, got ${pa}`);
  assert.ok(Math.abs(pb - 0.169) < 0.003, `11400 loses ~0.169 %/s, got ${pb}`);
});

test('mass decay: a unit at or below 399 in total keeps its mass, small pieces of a big unit decay', () => {
  const { w, p } = make({ decayBase: config.decayBase, decayPerMass: config.decayPerMass }); w.now = 0;
  w.spawnUnit(p.units[0], { x: 0, y: 0 }); w.spawnUnit(p.units[1], { x: 9000, y: 0 });
  const u0 = p.units[0], u1 = p.units[1];
  u0.cells[0].mass = 399; w.split(u0, 1);                 // two 199.5 halves, 399 in total
  u1.cells[0].mass = 8000; w.split(u1, 3);                // 8 pieces of 1000
  u1.cells[7].mass = 155;                                 // one small piece in a big unit
  p.units.forEach((u) => (u.aim = { x: u.cells[0].x, y: u.cells[0].y }));
  for (let i = 0; i < 25; i++) w.tick(40 * (i + 1));
  assert.deepEqual(u0.cells.map((c) => c.mass), [199.5, 199.5], 'no decay at 399 total');
  assert.ok(u1.cells[7].mass < 155, 'the small piece of the big unit decays');
});

test('mass decay stops once a unit reaches 399', () => {
  const { w, p } = make({ decayBase: config.decayBase, decayPerMass: config.decayPerMass }); w.now = 0;
  w.spawnUnit(p.units[0]); const c = p.units[0].cells[0]; c.mass = 401;
  p.units[0].aim = { x: c.x, y: c.y };
  for (let i = 0; i < 25 * 30; i++) w.tick(40 * (i + 1));
  assert.ok(c.mass <= 399 && c.mass > 398.9, `stops at 399, got ${c.mass}`);
});

test('stop motion freezes both units, and releasing moves both again', () => {
  const { w, p } = make(); w.now = 0;
  w.spawnUnit(p.units[0], { x: 0, y: 0 }); w.spawnUnit(p.units[1], { x: 3000, y: 0 });
  p.units[0].aim = { x: 0, y: 2000 }; p.units[1].aim = { x: 3000, y: 2000 };
  p.frozen = true;
  w.tick(40); w.tick(80);
  assert.deepEqual(p.units.map((u) => [u.cells[0].x, u.cells[0].y]), [[0, 0], [3000, 0]], 'neither unit moves');
  p.frozen = false;
  w.tick(120);
  assert.ok(p.units.every((u) => u.cells[0].y > 0), 'both move again');
});

test('full split: one pass per tick, 1 -> 2 -> 4 -> 8 -> 16 (measured on Caffe)', () => {
  const { w, p } = make(); w.now = 0;
  w.spawnUnit(p.units[0], { x: 0, y: 0 }); const u = p.units[0];
  u.cells[0].mass = 409; u.aim = { x: 5000, y: 0 };
  w.requestSplit(u, 4);
  const counts = [u.cells.length];
  for (let i = 1; i <= 5; i++) { w.tick(40 * i); counts.push(u.cells.length); }
  assert.deepEqual(counts, [1, 2, 4, 8, 16, 16], 'nothing until the next tick, then one pass per tick');
  assert.equal(u.splitQueue, 0);
});

test('full split pieces spread along the throw line instead of stacking on one spot', () => {
  const { w, p } = make(); w.now = 0;
  w.spawnUnit(p.units[0], { x: 0, y: 0 }); const u = p.units[0];
  u.cells[0].mass = 16000; u.aim = { x: 1e6, y: 0 };
  w.requestSplit(u, 4);
  for (let i = 1; i <= 5; i++) w.tick(40 * i);
  const spots = (cells) => new Set(cells.map((c) => Math.round(c.x / 5))).size;
  assert.equal(u.cells.length, 16);
  // the old behaviour, all four passes in one tick, for comparison
  w.spawnUnit(p.units[1], { x: 0, y: 5000 }); const v = p.units[1];
  v.cells[0].mass = 16000; v.aim = { x: 1e6, y: 5000 };
  w.split(v, 4); w.tick(200);
  assert.ok(spots(v.cells) <= 2, `all at once: ${spots(v.cells)} spots`);
  assert.ok(spots(u.cells) >= 8, `one pass per tick: pieces at ${spots(u.cells)} spots`);
});

test('a full split keeps its 4 passes even when one splits nothing, refilling eaten slots (Caffe log)', () => {
  const { w, p } = make(); w.now = 0;
  w.spawnUnit(p.units[0], { x: 0, y: 0 }); const u = p.units[0];
  u.cells[0].mass = 16000; u.aim = { x: 5000, y: 0 };
  w.split(u, 4); assert.equal(u.cells.length, 16);
  w.requestSplit(u, 4);
  w.tick(40); assert.equal(u.cells.length, 16, 'pass 1: full, nothing to split');
  assert.equal(u.splitQueue, 3, 'the empty pass does not cancel the rest');
  w.remove(u.cells[3], true); w.remove(u.cells[5], true); // two pieces get eaten
  w.tick(80); assert.equal(u.cells.length, 16, 'pass 2 refills both free slots');
  w.tick(120); w.tick(160); assert.equal(u.splitQueue, 0, 'exactly 4 passes');
});

test('split pieces are thrown at the measured speed (194.1 at mass 204, 195.4 at 25, 190.7 at 8000)', () => {
  const { w, p } = make(); w.now = 0;
  w.spawnUnit(p.units[0]); const u = p.units[0]; u.aim = { x: 1e6, y: 0 };
  u.cells[0].mass = 408; w.split(u, 1);
  assert.ok(Math.abs(u.cells[1].boost - 194.1) < 0.3, `got ${u.cells[1].boost}`);
  w.spawnUnit(p.units[1]); const v = p.units[1]; v.aim = { x: 1e6, y: 0 };
  v.cells[0].mass = 50; w.split(v, 1);
  assert.ok(Math.abs(v.cells[1].boost - 195.4) < 0.3, `got ${v.cells[1].boost}`);
  w.spawnUnit(p.units[1]); v.cells[0].mass = 16000; v.cells.length = 1; w.split(v, 1);
  assert.ok(Math.abs(v.cells.at(-1).boost - 190.67) < 0.05, `got ${v.cells.at(-1).boost}`);
});

test('walls (Map Walls setting): a cell stops half its radius inside, pushes may go past (Caffe)', () => {
  const { w, p } = make({ infiniteField: false, field: { minX: 0, minY: 0, maxX: 32000, maxY: 32000 } });
  w.spawnUnit(p.units[0], { x: 31000, y: 16000 }); const u = p.units[0];
  u.cells[0].mass = 1380; u.aim = { x: 40000, y: 16000 };
  for (let i = 1; i <= 200; i++) w.tick(40 * i);
  assert.ok(Math.abs(u.cells[0].x - (32000 - u.cells[0].r / 2)) < 1e-6, `x ${u.cells[0].x}`);
});

test('a new split piece is sent at its birth spot, then decays its boost before moving (Caffe)', () => {
  const { w, p } = make(); w.now = 0;
  w.spawnUnit(p.units[0], { x: 0, y: 0 }); const u = p.units[0];
  u.cells[0].mass = 408; u.aim = { x: 1e6, y: 0 };
  w.requestSplit(u, 1); w.tick(40);
  const [parent, child] = u.cells;
  assert.equal(child.x, parent.x, 'born on the parent centre this tick');
  assert.ok(Math.abs(child.boost - 194.1) < 0.3);
  const x0 = child.x; w.tick(80);
  const step = child.x - x0, normal = config.speedCoefficient * Math.pow(child.r, config.speedExponent);
  assert.ok(Math.abs(child.boost - 194.1 * 0.8866) < 0.3, 'boost decayed first');
  assert.ok(Math.abs(step - (child.boost / 2 + normal)) < 0.5, `step ${step}`);
});

test('ejected mass is sent at the old edge before it flies 103.1, and costs 15.5', () => {
  const { w, p } = make(); w.now = 0;
  w.spawnUnit(p.units[0], { x: 0, y: 0 }); const u = p.units[0]; const c = u.cells[0];
  u.aim = { x: 1e6, y: 0 }; p.frozen = true;
  const r0 = c.r;
  w.requestEject(u); w.tick(40);
  const e = [...w.cells.values()].find((q) => q.type === 3);
  assert.ok(Math.abs(Math.hypot(e.x - c.x, e.y - c.y) - r0) < 1e-6, 'at the edge before the mass came off');
  assert.equal(c.mass, 399 - 15.5);
  const x0 = e.x; w.tick(80);
  assert.ok(Math.abs(Math.hypot(e.x - x0, e.y) - 103.1) < 3, 'first step ~103.1');
});

test('an eaten cell is kept in ghosts for the update of the tick it was eaten, then dropped', () => {
  const { w, p } = make(); w.now = 0;
  const q = new Player(4); w.players.set(4, q);
  w.spawnUnit(p.units[0], { x: 0, y: 0 }); w.spawnUnit(q.units[0], { x: 0, y: 0 });
  const big = p.units[0].cells[0], small = q.units[0].cells[0];
  big.mass = 2000; small.mass = 100; small.x = 10;
  p.units[0].aim = { x: 0, y: 0 }; q.units[0].aim = { x: 10, y: 0 };
  w.tick(w.now + config.tickMs);
  assert.ok(small.dead, 'eaten');
  assert.deepEqual(w.ghosts.map((g) => g.id), [small.id]);
  assert.ok(Math.abs(big.mass - 2100) < 1, 'the eater has already gained the mass');
  w.tick(w.now + config.tickMs);
  assert.deepEqual(w.ghosts, []);
});

// Recorded on Caffe: one 5018 cell split, split on the next tick, then split again 120 ms
// later (8 pieces of 626), aiming far to the right. x of each piece (in order of creation)
// relative to the cell's position in the tick of the first split.
const CAFFE_2_DELAY_1 = {
  18: [165.6, 829.5, 820.9, 906, 780.6, 1067.3, 1008.8, 1093.9],   // still passing through each other
  19: [173.2, 1396.2, 499.1, 1302.1, 550.2, 1187, 720.3, 1000.4],  // 15 ticks after the 3rd split: pushed
  20: [122.5, 1563, 390.6, 1376.9, 547.9, 1247, 711.9, 1013.8],
  25: [-98.3, 1972.8, 253.4, 1646.7, 531.8, 1389.9, 766, 1113],
  45: [-370.2, 2636.1, 81.9, 2184.7, 506.9, 1762.6, 916.8, 1354.1], // still spreading out
};
test('2 splits > short delay > split spreads out exactly like Caffe (half-overlap pushes, 15-tick pass-through)', () => {
  const { w, p } = make();
  const u = p.units[0]; w.spawnUnit(u, { x: 0, y: 0 }); u.cells[0].mass = 5018; u.aim = { x: 6000, y: 0 };
  const xs = [];
  for (let k = 0; k <= 45; k++) {
    if (k === 0 || k === 1 || k === 4) w.requestSplit(u, 1);
    w.tick(w.now + config.tickMs);
    xs.push([...u.cells].sort((a, b) => a.id - b.id).map((c) => c.x));
  }
  const off = 34.1 - xs[0][0]; // Caffe's parent was at 34.1 in that update
  for (const [k, want] of Object.entries(CAFFE_2_DELAY_1)) {
    xs[k].forEach((x, i) => assert.ok(Math.abs(x + off - want[i]) < 8, `tick ${k} piece ${i}: ${(x + off).toFixed(1)} vs Caffe ${want[i]}`));
  }
});

test('a player can switch mass decay off (Mass decay setting) without affecting others', () => {
  const { w, p } = make({ decayBase: 0.001427, decayPerMass: 2.33e-8 });
  const q = new Player(4); w.players.set(4, q);
  w.spawnUnit(p.units[0], { x: 0, y: 0 }); w.spawnUnit(q.units[0], { x: 5000, y: 0 });
  p.units[0].cells[0].mass = 5000; q.units[0].cells[0].mass = 5000;
  p.noDecay = true;
  tick(w, 4000);
  assert.equal(p.units[0].cells[0].mass, 5000, 'no decay for the player who turned it off');
  assert.ok(q.units[0].cells[0].mass < 4980, 'still decays for everyone else');
});
