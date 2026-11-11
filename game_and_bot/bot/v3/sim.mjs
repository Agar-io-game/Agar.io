// Fast headless copy of the game rules in server/world.mjs, for one player with two units and
// nothing else on the field (your sandbox: no pellets, viruses or other players).
// Always mass decay OFF and map walls OFF. Inputs are only what the keys allow: cursor,
// split (1), double split (2), full split (4) and Tab. No W, no E, no freeze.
//
// It is the same rules in the same order as World.tick, so it gives the same game
// (validate-sim.mjs plays both side by side and compares every cell every tick). It is much
// faster because a whole game state is one Float64Array: a copy for a look-ahead
// costs one memcpy, and a tick touches no Map, no grid and no garbage.
import config from '../../server/config.mjs';

export const CAP = config.maxCellsPerUnit;         // 16 cells per unit
const F = 12;                                      // numbers per cell
const X = 0, Y = 1, M = 2, B = 3, A = 4, C = 5, S = 6, BORN = 7, MERGE = 8, ID = 9, R = 10, V = 11; // R radius, V walking speed: kept up to date with the mass
const HDR = 2 * CAP * F;
const N0 = HDR, AX = HDR + 2, AY = HDR + 3, Q0 = HDR + 6, ACT = HDR + 8, NOW = HDR + 9, NEXT = HDR + 10,
  AUTO = HDR + 11, MERGES = HDR + 12, EATS = HDR + 13, TICK = HDR + 14, PRESSES = HDR + 15;
const SIZE = HDR + 16;
// where things are in Sim.d, for code that reads many cells at once (features.mjs)
export const LAYOUT = { F, X, Y, M, B, A, C, S, BORN, MERGE, ID, R, V, N0 };
export const FLIGHT_K = config.boostTravelFactor * config.splitBoostDecay / (1 - config.splitBoostDecay); // boost x this = distance still to fly

const TICK_MS = config.tickMs, MIN_SPLIT = config.minSplitMass, EAT_RATIO = config.eatRatio, OVERLAP = config.eatOverlap;
const SPEED_K = config.speedCoefficient, SPEED_E = config.speedExponent;
const BOOST_DECAY = config.splitBoostDecay, BOOST_STOP = config.splitBoostStop, BOOST_TRAVEL = config.boostTravelFactor;
const [BL_A, BL_B, BL_C] = config.splitBoostLn;
const MERGE_BASE = config.recombineBaseSec, MERGE_MASS = config.recombineMassFactor, NO_COLLIDE = config.splitNoCollideMs;
const PUSH = config.ownPushFraction, AUTO_SPLIT = config.autoSplitMass;
const speedOf = (r) => SPEED_K * Math.pow(r, SPEED_E);

export const radiusOf = (mass) => Math.sqrt(100 * mass);
export const walkSpeed = (mass) => SPEED_K * Math.pow(Math.sqrt(100 * mass), SPEED_E);   // units per tick
// How far a split piece flies on top of its walking (sum of the decaying boost): ~760.
export const THROW = (() => { let b = 193, s = 0; for (;;) { b *= BOOST_DECAY; if (b < BOOST_STOP) break; s += b * BOOST_TRAVEL; } return s; })();

const ord = new Int32Array(2 * CAP), cand = new Int32Array(CAP), dead = new Uint8Array(2 * CAP);

export class Sim {
  constructor() { this.d = new Float64Array(SIZE); }
  clone() { const s = new Sim(); s.d.set(this.d); return s; }
  copyFrom(o) { this.d.set(o.d); return this; }

