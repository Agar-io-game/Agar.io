// The split-run bot. Every few ticks it looks ahead: for each candidate move (where to put
// the cursor, and whether to press split / double split / full split / Tab) it plays the
// next couple of seconds forward in an exact copy of the game, then scores where that leaves
// it. It plays the best one. Training (train.mjs) tunes the numbers in DEFAULT_PARAMS.
//
// Hard rules, enforced here and in sim.mjs: no feeding (W / E), splits only through the split
// (1), double split (2) and full split (4) keys, plus Tab and the cursor.
// Human-like hands: at most one key press every `keyGap` ticks (40 ms each), as fast as yours.

export const DEFAULT_PARAMS = {
  keyGap: 4,            // min ticks between key presses: 4 = 160 ms, your own fastest typical gap (p10 in the recordings)
  decideEvery: 3,       // ticks between decisions (120 ms)
  horizon: 50,          // look-ahead ticks
  planner: 'moves',     // 'moves': one move then look ahead; 'shoot': random plans in your rhythm;
                        // 'imitate': futures played by the policy learned from your games
  samples: 24,          // 'imitate': futures tried per decision
  temp: 1,              // 'imitate': sampling temperature of your learned key habits
  keyBias: 0,           // 'imitate': + makes keys likelier, - rarer
  aimNoise: 0.15,       // 'imitate': cursor variation between futures
  aimSwitch: 0.05,      // 'imitate': chance per tick of a new cursor choice without a key press
  plans: 48,            // 'shoot': random plans tried per decision
  maxGap: 14,           // 'shoot': longest wait between key presses in a plan (ticks)
  pKeyNow: 0.5,         // 'shoot': chance a plan presses a key as soon as it may
  pSplit: 0.55,         // 'shoot': a key press is a split (else Tab)
  pFull: 0.1,           // 'shoot': a split is a full split (else single)
  pCell: 0.3,           // 'shoot': cursor on one of their 3 biggest cells (you: 31% of splits)
  pFeed: 0.1,           // 'shoot': cursor steering my piece into their eater
  angSd: 30,            // 'shoot': spread of the cursor angle around the heading (degrees)
  rollout: 'noop',      // after the candidate move: 'noop' (no more keys) or 'base' (keep split-running)
  basePeriod: 10,       // 'base': ticks between its key presses (split, Tab, split, ...)
  aimHold: 10,          // 'base': ticks the candidate's cursor is kept before looking straight ahead
  wKey: 2,              // cost per key press (no pointless Tabs)
  far: 20000,           // cursor distance for a "straight" aim
  near: 1200,           // cursor distance for a "converging" aim
  angles: [0, 30, -30, 90, -90, 180],
  mid: 2500,            // cursor distance you typically split with
  midAngles: [0, 15, -15, 30, -30],
  wCrowd: 0,            // x (cells over crowdFree)^2 per unit
  crowdFree: 10,
  splitMax: 16,         // 'shoot': a planned split on a unit with more cells than this becomes a Tab
  wSelf: 0,             // x the self-play value network's 10 s progress forecast (value-selfplay.mjs)
  avgAim: 0,            // 'imitate': share of futures using the average of your cursor choices
  choiceAt: 'always',   // 'imitate': 'always' = one of your cursor choices at all times; 'split' = only while splitting
  wFull: 0,             // 'imitate': cost per full split in a future
  wStuck: 0,            // 'imitate': per tick a unit stays at 16 cells beyond stuckFree ticks in a future
  stuckFree: 12,
  wSplit: 0,            // 'imitate': per split in a future that splits at least one cell (a faster rhythm)
  wLook: 0,             // 'imitate': x log-odds that the shape at the end of a future is yours (look.mjs)
  wPress: 0,            // 'imitate': x log-odds, for every split in a future, that you would make that split there (press.mjs)
  splitRate: 0,         // 'imitate': at most this many splits a second on average (0 = no limit)...
  splitBurst: 3,        // ...and this many at once (you: at most 3 in any second, 99% of the time)
  lightShare: 0,        // 'imitate': the lighter unit under this share never splits when no half could eat a cell of the other unit
  lightCrumb: 0,        // ...cells of the other unit under this share of the half's mass not counted (a crumb is no reason to split)
  wTrap: 0,             // 'imitate': cost of a future that ends with the lighter unit under trapShare and unable to eat any cell of the other
  trapShare: 0.3,
  dangerShare: 0,       // 'imitate': when the lighter unit holds under this share, half the futures press keys more readily...
  dangerBias: 1.5,      // ...by this much (your habits almost never meet a drain, so their futures hold no way out)
  wDrain: 0,            // 'imitate': per % of the total mass the lighter unit loses in a future while it holds under drainShare
  drainShare: 0.3,
  escShare: 0,          // 'imitate': with the lighter unit under this share, hand-made escape futures are played too (Brain.escapes)...
  escIdle: 20,          // ...once no key of a normal future has been pressed for this many ticks (a stall),
  escHard: 0,           // ...or at once with the lighter unit under this share
  escHorizon: 150,      // ...over this many ticks (walking out of a drain takes seconds)
  escMargin: 100,       // ...and one is played if it is worth this much more than the best normal future played on as long,
  escKey: 0,            // ...after a cost per key pressed in it
  escReach: 0,          // ...plus escReach x the food within reach of the lighter unit at its end (Brain.reach)
  escLead: 600,         // the hunter with nothing to eat walks forward until its biggest cell leads the heavy unit's centre by this
  wHuman: 1,            // x seconds of the speed your own games show from such a position
  // value of the state at the end of the look-ahead, in units of forward distance:
  wSlot: 25,            // per free cell slot (room to split again)
  wSpeed: 20,           // x ticks of the current mass-weighted forward speed (momentum after the horizon)
  wLat: 0.15,           // per unit of sideways drift of the mass centre from the course line
  wSep: 0.05,           // per unit the two units are further apart than sepFree
  sepFree: 1500,
  wEdible: 200,         // x share of the mass the other unit's biggest cell could eat
  wBoost: 0.5,          // remaining flight of boosted cells (x mass share)
  wBal: 300,            // x share of the mass in the lighter unit (0 .. 0.5)
  minShare: 0.12,       // below this share the lighter unit is starving...
  wStarve: 30,          // ...and each % under it costs this much
  floorShare: 0,        // your floor: the lighter unit keeps at least this share (you: 12.6% 99% of the time)...
  wFloor: 0,            // ...going under it costs up to this much (a drained unit is a unit about to be lost)
};

