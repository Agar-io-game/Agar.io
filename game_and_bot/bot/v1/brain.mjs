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
const POLICY_FILE = new URL('./data/policy.json', import.meta.url);
const NETS = new Map();
// file: another policy (params.policy), e.g. to compare with an older one
export function policyNet(file = POLICY_FILE) {
  const key = String(file);
  if (!NETS.has(key) && existsSync(file)) { const w = JSON.parse(readFileSync(file, 'utf8')); NETS.set(key, new MLP(w.sizes, w)); }
  return NETS.get(key) ?? null;
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
      this.player = new ImitationPlayer(net, { goalAngle: Math.atan2(this.goal.y, this.goal.x), keyGap: p.keyGap, temperature: p.temp, keyBias: p.keyBias, aimSwitch: p.aimSwitch, keyNet: p.keyPolicy ? policyNet(p.keyPolicy) : null, choiceAt: p.choiceAt });
    }
    if (this.queue?.length && tick - this.lastDecide < p.decideEvery) { this.player.apply(g, this.queue.shift()); return; }
    this.lastDecide = tick;
    this.queue = this.futures(g, this.player, 0, p.samples).acts;
    this.player.apply(g, this.queue.shift());
  }

  // Futures from..from+count-1 of one decision (live mode spreads them over worker threads):
  // returns the first decideEvery actions of the best one, and its score.
  futures(g, player, from, count) {
    const p = this.p, origin = g.centre();
    let best = null, bestV = -Infinity;
    for (let i = from; i < from + count; i++) {
      const s = g.clone(), pl = player.clone(), acts = [];
      pl.aimNoise = i === 0 ? 0 : p.aimNoise;
      if (i === 1) pl.keyBias = -20; // the safe fallback: your cursor, no keys
      // a share of the futures uses the average of your cursor choices instead of one choice
      pl.avgAim = i === 1 ? p.avgAim > 0 : i > 1 && Math.random() < p.avgAim;
      // Your rule: a split may take a unit to 16 cells only if the other unit eats its pieces
      // straight away (you leave 16 within 0.1 s half the time, 0.4 s at p90). Every tick a
      // unit stays at 16 beyond stuckFree ticks costs wStuck.
      const run = [0, 0]; let stuck = 0, fulls = 0, splits = 0;
      for (let t = 0; t < p.horizon; t++) {
        const d = pl.decide(s);
        if (d.key === 'split4' && s.cells(s.active).length < 16) fulls++;
        if ((d.key === 'split1' || d.key === 'split4') && s.cells(s.active).length < 16 && s.cells(s.active).some((c) => c.mass >= s.cfg.minSplitMass)) splits++;
        pl.apply(s, d);
        if (t < p.decideEvery) acts.push({ key: d.key, aim: d.aim, comp: d.comp, hold: d.hold });
        s.step();
        if (p.wStuck) for (let u = 0; u < 2; u++) { if (s.cells(u).length >= 16) { if (++run[u] > p.stuckFree) stuck++; } else run[u] = 0; }
      }
      // A full split shatters every small cell of the unit into pieces of 1/16: you use one
      // about every 9 s (half of them onto your other unit), so it has to beat a single split
      // by wFull.
      let v = this.score(s, origin) - p.wStuck * stuck - p.wFull * fulls + p.wSplit * splits;
      // Your shape: the look network's log-odds that the position 2 s on is one of yours.
      if (p.wLook) { const net = lookNet(); if (net) v += p.wLook * Math.max(-6, Math.min(6, lookLogit(net, s, origin, this.goal, (this.lbuf ??= new Float32Array(LOOK_INPUTS))))); }
      if (v > bestV) { bestV = v; best = acts; }
    }
    return { acts: best, value: bestV };
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