  // ---- reading the state ----
  n(u) { return this.d[N0 + u]; }
  get active() { return this.d[ACT]; }
  get now() { return this.d[NOW]; }
  get tickCount() { return this.d[TICK]; }
  get autoSplits() { return this.d[AUTO]; }   // cells that went over 22,500 and burst (random direction): never wanted
  get merges() { return this.d[MERGES]; }     // same-unit recombines
  get eats() { return this.d[EATS]; }         // cells eaten by the other unit
  get presses() { return this.d[PRESSES]; }
  queue(u) { return this.d[Q0 + u]; }
  aimOf(u) { return { x: this.d[AX + 2 * u], y: this.d[AY + 2 * u] }; }
  cell(u, k) { const d = this.d, o = (u * CAP + k) * F; return { unit: u, x: d[o + X], y: d[o + Y], mass: d[o + M], boost: d[o + B], angle: d[o + A], born: d[o + BORN], mergeAt: d[o + MERGE], id: d[o + ID] }; }
  cells(u) { const out = []; for (let k = 0; k < this.d[N0 + u]; k++) out.push(this.cell(u, k)); return out; }
  unitMass(u) { const d = this.d; let m = 0; for (let k = 0, o = u * CAP * F; k < d[N0 + u]; k++, o += F) m += d[o + M]; return m; }
  mass() { return this.unitMass(0) + this.unitMass(1); }
  // mass centre of one unit -> out {x, y, m}
  unitCentre(u, out = {}) {
    const d = this.d; let m = 0, x = 0, y = 0;
    for (let k = 0, o = u * CAP * F; k < d[N0 + u]; k++, o += F) { const w = d[o + M]; m += w; x += d[o + X] * w; y += d[o + Y] * w; }
    out.m = m; out.x = m ? x / m : 0; out.y = m ? y / m : 0; return out;
  }
  centre(out = {}) {
    const d = this.d; let m = 0, x = 0, y = 0;
    for (let u = 0; u < 2; u++) for (let k = 0, o = u * CAP * F; k < d[N0 + u]; k++, o += F) { const w = d[o + M]; m += w; x += d[o + X] * w; y += d[o + Y] * w; }
    out.m = m; out.x = m ? x / m : 0; out.y = m ? y / m : 0; return out;
  }
  get lost() { return this.d[N0] === 0 || this.d[N0 + 1] === 0; } // a unit is gone
  canSplit(u) { // would a split press on unit u split anything?
    const d = this.d, n = d[N0 + u]; if (n >= CAP) return false;
    for (let k = 0, o = u * CAP * F; k < n; k++, o += F) if (d[o + M] >= MIN_SPLIT) return true;
    return false;
  }