const DEG = Math.PI / 180;

// Your learned speed model (learn-value.mjs): predicted u/s from a position, fitted on your
// recordings. Optional: without data/value-model.json the term is simply left out.
import { readFileSync, existsSync } from 'node:fs';
import { features } from './features.mjs';
const MODEL_FILE = new URL('./data/value-model.json', import.meta.url);
const HUMAN_MODEL = existsSync(MODEL_FILE) ? JSON.parse(readFileSync(MODEL_FILE, 'utf8')) : null;

// Your imitation policy (imitate.mjs / policy.mjs), for planner 'imitate'.
import { MLP, ImitationPlayer, INPUTS } from './policy.mjs';
import { valueNet, predictValue } from './value-net.mjs';
import { lookNet, lookLogit, LOOK_INPUTS } from './look.mjs';
import { pressNet, pressLogit, PRESS_INPUTS } from './press.mjs';

// The lighter unit holds under `share` of the mass and none of its cells can eat any cell of
// the other unit.
export function trapped(g, share) {
  const a = g.cells(0), b = g.cells(1);
  if (!a.length || !b.length) return true;
  let ma = 0, mb = 0, bigA = 0, bigB = 0, minA = Infinity, minB = Infinity;
  for (const c of a) { ma += c.mass; if (c.mass > bigA) bigA = c.mass; if (c.mass < minA) minA = c.mass; }
  for (const c of b) { mb += c.mass; if (c.mass > bigB) bigB = c.mass; if (c.mass < minB) minB = c.mass; }
  return ma < mb ? ma / (ma + mb) < share && bigA <= 1.3 * minB : mb / (ma + mb) < share && bigB <= 1.3 * minA;
}
const POLICY_FILE = new URL('./data/policy.json', import.meta.url);
const NETS = new Map();
// file: another policy (params.policy), e.g. to compare with an older one
export function policyNet(file = POLICY_FILE) {
  const key = String(file);
  if (!NETS.has(key) && existsSync(file)) { const w = JSON.parse(readFileSync(file, 'utf8')); NETS.set(key, new MLP(w.sizes, w)); }
  return NETS.get(key) ?? null;
}

// The learned player's options from the bot's weights (also used by the live planner's workers).
export const playerOptions = (p, goalAngle) => ({
  goalAngle, keyGap: p.keyGap, temperature: p.temp, keyBias: p.keyBias, aimSwitch: p.aimSwitch, keyNet: p.keyPolicy ? policyNet(p.keyPolicy) : null,
  choiceAt: p.choiceAt, splitRate: p.splitRate, splitBurst: p.splitBurst, lightShare: p.lightShare, lightCrumb: p.lightCrumb,
});

// The future to play, from the results of Brain.futures (one per worker thread in live mode):
// the best one, or the best escape when that is worth more (see there).
export function pickFuture(results, p) {
  let best = null, q = null, gain = -Infinity;
  for (const r of results) if (r.acts && (!best || r.value > best.value)) best = r;
  // an escape's gain was measured against the best future of its own call: less what the best of all has over that one
  for (const r of results) if (r.esc && r.esc.gain - (best.value - r.value) > gain) { q = r.esc; gain = r.esc.gain - (best.value - r.value); }
  if (q && gain > (p.escMargin ?? DEFAULT_PARAMS.escMargin)) return { acts: q.acts, value: best.value, escape: q.name };
  return best;
}

export class Brain {
  constructor(params = {}, goalAngle = 0) {
    this.p = { ...DEFAULT_PARAMS, ...params };
    this.goal = { x: Math.cos(goalAngle), y: Math.sin(goalAngle) };
    this.lastKey = -1e9;
    this.queued = null; // { at, n } a split planned right after a Tab
    this.line = null;   // course line: through the start centre along the goal
  }

