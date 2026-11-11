// Headless game for training: the server's own World (server/world.mjs), so the bot learns
// the exact rules you play by, with no network and no clock. Always mass decay OFF and map
// walls OFF (infinite field). Only the inputs a player has: cursor, split (1, 2 or 4
// passes), Tab. No feeding, no freeze.
import { World, Player, Type } from '../server/world.mjs';
import baseConfig from '../server/config.mjs';

export const TRAIN_CONFIG = Object.freeze({
  ...baseConfig,
  infiniteField: true,              // map walls OFF
  decayBase: 0, decayPerMass: 0,    // mass decay OFF
  pelletCount: 0, virusCount: 0,
  secondUnitScatter: 0,
});
export const ALLOWED_SPLITS = [1, 2, 4]; // split, double split, full split

export class Game {
  constructor(state, cfg = TRAIN_CONFIG) {
    this.cfg = cfg;
    const w = (this.world = new World({ ...cfg }));
    const p = (this.player = new Player(2));
    p.noDecay = true;
    w.players.set(2, p);
    w.now = state.now;
    this.place(state);
    this.tick = 0;
    this.splits = 0; this.tabs = 0;
  }

  // Puts the cells of `state` in the game (all of the player's cells are replaced). Used by
  // the constructor, and by reset() when a unit is lost.
  place(state) {
    const w = this.world, p = this.player;
    for (const u of p.units) { for (const c of u.cells) w.cells.delete(c.id); u.cells.length = 0; }
    let maxId = w.nextId - 1;
    for (const s of state.cells) {
      const unit = p.units[s.unit];
      const c = w.add(Type.PLAYER, s.x, s.y, s.mass);
      w.cells.delete(c.id); c.id = s.id; w.cells.set(c.id, c); maxId = Math.max(maxId, s.id);
      c.owner = unit.playerId; c.unit = unit; c.boost = s.boost; c.angle = s.angle;
      c.born = s.born; c.mergeAt = s.mergeAt;
      unit.cells.push(c);
    }
    w.nextId = maxId + 1;
    p.playing = true;
    p.activeUnit = state.active ?? 0;
    for (const u of [0, 1]) p.units[u].aim = { ...(state.aim?.[u] ?? this.unitCentre(u)) };
    for (const u of [0, 1]) p.units[u].splitQueue = state.splitQueue?.[u] ?? 0;
    p.pointer = { ...p.active.aim };
    w.buildGrid();
  }

  // Back to a start position after a lost unit: `start` (one of data/start-positions.json,
  // in turn) is put where the mass centre is now, turned to `angle`; the clock and counters
  // keep running.
  reset(start, angle) {
    this.place(moveStart(start, { at: this.centre(), angle, now: this.world.now, idBase: this.world.nextId }));
    this.resets = (this.resets ?? 0) + 1;
  }

  // ---- inputs (the same effect as the client's packets on the server) ----
  aim(x, y) { const p = this.player; p.pointer = { x, y }; if (p.alive) p.active.aim = { x, y }; }
  split(n) {
    if (!ALLOWED_SPLITS.includes(n)) throw new Error(`split ${n} not allowed`);
    if (!this.player.alive) return;
    this.world.requestSplit(this.player.active, n); this.splits++;
  }
  tab() {
    const p = this.player; if (!p.alive) return;
    p.activeUnit ^= 1; this.tabs++;
    const other = p.units[p.activeUnit];
    if (!other.cells.length) this.world.spawnSecondUnit(p, other);
  }

  step() { this.tick++; this.world.tick(this.world.now + this.cfg.tickMs); }

  // ---- observations ----
  get active() { return this.player.activeUnit; }
  cells(u) { return this.player.units[u].cells; }
  mass() { return this.player.mass; }
  unitCentre(u) {
    let m = 0, x = 0, y = 0;
    for (const c of this.player.units[u].cells) { m += c.mass; x += c.x * c.mass; y += c.y * c.mass; }
    return m ? { x: x / m, y: y / m } : { x: 0, y: 0 };
  }
  centre() { return this.player.center(); }
  // Recording frame in the /rec format.
  frame(tickBase = 0) {
    const cells = [];
    for (const u of this.player.units) for (const c of u.cells)
      cells.push([c.id, u.playerId, +c.x.toFixed(1), +c.y.toFixed(1), +c.mass.toFixed(1), +c.boost.toFixed(1), +c.angle.toFixed(3)]);
    return { tick: tickBase + this.tick, cells };
  }

  // Plain-data state (the format the constructor takes), e.g. to hand to a worker thread.
  state() {
    const p = this.player, cells = [];
    for (let u = 0; u < 2; u++) for (const c of p.units[u].cells)
      cells.push({ id: c.id, unit: u, x: c.x, y: c.y, mass: c.mass, boost: c.boost, angle: c.angle, born: c.born, mergeAt: c.mergeAt });
    return { now: this.world.now, active: p.activeUnit, aim: p.units.map((u) => ({ ...u.aim })), splitQueue: p.units.map((u) => u.splitQueue), cells };
  }

  // Full copy of the game for look-ahead (cheap: a few dozen cells).
  clone() {
    const g = Object.create(Game.prototype);
    g.cfg = this.cfg; g.tick = this.tick; g.splits = this.splits; g.tabs = this.tabs; g.resets = this.resets;
    const w = (g.world = new World(this.world.cfg));
    w.now = this.world.now; w.nextId = this.world.nextId; w.tickCount = this.world.tickCount;
    const p = (g.player = new Player(2));
    const src = this.player;
    p.noDecay = true; p.playing = src.playing; p.activeUnit = src.activeUnit; p.pointer = { ...src.pointer };
    w.players.set(2, p);
    for (let k = 0; k < 2; k++) {
      const su = src.units[k], du = p.units[k];
      du.aim = { ...su.aim }; du.splitQueue = su.splitQueue; du.color = su.color;
      for (const c of su.cells) {
        const n = Object.create(Object.getPrototypeOf(c));
        Object.assign(n, c); n.unit = du;
        du.cells.push(n); w.cells.set(n.id, n);
      }
    }
    return g;
  }
}

// A position (the Game state format) moved so its mass centre is at `at` and turned by
// `angle` (the start position runs east, as you did at 48.2 s), with its clock moved to
// `now` (merge timers keep their time left). idBase: new cell ids from there, in order.
export function moveStart(start, { at, angle = 0, now = start.now, idBase = null }) {
  let m = 0, cx = 0, cy = 0;
  for (const c of start.cells) { m += c.mass; cx += c.x * c.mass; cy += c.y * c.mass; }
  cx /= m; cy /= m;
  const cos = Math.cos(angle), sin = Math.sin(angle), dt = now - start.now;
  const T = (q) => ({ x: at.x + (q.x - cx) * cos - (q.y - cy) * sin, y: at.y + (q.x - cx) * sin + (q.y - cy) * cos });
  return {
    now, active: start.active, splitQueue: [0, 0], aim: start.aim.map(T),
    cells: start.cells.map((c, i) => ({ ...c, ...T(c), id: idBase == null ? c.id : idBase + i, angle: c.angle + angle, born: c.born + dt, mergeAt: c.mergeAt + dt })),
  };
}