  // ---- loading a position ----
  // state: { now, active, aim: [{x,y},{x,y}], splitQueue: [a,b], cells: [{id, unit, x, y, mass, boost, angle, born, mergeAt}] }
  // cells in creation order (lowest id first): the order a split goes through them.
  load(state) {
    const d = this.d; d.fill(0);
    let maxId = 0;
    const cells = [...state.cells].sort((a, b) => a.id - b.id);
    for (const c of cells) {
      const u = c.unit, k = d[N0 + u]++; if (k >= CAP) throw new Error('more than 16 cells in a unit');
      const o = (u * CAP + k) * F;
      d[o + X] = c.x; d[o + Y] = c.y; d[o + M] = c.mass; d[o + B] = c.boost || 0; d[o + A] = c.angle || 0;
      d[o + C] = Math.cos(d[o + A]); d[o + S] = Math.sin(d[o + A]);
      d[o + BORN] = c.born; d[o + MERGE] = c.mergeAt; d[o + ID] = c.id; if (c.id > maxId) maxId = c.id;
      d[o + R] = Math.sqrt(100 * c.mass); d[o + V] = speedOf(d[o + R]);
    }
    d[NOW] = state.now; d[ACT] = state.active ?? 0; d[NEXT] = Math.max(maxId + 1, state.nextId ?? 0);
    const cu = {};
    for (let u = 0; u < 2; u++) {
      const a = state.aim?.[u] ?? this.unitCentre(u, cu);
      d[AX + 2 * u] = a.x; d[AY + 2 * u] = a.y; d[Q0 + u] = state.splitQueue?.[u] ?? 0;
    }
    return this;
  }
  // Loads another position but keeps the counters (auto splits, merges, eats, ticks, presses).
  reload(state) { const keep = this.d.slice(AUTO, SIZE); this.load(state); this.d.set(keep, AUTO); return this; }
  // What a look-ahead wants to know about a position, without making objects:
  // mass that one split press on unit u would split now (cells in split order until the unit has 16)
  splittable(u) {
    const d = this.d, n = d[N0 + u]; let room = CAP - n, m = 0;
    for (let k = 0, o = u * CAP * F; k < n && room > 0; k++, o += F) if (d[o + M] >= MIN_SPLIT) { m += d[o + M]; room--; }
    return m;
  }
  edible(u, by) { const d = this.d, lim = by / EAT_RATIO; let m = 0; for (let k = 0, o = u * CAP * F; k < d[N0 + u]; k++, o += F) if (d[o + M] <= lim) m += d[o + M]; return m; } // mass of unit u a cell of mass `by` could eat
  biggest(u) { const d = this.d; let m = 0; for (let k = 0, o = u * CAP * F; k < d[N0 + u]; k++, o += F) if (d[o + M] > m) m = d[o + M]; return m; }
  // distance still to fly by pieces in the air, along (gx, gy), mass-weighted sum
  flight(gx, gy) {
    const d = this.d, K = BOOST_TRAVEL * BOOST_DECAY / (1 - BOOST_DECAY); let s = 0;
    for (let u = 0; u < 2; u++) for (let k = 0, o = u * CAP * F; k < d[N0 + u]; k++, o += F) if (d[o + B] > 0) s += d[o + M] * d[o + B] * K * (d[o + C] * gx + d[o + S] * gy);
    return s;
  }
  // the k-th biggest cell of unit u -> out {x, y, mass}; false if there is none
  top(u, rank, out) {
    const d = this.d, n = d[N0 + u]; if (rank >= n) return false;
    let lastM = Infinity, lastK = -1, best = -1;
    for (let r = 0; r <= rank; r++) {
      best = -1; let bm = -1;
      for (let k = 0, o = u * CAP * F; k < n; k++, o += F) { const m = d[o + M]; if ((m < lastM || (m === lastM && k > lastK)) && m > bm) { bm = m; best = k; } }
      if (best < 0) return false; lastM = bm; lastK = best;
    }
    const o = (u * CAP + best) * F; out.x = d[o + X]; out.y = d[o + Y]; out.mass = d[o + M]; return true;
  }
  state() {
    return { now: this.now, active: this.active, nextId: this.d[NEXT], aim: [this.aimOf(0), this.aimOf(1)], splitQueue: [this.queue(0), this.queue(1)], cells: [...this.cells(0), ...this.cells(1)].sort((a, b) => a.id - b.id) };
  }
  // Recording frame in the /rec format (recordings/viewer.html plays it). Unit ids 2 and 3.
  frame(tick) {
    const cells = [];
    for (let u = 0; u < 2; u++) for (const c of this.cells(u)) cells.push([c.id, 2 + u, +c.x.toFixed(1), +c.y.toFixed(1), +c.mass.toFixed(1), +c.boost.toFixed(1), +c.angle.toFixed(3)]);
    return { tick, cells };
  }

  // ---- the keys ----
  aim(x, y) { const d = this.d, u = d[ACT]; d[AX + 2 * u] = x; d[AY + 2 * u] = y; }
  tab() { const d = this.d; if (d[N0 + (d[ACT] ^ 1)] > 0) d[ACT] ^= 1; }   // (with the other unit gone Tab would spawn a new one: a lost unit resets the game instead)
  split(n) { // n = 1, 2 or 4: that many passes, one per tick
    if (n !== 1 && n !== 2 && n !== 4) throw new Error(`split ${n} is not a key`);
    const d = this.d; d[Q0 + d[ACT]] += n; d[PRESSES]++;
  }