  // ---- value of a position ------------------------------------------------------------
  score(g, origin) {
    const p = this.p, G = this.goal, pl = g.player;
    const c = g.centre();
    if (!c) return -1e9;
    const along = (c.x - origin.x) * G.x + (c.y - origin.y) * G.y;
    const lat = Math.abs((c.x - this.line.x) * -G.y + (c.y - this.line.y) * G.x);
    let v = along - p.wLat * lat;
    const [U0, U1] = pl.units;
    if (!U0.cells.length || !U1.cells.length) v -= 1e6; // lost a unit
    const lost = this.mass0 - g.mass();
    if (Math.abs(lost) > 1) v -= 50 * Math.abs(lost);
    let M = 0, spd = 0, boost = 0;
    const um = [0, 0], big = [0, 0];
    for (let i = 0; i < 2; i++) {
      for (const k of pl.units[i].cells) {
        M += k.mass; um[i] += k.mass; if (k.mass > big[i]) big[i] = k.mass;
        // forward speed this cell would have heading along the goal
        spd += k.mass * 82.5 * Math.pow(k.r, -0.432);
        if (k.boost > 0) boost += k.mass * k.boost * 0.5 * 0.8866 / (1 - 0.8866) * Math.max(0, Math.cos(k.angle) * G.x + Math.sin(k.angle) * G.y);
      }
    }
    // Free cell slots are worth something only in proportion to the mass that can use them.
    let slots = 0;
    for (let i = 0; i < 2; i++) slots += (16 - pl.units[i].cells.length) * Math.min(1, (2 * um[i]) / M);
    // Mass of each unit that the other unit's biggest cell could eat (consolidation potential:
    // cells of one unit never merge for 30 s+, they can only be eaten by the other unit).
    let edible = 0;
    for (let i = 0; i < 2; i++) for (const k of pl.units[i].cells) if (big[i ^ 1] >= 1.3 * k.mass) edible += k.mass;
    const balance = Math.min(um[0], um[1]) / M; // 0 .. 0.5
    v += p.wSlot * slots + p.wSpeed * spd / M + p.wBoost * boost / M
      + p.wEdible * edible / M + p.wBal * balance;
    if (balance < p.minShare) v -= p.wStarve * (p.minShare - balance) * 100;
    if (balance < p.floorShare) v -= p.wFloor * (p.floorShare - balance) / p.floorShare;
    // A unit near 16 cells cannot split: you keep the unit you split at ~6 cells and a unit
    // sits at 16 only 7% of the time. Convex cost per cell over crowdFree.
    for (let i = 0; i < 2; i++) { const over = pl.units[i].cells.length - p.crowdFree; if (over > 0) v -= p.wCrowd * over * over; }
    const a = g.unitCentre(0), b = g.unitCentre(1);
    const sep = Math.hypot(a.x - b.x, a.y - b.y);
    if (sep > p.sepFree) v -= p.wSep * (sep - p.sepFree);
    if (p.wHuman && HUMAN_MODEL) {
      const cells = [];
      for (let i = 0; i < 2; i++) for (const k of pl.units[i].cells) cells.push({ unit: i, x: k.x, y: k.y, mass: k.mass, boost: k.boost, angle: k.angle });
      const f = features(cells, G);
      let pred = 0; for (let i = 0; i < f.length; i++) pred += f[i] * HUMAN_MODEL.w[i];
      v += p.wHuman * pred;
    }
    if (p.wSelf) { const net = valueNet(); if (net) v += p.wSelf * predictValue(net, g, G, (this.vbuf ??= new Float32Array(INPUTS))); }
    return v;
  }

  // ---- candidate moves ----------------------------------------------------------------
  aims(g, unitIndex) {
    const p = this.p, G = this.goal, base = Math.atan2(G.y, G.x);
    const c = g.unitCentre(unitIndex), o = g.unitCentre(unitIndex ^ 1);
    const out = [];
    for (const a of p.angles) { const t = base + a * DEG; out.push({ x: c.x + Math.cos(t) * p.far, y: c.y + Math.sin(t) * p.far }); }
    for (const a of p.midAngles) { const t = base + a * DEG; out.push({ x: c.x + Math.cos(t) * p.mid, y: c.y + Math.sin(t) * p.mid }); }
    out.push({ x: c.x + G.x * p.near, y: c.y + G.y * p.near });
    // the other unit: its centre, and its biggest cell (feed it / be fed by it)
    const mine = g.cells(unitIndex), theirs = g.cells(unitIndex ^ 1);
    if (theirs.length) {
      out.push({ x: o.x + G.x * 200, y: o.y + G.y * 200 });
      // inside their three biggest cells (where your cursor is in a third of your splits)
      const top = [...theirs].sort((a, b) => b.mass - a.mass).slice(0, 3);
      for (const k of top) out.push({ x: k.x + G.x * 0.5 * k.r, y: k.y + G.y * 0.5 * k.r });
      // hunt: the nearest of their cells one of mine can eat, and the nearest of my cells
      // one of theirs can eat (steer my piece into their eater)
      let hunt = null, hd = Infinity, feed = null, fd = Infinity;
      for (const a of mine) for (const b of theirs) {
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (a.mass >= 1.3 * b.mass && d < hd) { hd = d; hunt = { a, b }; }
        if (b.mass >= 1.3 * a.mass && d < fd) { fd = d; feed = { a, b }; }
      }
      // the cursor pulls every cell of the unit toward it, so put it beyond the target by
      // the offset between the chosen cell and the unit centre
      if (hunt) out.push({ x: hunt.b.x + (c.x - hunt.a.x) + G.x * 300, y: hunt.b.y + (c.y - hunt.a.y) + G.y * 300 });
      if (feed) out.push({ x: feed.b.x + (c.x - feed.a.x), y: feed.b.y + (c.y - feed.a.y) });
    }
    return out;
  }

  candidates(g, tick) {
    const keyOk = tick - this.lastKey >= this.p.keyGap;
    const act = g.active, out = [];
    for (const aim of this.aims(g, act)) {
      out.push({ aim, keys: [] });
      if (keyOk) for (const n of [1, 2, 4]) out.push({ aim, keys: [{ dt: 0, k: n }] });
    }
    if (keyOk) for (const aim of this.aims(g, act ^ 1)) {
      out.push({ tab: true, aim, keys: [{ dt: 0, k: 'tab' }] });
      for (const n of [1, 2, 4]) out.push({ tab: true, aim, keys: [{ dt: 0, k: 'tab' }, { dt: this.p.keyGap, k: n }] });
    }
    return out;
  }

  // Plays the candidate, then (rollout 'base') keeps split-running with a simple routine for
  // the rest of the look-ahead: cursor straight ahead, split (1) the controlled unit when it
  // has room, Tab, repeat every basePeriod ticks. So a move is judged by where it leads
  // when play goes on, not by where it leaves you if you stop.
  rollout(g, cand) {
    const p = this.p, G = this.goal, s = g.clone(), origin = g.centre();
    let last = cand.keys.length ? Math.max(...cand.keys.map((k) => k.dt)) : -p.keyGap;
    let splitNext = !cand.keys.some((k) => typeof k.k === 'number');
    const base = p.rollout === 'base';
    for (let t = 0; t < p.horizon; t++) {
      for (const key of cand.keys) if (key.dt === t) {
        if (key.k === 'tab') { s.tab(); s.aim(cand.aim.x, cand.aim.y); } else s.split(key.k);
      }
      if (t === 0 && !cand.tab) s.aim(cand.aim.x, cand.aim.y);
      if (base) {
        const ahead = () => { const c = s.unitCentre(s.active); s.aim(c.x + G.x * p.far, c.y + G.y * p.far); };
        if (t >= p.aimHold) ahead();
        if (t - last >= Math.max(p.keyGap, p.basePeriod)) {
          const u = s.player.active;
          const canSplit = u.cells.length < 16 && u.cells.some((k) => k.mass >= 44);
          if (splitNext && canSplit) { s.split(1); splitNext = false; }
          else { s.tab(); ahead(); splitNext = true; }
          last = t;
        }
      }
      s.step();
    }
    return this.score(s, origin) - p.wKey * cand.keys.length;
  }