  // ---- one game tick (World.tick) ----
  tick() {
    const d = this.d;
    const now = (d[NOW] += TICK_MS); d[TICK]++;
    // 1. every cell walks to its unit's cursor, and flies on if it was just split off
    for (let u = 0; u < 2; u++) {
      const ax = d[AX + 2 * u], ay = d[AY + 2 * u], n = d[N0 + u];
      for (let k = 0, o = u * CAP * F; k < n; k++, o += F) {
        const dx = ax - d[o + X], dy = ay - d[o + Y], dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 1) {
          const step = Math.min(dist, d[o + V]);
          d[o + X] += (dx / dist) * step; d[o + Y] += (dy / dist) * step;
        }
        if (d[o + B] > 0) {
          d[o + B] *= BOOST_DECAY;
          if (d[o + B] < BOOST_STOP) d[o + B] = 0;
          else { d[o + X] += d[o + C] * d[o + B] * BOOST_TRAVEL; d[o + Y] += d[o + S] * d[o + B] * BOOST_TRAVEL; }
        }
      }
    }
    // 2. one pass of each unit's queued split
    for (let u = 0; u < 2; u++) if (d[Q0 + u] > 0) { d[Q0 + u]--; this.splitPass(u, now); }
    // 3. cells of one unit push apart (or recombine once both merge timers are over)
    for (let u = 0; u < 2; u++) this.resolveOwn(u, now);
    // 4. the two units eat each other's cells
    this.resolveEating();
    // 5. auto split over 22,500
    if (AUTO_SPLIT > 0) for (let u = 0; u < 2; u++) this.autoSplit(u, now);
  }

  splitPass(u, now) {
    const d = this.d, base = u * CAP * F, len = d[N0 + u];
    const ax = d[AX + 2 * u], ay = d[AY + 2 * u];
    for (let i = 0; i < len; i++) {
      const n = d[N0 + u]; if (n >= CAP) return;
      const o = base + i * F;
      if (d[o + M] < MIN_SPLIT) continue;
      const half = d[o + M] / 2;
      const angle = Math.atan2(ay - d[o + Y], ax - d[o + X]);
      this.halve(u, o, half, angle, now);
    }
  }
  halve(u, o, half, angle, now) {
    const d = this.d, n = d[N0 + u], p = (u * CAP + n) * F;
    const mergeAt = now + (MERGE_BASE + MERGE_MASS * half) * 1000;
    const r = Math.sqrt(100 * half), v = speedOf(r);
    d[o + M] = half; d[o + BORN] = now; d[o + MERGE] = mergeAt; d[o + R] = r; d[o + V] = v;
    const L = Math.log(r);
    d[p + X] = d[o + X]; d[p + Y] = d[o + Y]; d[p + M] = half; d[p + B] = BL_A + BL_B * L + BL_C * L * L;
    d[p + A] = angle; d[p + C] = Math.cos(angle); d[p + S] = Math.sin(angle);
    d[p + BORN] = now; d[p + MERGE] = mergeAt; d[p + ID] = d[NEXT]++; d[p + R] = r; d[p + V] = v;
    d[N0 + u] = n + 1;
  }
  removeAt(u, k) { // takes cell k out of unit u, keeping the order of the rest
    const d = this.d, n = d[N0 + u], base = u * CAP * F;
    d.copyWithin(base + k * F, base + (k + 1) * F, base + n * F);
    d[N0 + u] = n - 1;
  }

  resolveOwn(u, now) {
    const d = this.d, base = u * CAP * F;
    for (let i = 0; i < d[N0 + u]; i++) for (let j = i + 1; j < d[N0 + u]; j++) {
      const a = base + i * F, b = base + j * F;
      const dx = d[b + X] - d[a + X], dy = d[b + Y] - d[a + Y], ra = d[a + R], rb = d[b + R], d2 = dx * dx + dy * dy;
      if (d2 >= (ra + rb) * (ra + rb)) continue;   // not touching: nothing to push, nothing to merge
      const dist = Math.sqrt(d2) || 0.001;
      if (now >= d[a + MERGE] && now >= d[b + MERGE]) {
        const aBig = d[a + M] >= d[b + M];
        if (dist <= (aBig ? ra - rb * OVERLAP : rb - ra * OVERLAP)) {
          d[MERGES]++;
          if (aBig) { this.grow(a, d[b + M]); this.removeAt(u, j); j--; }
          else { this.grow(b, d[a + M]); this.removeAt(u, i); i--; break; }
        }
      } else if (now - d[a + BORN] >= NO_COLLIDE && now - d[b + BORN] >= NO_COLLIDE) {
        const overlap = ra + rb - dist;
        if (overlap > 0) {
          const total = d[a + M] + d[b + M], nx = dx / dist, ny = dy / dist, push = overlap * PUSH;
          const ma = d[a + M], mb = d[b + M];
          d[a + X] -= nx * push * (mb / total); d[a + Y] -= ny * push * (mb / total);
          d[b + X] += nx * push * (ma / total); d[b + Y] += ny * push * (ma / total);
        }
      }
    }
  }

  grow(o, mass) { const d = this.d; d[o + M] += mass; d[o + R] = Math.sqrt(100 * d[o + M]); d[o + V] = speedOf(d[o + R]); }

  resolveEating() {
    const d = this.d, n0 = d[N0], n1 = d[N0 + 1];
    if (!n0 || !n1) return;
    // eaters in order of mass, biggest first (stable: unit 0's cells, then unit 1's)
    let ne = 0;
    for (let k = 0; k < n0; k++) ord[ne++] = k;
    for (let k = 0; k < n1; k++) ord[ne++] = CAP + k;
    for (let i = 1; i < ne; i++) { const v = ord[i], mv = d[v * F + M]; let j = i - 1; while (j >= 0 && d[ord[j] * F + M] < mv) { ord[j + 1] = ord[j]; j--; } ord[j + 1] = v; }
    let any = false;
    for (let e = 0; e < ne; e++) {
      const ai = ord[e]; if (any && dead[ai]) continue;
      const a = ai * F, u = ai < CAP ? 0 : 1, v = u ^ 1, nv = v ? n1 : n0;
      const ra = d[a + R], ax = d[a + X], ay = d[a + Y];
      let nc = 0;
      for (let k = 0, bi = v * CAP, b = bi * F; k < nv; k++, bi++, b += F) {
        if (any && dead[bi]) continue;
        const dx = d[b + X] - ax, dy = d[b + Y] - ay;
        if (dx > ra || dx < -ra || dy > ra || dy < -ra) continue;
        const reach = ra - d[b + R] * OVERLAP;
        if (reach >= 0 && dx * dx + dy * dy <= reach * reach) cand[nc++] = bi;
      }
      if (!nc) continue;
      // the server finds them through its 512-unit grid: by column, then row, then age
      if (nc > 1) for (let i = 1; i < nc; i++) { const w = cand[i]; let j = i - 1; while (j >= 0 && this.after(cand[j], w)) { cand[j + 1] = cand[j]; j--; } cand[j + 1] = w; }
      for (let i = 0; i < nc; i++) {
        const b = cand[i] * F;
        if (d[a + M] >= d[b + M] * EAT_RATIO) { this.grow(a, d[b + M]); if (!any) { dead.fill(0); any = true; } dead[cand[i]] = 1; d[EATS]++; }
      }
    }
    if (!any) return;
    for (let u = 0; u < 2; u++) {
      const n = u ? n1 : n0, base = u * CAP * F; let w = 0;
      for (let k = 0; k < n; k++) { if (dead[u * CAP + k]) continue; if (w !== k) d.copyWithin(base + w * F, base + k * F, base + (k + 1) * F); w++; }
      d[N0 + u] = w;
    }
    // the unit you control died: control goes to the other one
    if (d[N0 + d[ACT]] === 0 && d[N0 + (d[ACT] ^ 1)] > 0) d[ACT] ^= 1;
  }
  after(p, q) { // is cell p found after cell q in the server's grid walk?
    const d = this.d, a = p * F, b = q * F;
    const gxa = Math.floor(d[a + X] / 512), gxb = Math.floor(d[b + X] / 512); if (gxa !== gxb) return gxa > gxb;
    const gya = Math.floor(d[a + Y] / 512), gyb = Math.floor(d[b + Y] / 512); if (gya !== gyb) return gya > gyb;
    return d[a + ID] > d[b + ID];
  }

  autoSplit(u, now) {
    const d = this.d, base = u * CAP * F, len = d[N0 + u];
    for (let i = 0; i < len; i++) {
      const o = base + i * F;
      if (d[o + M] <= AUTO_SPLIT) continue;
      d[AUTO]++;
      if (d[N0 + u] >= CAP) { this.grow(o, AUTO_SPLIT - d[o + M]); continue; }
      this.halve(u, o, d[o + M] / 2, Math.random() * Math.PI * 2, now);
    }
  }
}