  // ---- planner 'shoot': whole plans ---------------------------------------------------
  // A plan is a cursor "spec" plus timed key presses, each optionally moving the cursor:
  //   { kind: 'off', ang, dist }  held at an offset from the controlled unit's centre, like
  //                               a mouse resting on a screen that follows your cells
  //   { kind: 'cell', rank }      on the other unit's rank-th biggest cell
  //   { kind: 'feed' }            steering my nearest edible piece into their eater
  // Each decision tries `plans` random plans in your rhythm plus the best plan from the last
  // decision (shifted), plays each over the horizon, and starts the best.
  resolve(s, spec) {
    const G = this.goal, u = s.active, c = s.unitCentre(u);
    if (spec.kind === 'off') {
      const t = Math.atan2(G.y, G.x) + spec.ang;
      return { x: c.x + Math.cos(t) * spec.dist, y: c.y + Math.sin(t) * spec.dist };
    }
    const theirs = s.cells(u ^ 1);
    if (!theirs.length) return { x: c.x + G.x * 2500, y: c.y + G.y * 2500 };
    if (spec.kind === 'cell') {
      const top = [...theirs].sort((a, b) => b.mass - a.mass), k = top[Math.min(spec.rank, top.length - 1)];
      return { x: k.x + G.x * 0.5 * k.r, y: k.y + G.y * 0.5 * k.r };
    }
    let feed = null, fd = Infinity;
    for (const a of s.cells(u)) for (const b of theirs) {
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (b.mass >= 1.3 * a.mass && d < fd) { fd = d; feed = { a, b }; }
    }
    return feed ? { x: feed.b.x + (c.x - feed.a.x), y: feed.b.y + (c.y - feed.a.y) } : { x: c.x + G.x * 2500, y: c.y + G.y * 2500 };
  }
  randomSpec() {
    const p = this.p, r = Math.random();
    if (r < p.pCell) return { kind: 'cell', rank: Math.floor(Math.random() * 3) };
    if (r < p.pCell + p.pFeed) return { kind: 'feed' };
    const dists = [800, 1500, 2500, 2500, 4000, 20000];
    const g = Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());
    return { kind: 'off', ang: g * p.angSd * DEG, dist: dists[Math.floor(Math.random() * dists.length)] };
  }
  randomPlan(firstKeyAt) {
    const p = this.p, events = [];
    let t = Math.random() < p.pKeyNow ? firstKeyAt : firstKeyAt + Math.floor(Math.random() * p.maxGap);
    while (t < p.horizon) {
      const r = Math.random();
      const key = r < p.pSplit ? (Math.random() < p.pFull ? 4 : 1) : 'tab';
      events.push({ t, key, spec: key === 'tab' || Math.random() < 0.5 ? this.randomSpec() : null });
      t += p.keyGap + Math.floor(Math.random() * (p.maxGap - p.keyGap + 1));
    }
    return { spec: Math.random() < 0.5 && this.spec ? this.spec : this.randomSpec(), events };
  }
  press(s, e) {
    const tooMany = s.cells(s.active).length > this.p.splitMax;
    if (e.key === 'tab' || tooMany) s.tab();
    else { if (e.spec) { const a = this.resolve(s, e.spec); s.aim(a.x, a.y); } s.split(e.key); }
  }
  playPlan(g, plan) {
    const s = g.clone(), origin = g.centre();
    let spec = plan.spec, ei = 0, keys = 0;
    for (let t = 0; t < this.p.horizon; t++) {
      while (ei < plan.events.length && plan.events[ei].t === t) {
        const e = plan.events[ei++];
        this.press(s, e);
        if (e.spec) spec = e.spec;
        keys++;
      }
      const a = this.resolve(s, spec); s.aim(a.x, a.y);
      s.step();
    }
    return this.score(s, origin) - this.p.wKey * keys;
  }
  actShoot(g, tick) {
    const p = this.p;
    // the running plan's events that are due now
    if (this.plan) {
      const el = tick - this.planStart;
      for (const e of this.plan.events) if (e.t === el && el > 0 && tick - this.lastKey >= p.keyGap) {
        this.press(g, e);
        if (e.spec) this.spec = e.spec;
        this.lastKey = tick;
      }
    }
    if (!this.plan || tick - (this.lastDecide ?? -1e9) >= p.decideEvery) {
      this.lastDecide = tick;
      const cands = [];
      const fk = Math.max(0, p.keyGap - (tick - this.lastKey));
      if (this.plan) { // keep going with the current plan, shifted to now
        const el = tick - this.planStart;
        cands.push({ spec: this.spec, events: this.plan.events.filter((e) => e.t > el).map((e) => ({ ...e, t: Math.max(fk, e.t - el) })) });
      }
      if (this.spec) cands.push({ spec: this.spec, events: [] }); // no keys
      for (let i = 0; i < p.plans; i++) cands.push(this.randomPlan(fk));
      let best = null, bestV = -Infinity;
      for (const c of cands) { const v = this.playPlan(g, c); if (v > bestV) { bestV = v; best = c; } }
      this.plan = best; this.planStart = tick; this.spec = best.spec;
      // events due right now
      for (const e of best.events) if (e.t === 0 && tick - this.lastKey >= p.keyGap) {
        this.press(g, e);
        if (e.spec) this.spec = e.spec;
        this.lastKey = tick;
      }
    }
    const a = this.resolve(g, this.spec); g.aim(a.x, a.y);
  }

  // ---- planner 'imitate': the policy learned from your games, improved by look-ahead -----
  // Each decision it plays `samples` futures over the horizon, each with the learned policy
  // as the player (sampling your key habits; the first without cursor noise, the second
  // without any key presses as a safe fallback), scores
  // where each ends up, and plays the first ticks of the best one.
  actImitate(g, tick) {
    const p = this.p;
    if (!this.player) {
      const net = policyNet(p.policy); if (!net) throw new Error('no bot/data/policy.json: run node bot/imitate.mjs first');
      this.player = new ImitationPlayer(net, playerOptions(p, Math.atan2(this.goal.y, this.goal.x)));
    }
    if (this.queue?.length && tick - this.lastDecide < p.decideEvery) { this.player.apply(g, this.queue.shift()); return; }
    this.lastDecide = tick;
    const f = pickFuture([this.futures(g, this.player, 0, p.samples)], p);
    this.decisions = (this.decisions ?? 0) + 1; if (f.escape) this.escaped = (this.escaped ?? 0) + 1; // how often an escape was played
    this.queue = f.acts;
    this.player.apply(g, this.queue.shift());
  }

  // Futures from..from+count-1 of one decision (live mode spreads them over worker threads):
  // returns the first decideEvery actions of the best one and its score, and the best of the
  // escapes played in this call, if any. pickFuture() above chooses between them.
  futures(g, player, from, count) {
    const p = this.p;
    let best = null, bestV = -Infinity;
    let danger = false;
    if (p.dangerShare) { let a = 0, b = 0; for (const c of g.cells(0)) a += c.mass; for (const c of g.cells(1)) b += c.mass; danger = Math.min(a, b) / (a + b) < p.dangerShare; }
    for (let i = from; i < from + count; i++) {
      const r = this.future(g, player, {
        noNoise: i === 0, noKeys: i === 1, // the first: your likeliest cursor choice; the second, the safe fallback: your cursor, no keys
        keyBias: danger && i > 1 && i % 2 === 0 ? p.keyBias + p.dangerBias : null,
        // a share of the futures uses the average of your cursor choices instead of one choice
        avgAim: i === 1 ? p.avgAim > 0 : i > 1 && Math.random() < p.avgAim,
      });
      this.trace?.({ i, v: r.v, keys: r.log, game: r.game });
      if (r.v > bestV) { bestV = r.v; best = r; }
    }
    // Escapes: with the lighter unit under escShare, once no key of a normal future has been
    // pressed for escIdle ticks (a stall), or at once under escHard. They are played over
    // escHorizon (walking out of a drain takes seconds). To compare, the best future here is
    // played on to escHorizon too, with the hunter (how every escape ends) after its own
    // ticks; `gain` is what the best escape has over that. Each call plays its share of the
    // escapes (every n-th, for n calls of this size in a decision), so live mode's workers
    // split them.
    let esc = null;
    if (best) {
      let m0 = 0, m1 = 0; for (const c of g.cells(0)) m0 += c.mass; for (const c of g.cells(1)) m1 += c.mass;
      const share = Math.min(m0, m1) / (m0 + m1 || 1), n = Math.max(1, Math.round(p.samples / count)), k = Math.floor(from / count);
      const every = share < p.escHard || player.idle >= p.escIdle ? this.escapes(g) : [], list = every.filter((e, j) => j % n === k % n);
      if (list.length) {
        const base = this.future(g, player, { prefix: best.all, script: every[0].make(), horizon: p.escHorizon, reach: true }).v;
        for (const e of list) {
          const r = this.future(g, player, { script: e.make(), horizon: p.escHorizon, reach: true });
          const gain = r.v - base - p.escKey * r.keys;
          this.trace?.({ i: -1, v: gain, keys: r.log, game: r.game, tag: e.name });
          if (!esc || gain > esc.gain) esc = { acts: r.acts, gain, name: e.name };
        }
      }
    }
    return { acts: best?.acts ?? null, value: bestV, esc };
  }

  // One future: the game copied and played for `horizon` ticks by the learned player (or by
  // `script`, an escape; `prefix`: these decisions first, one per tick), then scored.
  future(g, player, { script = null, horizon = this.p.horizon, noNoise = false, noKeys = false, keyBias = null, avgAim = false, reach = false, prefix = null } = {}) {
    const p = this.p, origin = g.centre();
    const s = g.clone(), pl = player.clone(), acts = [], all = [];
    pl.aimNoise = noNoise ? 0 : p.aimNoise;
    if (noKeys) pl.keyBias = -20;
    else if (keyBias != null) pl.keyBias = keyBias;
    pl.avgAim = avgAim;
    // Your rule: a split may take a unit to 16 cells only if the other unit eats its pieces
    // straight away (you leave 16 within 0.1 s half the time, 0.4 s at p90). Every tick a
    // unit stays at 16 beyond stuckFree ticks costs wStuck.
    const run = [0, 0]; let stuck = 0, fulls = 0, splits = 0, pressed = 0, keys = 0;
    const pnet = p.wPress ? pressNet() : null;
    const log = this.trace ? [] : null; // analysis/futures-at.mjs
    // Drain: mass the lighter unit loses (is eaten) while it holds under drainShare.
    const um = (u) => { let m = 0; for (const c of s.cells(u)) m += c.mass; return m; };
    const M = um(0) + um(1), light = um(0) < um(1) ? 0 : 1;
    let prev = um(light), drain = 0;
    for (let t = 0; t < horizon; t++) {
      const d = prefix && t < prefix.length ? prefix[t] : script ? script(s, pl, t) : pl.decide(s);
      // Would you make this split here? (press.mjs; only splits that split something)
      if (pnet && (d.key === 'split1' || d.key === 'split4') && s.cells(s.active).length < 16 && s.cells(s.active ^ 1).length && s.cells(s.active).some((c) => c.mass >= s.cfg.minSplitMass)) {
        const ctx = { sinceSplit: pl.sinceSplit, sinceTab: pl.sinceTab, sameUnit: pl.lastSplitUnit === s.active };
        pressed += Math.max(-6, Math.min(6, pressLogit(pnet, s, d.key === 'split4', this.goal, d.aim, ctx, (this.pbuf ??= new Float32Array(PRESS_INPUTS)))));
      }
      if (d.key === 'split4' && s.cells(s.active).length < 16) fulls++;
      if ((d.key === 'split1' || d.key === 'split4') && s.cells(s.active).length < 16 && s.cells(s.active).some((c) => c.mass >= s.cfg.minSplitMass)) splits++;
      if (d.key !== 'none') keys++;
      if (log && d.key !== 'none') log.push(`${t}:${d.key}u${s.active}`);
      pl.apply(s, d);
      const act = script && !prefix ? { key: d.key, aim: d.aim, esc: true } : { key: d.key, aim: d.aim, comp: d.comp, hold: d.hold };
      if (t < p.decideEvery) acts.push(act);
      if (!script) all.push(act);
      s.step();
      if (p.wStuck) for (let u = 0; u < 2; u++) { if (s.cells(u).length >= 16) { if (++run[u] > p.stuckFree) stuck++; } else run[u] = 0; }
      if (p.wDrain) { const m = um(light); if (m < prev && m / M < p.drainShare) drain += (prev - m) / M; prev = m; }
    }
    // A full split shatters every small cell of the unit into pieces of 1/16: you use one
    // about every 9 s (half of them onto your other unit), so it has to beat a single split
    // by wFull.
    let v = this.score(s, origin) - p.wStuck * stuck - p.wFull * fulls + p.wSplit * splits + p.wPress * pressed - p.wDrain * drain * 100;
    // A trap: the lighter unit is small and none of its cells can eat a cell of the other
    // unit, so it can only be eaten (how every unit the bot lost was lost).
    if (p.wTrap && trapped(s, p.trapShare)) v -= p.wTrap;
    // Your shape: the look network's log-odds that the position 2 s on is one of yours.
    if (p.wLook) { const net = lookNet(); if (net) v += p.wLook * Math.max(-6, Math.min(6, lookLogit(net, s, origin, this.goal, (this.lbuf ??= new Float32Array(LOOK_INPUTS))))); }
    if (reach && p.escReach) v += p.escReach * this.reach(s);
    return { v, acts, all, log, keys, game: s };
  }

  // Food within reach of the lighter unit: the share of the mass in cells of the heavy unit
  // that a cell of the lighter unit can eat, each counted less the further the nearest such
  // eater is (half at 800 between their edges). Tells an escape that walks towards food
  // from one that walks nowhere, seconds before anything is eaten.
  reach(s) {
    let m0 = 0, m1 = 0; for (const c of s.cells(0)) m0 += c.mass; for (const c of s.cells(1)) m1 += c.mass;
    if (!m0 || !m1) return 0;
    const L = m0 < m1 ? 0 : 1; let sum = 0;
    for (const b of s.cells(L ^ 1)) {
      let best = 0;
      for (const a of s.cells(L)) if (a.mass >= 1.3 * b.mass) {
        const f = 1 / (1 + Math.max(0, Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r) / 800);
        if (f > best) best = f;
      }
      sum += b.mass * best;
    }
    return sum / (m0 + m1);
  }

  // ---- escapes from a drain -----------------------------------------------------------
  // Your habits never meet a drain (the lighter unit sliding to nothing while the heavy unit
  // eats its cells as they touch), so the learned player's futures hold no way out: these
  // are scripts for it. Each is { name, make }, make() giving a function (game, player, tick)
  // -> { key, aim } with the same keys as the learned player, under the same limits (key gap,
  // split budget, lighter-unit rule). All end in the hunter: the lighter unit controlled,
  // its cells walked onto cells of the heavy unit they can eat (most mass per tick of walking
  // first, on a way that passes no heavy cell that can eat them), split onto them when the
  // halves can eat what they land on and nothing eats the halves; with nothing to eat it
  // walks away from the heavy unit's cells that can eat it.
  //   hunt        the hunter at once
  //   flee        only walk away
  //   split <a>   first the heavy unit splits with the cursor at <a> degrees from the course
  //               (or 'light': at the lighter unit's biggest cell): pieces the hunter can eat
  //   walk <a>    first the heavy unit's cursor is put there without a split ('stop': on its
  //               own centre): its cells walk there while the hunter plays (small cells walk
  //               faster, so they arrive first)
  escapes(g) {
    const p = this.p, G = this.goal;
    if (!p.escShare) return [];
    let m0 = 0, m1 = 0; for (const c of g.cells(0)) m0 += c.mass; for (const c of g.cells(1)) m1 += c.mass;
    if (!m0 || !m1 || Math.min(m0, m1) / (m0 + m1) >= p.escShare) return [];
    const L = m0 < m1 ? 0 : 1, H = L ^ 1, EAT = 1.3, FLY = 750; // a split half flies about 750
    const keyOk = (pl) => pl.sinceKey >= pl.keyGap;
    const speed = (c) => 82.5 * Math.pow(c.r, -0.432);
    const stay = (s) => ({ ...s.player.units[s.active].aim });
    // distance from point q to the segment a-b
    const segDist = (qx, qy, ax, ay, bx, by) => {
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((qx - ax) * dx + (qy - ay) * dy) / l2)) : 0;
      return Math.hypot(qx - ax - t * dx, qy - ay - t * dy);
    };
    const flee = (s) => {
      let fx = 0, fy = 0;
      for (const a of s.cells(L)) for (const b of s.cells(H)) if (b.mass >= EAT * a.mass) {
        const dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy) || 1, gap = Math.max(100, d - b.r);
        fx += (dx / d) * a.mass / (gap * gap); fy += (dy / d) * a.mass / (gap * gap);
      }
      const f = Math.hypot(fx, fy), c = s.unitCentre(L);
      return f ? { x: c.x + (fx / f) * 3000, y: c.y + (fy / f) * 3000 } : { x: c.x + G.x * 3000, y: c.y + G.y * 3000 };
    };
    // Mass of the lighter unit that walks into a heavy cell that can eat it, with the cursor
    // at P for `ticks` (the heavy cells taken halfway to their own cursor).
    const walkRisk = (s, P, ticks) => {
      const ha = s.player.units[H].aim; let risk = 0;
      for (const c of s.cells(L)) {
        const dx = P.x - c.x, dy = P.y - c.y, d = Math.hypot(dx, dy) || 1, len = Math.min(d, speed(c) * ticks);
        const ex = c.x + (dx / d) * len, ey = c.y + (dy / d) * len;
        for (const h of s.cells(H)) if (h.mass >= EAT * c.mass) {
          const hx = ha.x - h.x, hy = ha.y - h.y, hd = Math.hypot(hx, hy) || 1, hl = Math.min(hd, speed(h) * ticks * 0.5);
          const px = h.x + (hx / hd) * hl, py = h.y + (hy / hd) * hl;
          if (segDist(px, py, c.x, c.y, ex, ey) < h.r - 0.425 * c.r + 60 && Math.hypot(ex - px, ey - py) < Math.hypot(c.x - h.x, c.y - h.y)) { risk += c.mass; break; }
        }
      }
      return risk;
    };
    // where the hunter walks: { aim, prey }
    const walk = (s) => {
      const pairs = [];
      for (const a of s.cells(L)) for (const b of s.cells(H)) if (a.mass >= EAT * b.mass) {
        const d = Math.hypot(b.x - a.x, b.y - a.y), time = Math.max(0, d - (a.r - 0.425 * b.r)) / speed(a);
        pairs.push({ a, b, d, time, val: b.mass / (time + 25) });
      }
      pairs.sort((x, y) => y.val - x.val);
      let best = null, bv = 0;
      for (const q of pairs.slice(0, 6)) {
        const ux = (q.b.x - q.a.x) / (q.d || 1), uy = (q.b.y - q.a.y) / (q.d || 1);
        const aim = { x: q.b.x + ux * 400, y: q.b.y + uy * 400 };
        const v = (q.b.mass - 2 * walkRisk(s, aim, Math.min(60, q.time + 10))) / (q.time + 25);
        if (v > bv) { bv = v; best = { aim, prey: q }; }
      }
      return best ?? { aim: front(s), prey: null };
    };
    // Nothing to eat: get in front of the heavy unit, where its forward splits land (how you
    // win mass back: the heavy unit splits onto the lighter one's big cell, which eats the
    // pieces). Forward on the least dangerous of a few headings; once the lighter unit's
    // biggest cell leads the heavy unit's centre, wait there.
    const front = (s) => {
      let big = s.cells(L)[0]; for (const c of s.cells(L)) if (c.mass > big.mass) big = c;
      const hc = s.unitCentre(H), lc = s.unitCentre(L), lm = s.cells(L).reduce((a, c) => a + c.mass, 0);
      if ((big.x - hc.x) * G.x + (big.y - hc.y) * G.y > p.escLead) return { x: big.x, y: big.y };
      let best = null, bv = Infinity; const base = Math.atan2(G.y, G.x);
      for (const a of [0, 30, -30, 60, -60, 90, -90]) {
        const P = { x: lc.x + Math.cos(base + a * DEG) * 3000, y: lc.y + Math.sin(base + a * DEG) * 3000 };
        const v = walkRisk(s, P, 60) + (Math.abs(a) / 90) * 0.02 * lm;
        if (v < bv) { bv = v; best = P; }
      }
      return best;
    };
    // A split of the lighter unit towards P: mass its halves eat where they fly and land
    // against mass of it that gets eaten (a flying half, or a half left next to a heavy cell
    // that could not eat the whole cell).
    const splitPays = (s, P) => {
      const cells = s.cells(L); let slots = 16 - cells.length, gain = 0, loss = 0;
      for (const c of cells) {
        if (slots <= 0) break; if (c.mass < 44) continue; slots--;
        const half = c.mass / 2, r = Math.sqrt(100 * half), dx = P.x - c.x, dy = P.y - c.y, d = Math.hypot(dx, dy) || 1;
        const ex = c.x + (dx / d) * FLY, ey = c.y + (dy / d) * FLY;
        let eaten = false;
        for (const h of s.cells(H)) if (h.mass >= EAT * half && segDist(h.x, h.y, c.x, c.y, ex, ey) < h.r - 0.425 * r + 60) { eaten = true; break; }
        if (eaten) { loss += c.mass; continue; }
        for (const b of s.cells(H)) if (half >= EAT * b.mass && segDist(b.x, b.y, c.x, c.y, ex, ey) < r - 0.425 * b.r) gain += b.mass;
        for (const h of s.cells(H)) if (h.mass >= EAT * half && Math.hypot(h.x - c.x, h.y - c.y) < h.r - 0.425 * r + 150) { loss += half; break; }
      }
      return gain > 0 && gain >= 2 * loss;
    };
    const hunter = (only = false) => (s, pl) => {
      if (!s.cells(L).length || !s.cells(H).length) return { key: 'none', aim: stay(s) }; // a unit is lost in this future
      const w = only ? { aim: flee(s), prey: null } : walk(s);
      if (s.active !== L) return keyOk(pl) ? { key: 'tab', aim: w.aim } : { key: 'none', aim: stay(s) };
      const split = w.prey && keyOk(pl) && s.cells(L).length < 16 && pl.maySplit(s) && splitPays(s, w.aim);
      return { key: split ? 'split1' : 'none', aim: w.aim };
    };
    // the heavy unit first: its cursor at `at` (degrees from the course, or 'light'), with a split or without
    const heavyFirst = (at, split) => {
      let phase = 0, since = 0; const then = hunter();
      return (s, pl, t) => {
        if (phase < 2 && (t >= 12 || !s.cells(L).length || !s.cells(H).length)) phase = 2;
        if (phase === 2) return then(s, pl, t);
        let aim;
        if (at === 'light') { let big = s.cells(L)[0]; for (const c of s.cells(L)) if (c.mass > big.mass) big = c; aim = { x: big.x, y: big.y }; }
        else if (at === 'stop') aim = s.unitCentre(H);
        else { const c = s.unitCentre(H), a = Math.atan2(G.y, G.x) + at * DEG; aim = { x: c.x + Math.cos(a) * 2500, y: c.y + Math.sin(a) * 2500 }; }
        // its cursor is there already: no Tab there and back for nothing
        if (!split && s.active !== H && Math.hypot(s.player.units[H].aim.x - aim.x, s.player.units[H].aim.y - aim.y) < 400) { phase = 2; return then(s, pl, t); }
        if (s.active !== H) return keyOk(pl) ? { key: 'tab', aim } : { key: 'none', aim: stay(s) };
        if (phase === 0) {
          if (!split) { phase = 2; return { key: 'none', aim }; }
          if (s.cells(H).length >= 16) { phase = 2; return then(s, pl, t); }
          if (keyOk(pl) && pl.maySplit(s)) { phase = 1; since = 0; return { key: 'split1', aim }; }
          return { key: 'none', aim };
        }
        if (++since >= 3) { phase = 2; return then(s, pl, t); } // the cursor stays while the halves are thrown
        return { key: 'none', aim };
      };
    };
    const out = [{ name: 'hunt', make: () => hunter() }, { name: 'flee', make: () => hunter(true) }];
    const dirs = [0, 45, -45, 90, -90, 135, -135, 180, 'light'];
    if (g.cells(H).length < 16) for (const a of dirs) out.push({ name: 'split ' + a, make: () => heavyFirst(a, true) });
    // (a heading only while the heavy unit is the controlled one: no Tab there and back for it)
    for (const a of g.active === H ? ['stop', 'light', 0, 180] : ['stop', 'light']) out.push({ name: 'walk ' + a, make: () => heavyFirst(a, false) });
    return out;
  }

  // After a reset to the start position: drop the plan made for the old position.
  restart() { this.queue = null; this.queued = null; this.plan = null; if (this.player) { this.player.hold = 0; this.player.comp = -1; } }

  // Called once per game tick, before the tick runs. Sends inputs to `g` (aim/split/tab).
  act(g, tick) {
    if (!this.line) { this.line = g.centre(); this.mass0 = g.mass(); }
    if (this.p.planner === 'shoot') return this.actShoot(g, tick);
    if (this.p.planner === 'imitate') return this.actImitate(g, tick);
    if (this.queued && tick >= this.queued.at) {
      if (tick - this.lastKey >= this.p.keyGap) { g.split(this.queued.n); this.lastKey = tick; }
      this.queued = null;
    }
    if (tick - (this.lastDecide ?? -1e9) < this.p.decideEvery || this.queued) {
      if (this.aimPoint) g.aim(this.aimPoint.x, this.aimPoint.y);
      return;
    }
    this.lastDecide = tick;
    let best = null, bestV = -Infinity;
    for (const cand of this.candidates(g, tick)) {
      const v = this.rollout(g, cand);
      if (v > bestV) { bestV = v; best = cand; }
    }
    this.aimPoint = best.aim;
    if (best.tab) { g.tab(); this.lastKey = tick; }
    g.aim(best.aim.x, best.aim.y);
    for (const key of best.keys) {
      if (key.k === 'tab') continue;
      if (key.dt === 0) { g.split(key.k); this.lastKey = tick; }
      else this.queued = { at: tick + key.dt, n: key.k };
    }
  }
}
