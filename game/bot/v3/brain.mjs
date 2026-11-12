// Bot v3: the split-run brain.
//
// It presses a split key on a steady rhythm (`gap` ticks apart, never faster than your cap),
// and for every press it decides three things by trying them in an exact copy of the game
// (sim.mjs): which unit splits (Tab or not), which key (split, double split, full split) and
// where the cursor is. Each try is played forward to the next press; what the position is
// worth from there on comes from the value network (trained by self-play, train.mjs): the
// distance it expects the bot to make over the coming seconds. The best `beam` tries are then
// looked at one press deeper. A try in which a unit dies is thrown out.
// Without a network it finishes each try with plain alternate splits and a hand-made score:
// that is the player the first round of training starts from.
//
// Only the keys you allow: cursor, split, double split, full split, Tab. Never W, E or freeze.
import { Sim, CAP, THROW } from './sim.mjs';
import { featurize, INPUTS } from './features.mjs';

export const DEFAULT_PARAMS = {
  gap: 14,              // ticks between split presses: 14 = 1.79 presses/s (your cap is 1.85)
  beam: 8,              // best tries looked at one press deeper (0 = off)
  angles: [0, 12, -12, 25, -25, 45, -45], // cursor directions off the course (degrees)
  wide: [70, -70, 110, -110, 180],        // more directions, at the middle distance only (throwing back into the other unit)
  dists: [1500, 20000],                   // cursor distances from the centre of the unit
  targets: 3,           // cursor also on each of the other unit's biggest cells
  walkDist: 1500,       // between presses the cursor is this far ahead...
  walkMix: 1,           // ...of the unit's own centre (0) or of the centre of both units (1)
  alt: true,            // each try also comes with the other way of walking after the split:
  altDist: 20000, altMix: 0, // straight on, the units side by side
  steer: 3000,          // back to the course line: 1 radian of correction per this many units off it
  maxSteer: 0.35,
  // what a press is worth: distance made along the course until the next press, minus:
  maxIdle: 36,          // ticks a unit may go without splitting...
  wIdle: 8,             // ...each tick over costs this (per press)
  idleCap: 40,          // ...up to this many ticks over
  minShare: 0.15,       // the lighter unit should keep this share of the mass...
  wShare: 3000,         // ...each 1.0 of share under it costs this (per press)
  wStuck: 0,            // per press that a unit sits at 16 cells (it cannot split)
  minBig: 0.05,         // each unit should keep a cell of at least this share of all mass (an eater)...
  wBig: 0,              // ...each 1.0 under it costs this
  waitTicks: 0,         // > 0: not pressing for this many ticks is also a try
  wFull: 0,             // cost of a full split press
  wDouble: 0,           // cost of a double split press
  gamma: 0.95,          // what the press after next is worth compared with the next one
  stallPenalty: 5000,   // a unit left without a split for 3 s (training ends the attempt there)
  lossPenalty: 10000,   // losing a unit, in units of distance (training targets; the look-ahead never picks it)
  // playing without a network:
  presses: 5,           // presses looked ahead in a try, the first one included
  plainMode: 0,         // how a try is played on after its first press: 0 = the units in turn, straight on; 1 = your habit (see plain())
  wFlight: 1,           // distance pieces still in the air will fly
  wPot: 0.6,            // distance the next press of each unit can throw (needs free cell slots)
  wEdible: 0,           // x share of the mass that the other unit's biggest cell could eat
  wSlots: 0,            // per free cell slot
  wCrowd: 0,            // x (cells over crowdFree)^2, per unit
  crowdFree: 8,
  wSep: 0.1,            // per unit the two units are further apart than sepFree
  sepFree: 2200,
  // self-play only:
  explore: 0,           // chance that a press is a random one of the best `exploreTop` tries
  exploreTop: 5,
};

const DEG = Math.PI / 180;
const tmpA = {}, tmpB = {}, tmpC = {};

export class Brain {
  constructor(params = {}, goalAngle = 0, net = null) {
    this.p = { ...DEFAULT_PARAMS, ...params };
    this.net = net; this.fbuf = new Float32Array(INPUTS);
    this.setCourse(goalAngle);
    this.pool = [new Sim(), new Sim()];
    this.trace = null;   // self-play: set to [] to collect { x, along, pen } at every press
    this.line = null;    // a point on the course line (set at the first tick)
    this.stats = { decisions: 0, tries: 0, ms: 0, noSafe: 0 };
    this.reset();
  }
  setCourse(angle) { this.goal = { x: Math.cos(angle), y: Math.sin(angle) }; this.goalAngle = angle; }
  // After a reset to a start position: forget the rhythm of the old position.
  reset(why = 'lost') { this.nextPress = -1; this.walkAt = -1; this.planned = null; this.ctx = { last: -1, idle0: 0, idle1: 0, pen: 0 }; this.lastTick = null; this.lastPressTick = null; if (this.trace) this.trace.push({ end: why === 'stall' ? this.p.stallPenalty : this.p.lossPenalty }); }

  // ---- geometry ----
  // The direction to run in from this position: the course, bent back toward the course line.
  heading(s, out) {
    const p = this.p, G = this.goal, c = s.centre(tmpC);
    const off = (c.x - this.line.x) * -G.y + (c.y - this.line.y) * G.x; // + = left of the line
    const a = this.goalAngle - Math.max(-p.maxSteer, Math.min(p.maxSteer, off / p.steer));
    out.a = a; out.x = Math.cos(a); out.y = Math.sin(a); return out;
  }
  // Cursor far ahead of unit u: it walks straight on.
  walkAim(s, u, out, mode = 0) {
    // walkMix 0: straight on from the unit's own centre (the two units run side by side);
    // walkMix 1: to a point `walkDist` ahead of the centre of everything, like your cursor: the
    // two units walk into each other, so the big cells of one run over the small cells of the other.
    const p = this.p, h = this.heading(s, tmpB), c = s.unitCentre(u, tmpA), all = tmpC, k = mode ? p.altMix : p.walkMix, dist = mode ? p.altDist : p.walkDist; // (heading() left the centre of everything in tmpC)
    const bx = c.x + (all.x - c.x) * k, by = c.y + (all.y - c.y) * k;
    out.x = Math.round(bx + h.x * dist); out.y = Math.round(by + h.y * dist); return out; // whole numbers: what the cursor packet carries
  }
  along(s, root) { const c = s.centre(tmpC); return (c.x - root.x) * this.goal.x + (c.y - root.y) * this.goal.y; }

  // ---- the tries ----
  // Every press that can be made from this position: { unit, n, x, y }. Returns how many.
  candidates(s, out) {
    const p = this.p; let k = 0;
    const ha = this.heading(s, tmpB).a;
    for (let i = 0; i < 2; i++) {
      const u = i === 0 ? s.active : s.active ^ 1;
      if (!s.canSplit(u)) continue;
      const c = s.unitCentre(u, tmpA), cx = c.x, cy = c.y, n = s.n(u);
      const first = k;
      for (const deg of p.angles) for (const dist of p.dists) {
        const a = ha + deg * DEG, o = (out[k++] ??= {});
        o.unit = u; o.n = 1; o.w = 0; o.x = Math.round(cx + Math.cos(a) * dist); o.y = Math.round(cy + Math.sin(a) * dist);
      }
      for (const deg of p.wide) { const a = ha + deg * DEG, o = (out[k++] ??= {}); o.unit = u; o.n = 1; o.w = 0; o.x = Math.round(cx + Math.cos(a) * 3000); o.y = Math.round(cy + Math.sin(a) * 3000); }
      for (let r = 0; r < p.targets; r++) {
        if (!s.top(u ^ 1, r, tmpA)) break;
        const o = (out[k++] ??= {}); o.unit = u; o.n = 1; o.w = 0; o.x = Math.round(tmpA.x); o.y = Math.round(tmpA.y);
      }
      const last = k;
      // the same cursors with a double split and a full split, while there is room for them
      if (n < 12) for (let j = first; j < last; j++) { const o = (out[k++] ??= {}); o.unit = u; o.n = 2; o.w = 0; o.x = out[j].x; o.y = out[j].y; }
      if (n < 6) for (let j = first; j < last; j++) { const o = (out[k++] ??= {}); o.unit = u; o.n = 4; o.w = 0; o.x = out[j].x; o.y = out[j].y; }
      // each of them again with the other way of walking afterwards
      if (p.alt) for (let j = first, end = k; j < end; j++) { const o = (out[k++] ??= {}); o.unit = u; o.n = out[j].n; o.w = 1; o.x = out[j].x; o.y = out[j].y; }
    }
    // and not pressing at all for a moment: walk, let the cells eat, look again
    if (p.waitTicks > 0 && k > 0) for (let w = 0; w < (p.alt ? 2 : 1); w++) { const o = (out[k++] ??= {}); o.unit = s.active; o.n = 0; o.w = w; o.x = 0; o.y = 0; }
    return k;
  }
  // What the stretch up to a press costs besides distance: a unit left without a split for too
  // long, a unit drained too far. dt: ticks since the last press.
  penalty(s, ctx, dt) {
    const p = this.p;
    let pen = p.wIdle * (Math.min(p.idleCap, Math.max(0, ctx.idle0 - p.maxIdle)) + Math.min(p.idleCap, Math.max(0, ctx.idle1 - p.maxIdle))) * Math.min(dt, 28) / 14;
    const m0 = s.unitMass(0), m1 = s.unitMass(1), share = Math.min(m0, m1) / (m0 + m1);
    if (share < p.minShare) pen += p.wShare * (p.minShare - share);
    if (p.wStuck) pen += p.wStuck * ((s.n(0) >= CAP ? 1 : 0) + (s.n(1) >= CAP ? 1 : 0)) * dt / 14;
    if (p.wBig) { const M = m0 + m1, b0 = s.biggest(0) / M, b1 = s.biggest(1) / M; if (b0 < p.minBig) pen += p.wBig * (p.minBig - b0); if (b1 < p.minBig) pen += p.wBig * (p.minBig - b1); }
    return pen;
  }
  // Plays one press and the `gap` ticks after it on s. Returns false if a unit died.
  press(s, ctx, a) {
    const p = this.p, g = p.gap;
    if (a && a.n === 0) { // wait
      const w = p.waitTicks;
      this.walkAim(s, s.active, tmpA, a.w); s.aim(tmpA.x, tmpA.y);
      for (let t = 0; t < w; t++) s.tick();
      ctx.idle0 += w; ctx.idle1 += w;
      if (s.lost) return false;
      ctx.pen += this.penalty(s, ctx, w);
      return true;
    }
    if (a) {
      if (a.unit !== s.active) s.tab();
      s.aim(a.x, a.y); s.split(a.n);
      for (let t = 0; t < a.n; t++) s.tick();
      if (s.lost) return false;
      this.walkAim(s, s.active, tmpA, a.w); s.aim(tmpA.x, tmpA.y);
      for (let t = a.n; t < g; t++) s.tick();
      ctx.last = a.unit;
      if (a.unit === 0) { ctx.idle0 = 0; ctx.idle1 += g; } else { ctx.idle1 = 0; ctx.idle0 += g; }
      if (a.n === 4) ctx.pen += p.wFull; else if (a.n === 2) ctx.pen += p.wDouble;
    } else { // nothing can split: walk on
      for (let t = 0; t < g; t++) s.tick();
      ctx.idle0 += g; ctx.idle1 += g;
    }
    if (s.lost) return false;
    ctx.pen += this.penalty(s, ctx, g);
    return true;
  }
  value(s, ctx) { return this.net.forward(featurize(s, this.goal.x, this.goal.y, ctx.idle0, ctx.idle1, this.fbuf)); }

  // ---- without a network: plain continuation and a hand-made score ----
  plain(s, ctx, out) {
    let u = ctx.last === 0 ? 1 : ctx.last === 1 ? 0 : s.active;
    if (this.p.plainMode === 1) {
      // Your habit: split the unit whose thrown halves the other unit's biggest cell can eat,
      // with the cursor on that cell.
      const e0 = s.canSplit(0) ? s.edible(0, 2 * s.biggest(1)) : -1, e1 = s.canSplit(1) ? s.edible(1, 2 * s.biggest(0)) : -1;
      if (e0 < 0 && e1 < 0) return false;
      const pick = e0 === e1 ? (e0 >= 0 && s.canSplit(u) ? u : e0 >= 0 ? 0 : 1) : e0 > e1 ? 0 : 1;
      // not the same unit over and over while the other one can also feed
      u = pick === ctx.last && (pick ? e0 : e1) > 0.5 * (pick ? e1 : e0) ? pick ^ 1 : pick;
      if ((u ? e1 : e0) > 0 && s.top(u ^ 1, 0, tmpA)) { out.x = Math.round(tmpA.x); out.y = Math.round(tmpA.y); } else this.walkAim(s, u, out);
      out.unit = u; out.n = 1; out.w = 0; return true;
    }
    if (!s.canSplit(u)) { u ^= 1; if (!s.canSplit(u)) return false; }
    this.walkAim(s, u, out); out.unit = u; out.n = 1; out.w = 0; return true;
  }
  finish(s, ctx, more, root) {
    const a = (this.tmpAct ??= {});
    for (let i = 0; i < more; i++) if (!this.press(s, ctx, this.plain(s, ctx, a) ? a : null)) return -1e9 + i;
    return this.score(s, root) - ctx.pen;
  }
  score(s, root) {
    const p = this.p, G = this.goal;
    const c = s.centre(tmpC), M = c.m;
    let v = (c.x - root.x) * G.x + (c.y - root.y) * G.y;
    v += p.wFlight * s.flight(G.x, G.y) / M;
    v += p.wPot * (s.splittable(0) + s.splittable(1)) * 0.5 * THROW / M;
    if (p.wEdible) v += p.wEdible * (s.edible(0, s.biggest(1)) + s.edible(1, s.biggest(0))) / M;
    if (p.wSlots) v += p.wSlots * (2 * CAP - s.n(0) - s.n(1));
    if (p.wCrowd) { const o0 = Math.max(0, s.n(0) - p.crowdFree), o1 = Math.max(0, s.n(1) - p.crowdFree); v -= p.wCrowd * (o0 * o0 + o1 * o1); }
    const a = s.unitCentre(0, tmpA), b = s.unitCentre(1, tmpB);
    const sep = Math.hypot(a.x - b.x, a.y - b.y);
    if (sep > p.sepFree) v -= p.wSep * (sep - p.sepFree);
    return v;
  }

  // The best press from this position, or null if nothing can split.
  decide(sim) {
    const p = this.p, t0 = performance.now(), net = this.net, g = p.gamma;
    const cands = (this.cands ??= []), nc = this.candidates(sim, cands);
    if (!nc) return null;
    const root = sim.centre({}), auto0 = sim.autoSplits;
    const s = this.pool[0], ctx = { last: 0, idle0: 0, idle1: 0, pen: 0 }, base = this.ctx;
    const vals = (this.vals ??= new Float64Array(2048));
    const AUTO = 1e5; // a cell over 22,500 bursts in a random direction: never
    let best = -1, bestV = -Infinity;
    for (let i = 0; i < nc; i++) {
      s.copyFrom(sim); ctx.last = base.last; ctx.idle0 = base.idle0; ctx.idle1 = base.idle1; ctx.pen = 0;
      let v = -1e9;
      if (this.press(s, ctx, cands[i])) {
        v = net ? this.along(s, root) - ctx.pen + g * this.value(s, ctx) : this.finish(s, ctx, p.presses - 1, root);
        v -= AUTO * (s.autoSplits - auto0);
      }
      vals[i] = v; if (v > bestV) { bestV = v; best = i; }
    }
    this.stats.tries += nc;
    // one press deeper from the best few
    if (p.beam > 0 && (net || p.presses > 2)) {
      const order = Array.from({ length: nc }, (_, i) => i).sort((a, b) => vals[b] - vals[a]).slice(0, p.beam);
      const s1 = this.pool[1], c1 = { last: 0, idle0: 0, idle1: 0, pen: 0 }, cands2 = (this.cands2 ??= []);
      let deep = -1, deepV = -Infinity;
      for (const i of order) {
        if (vals[i] < -1e8) break;
        s1.copyFrom(sim); c1.last = base.last; c1.idle0 = base.idle0; c1.idle1 = base.idle1; c1.pen = 0;
        this.press(s1, c1, cands[i]);
        const r1 = this.along(s1, root) - c1.pen, n2 = this.candidates(s1, cands2);
        let vi = n2 ? -Infinity : vals[i];
        for (let j = 0; j < n2; j++) {
          s.copyFrom(s1); ctx.last = c1.last; ctx.idle0 = c1.idle0; ctx.idle1 = c1.idle1; ctx.pen = 0;
          let v = -1e9;
          if (this.press(s, ctx, cands2[j])) {
            if (net) v = r1 + g * (this.along(s, root) - this.along(s1, root) - ctx.pen) + g * g * this.value(s, ctx);
            else { ctx.pen += c1.pen; v = this.finish(s, ctx, p.presses - 2, root); }
            v -= AUTO * (s.autoSplits - auto0);
          }
          if (v > vi) vi = v;
        }
        this.stats.tries += n2;
        vals[i] = vi; if (vi > deepV) { deepV = vi; deep = i; }
      }
      if (deep >= 0 && deepV > -1e8) { best = deep; bestV = deepV; }
      if (p.explore > 0 && Math.random() < p.explore) { const pick = order.filter((i) => vals[i] > -1e8).slice(0, p.exploreTop); if (pick.length) best = pick[Math.floor(Math.random() * pick.length)]; }
    } else if (p.explore > 0 && Math.random() < p.explore) {
      const pick = Array.from({ length: nc }, (_, i) => i).sort((a, b) => vals[b] - vals[a]).filter((i) => vals[i] > -1e8).slice(0, p.exploreTop);
      if (pick.length) best = pick[Math.floor(Math.random() * pick.length)];
    }
    this.stats.decisions++; this.stats.ms += performance.now() - t0;
    if (bestV < -1e8) this.stats.noSafe++;
    this.bestValue = bestV;
    return cands[best];
  }

  // Live play: works out the press of tick `at` ahead of time, on the position predicted for it.
  prethink(simAt, at) {
    const dt = at - this.lastTick, c = this.ctx;
    c.idle0 += dt; c.idle1 += dt;
    this.planned = { tick: at, a: this.decide(simAt) };
    c.idle0 -= dt; c.idle1 -= dt;
  }

  // Called once per game tick, before the tick runs, with the game as it is now.
  // Returns the keys to press this tick: ['aim', x, y], ['tab'], ['split', n].
  act(sim, tick) {
    const p = this.p, out = [];
    if (!this.line) { const c = sim.centre({}); this.line = { x: c.x, y: c.y }; }
    if (this.lastTick != null) { const dt = tick - this.lastTick; this.ctx.idle0 += dt; this.ctx.idle1 += dt; }
    this.lastTick = tick;
    if (tick === this.walkAt) { const a = this.walkAim(sim, sim.active, {}, this.walkMode); out.push(['aim', a.x, a.y]); }
    if (tick >= this.nextPress && sim.queue(0) === 0 && sim.queue(1) === 0) {
      const pl = this.planned; this.planned = null;
      const a = pl && pl.tick === tick && pl.a && (pl.a.n === 0 || sim.canSplit(pl.a.unit)) ? pl.a : this.decide(sim);
      if (a) {
        if (this.trace) { // self-play: the position at this press, and what the stretch since the last press cost
          const pen = this.lastPressTick == null ? 0 : this.penalty(sim, this.ctx, tick - this.lastPressTick);
          this.trace.push({ x: featurize(sim, this.goal.x, this.goal.y, this.ctx.idle0, this.ctx.idle1, new Float32Array(INPUTS)), along: this.along(sim, this.line), pen: pen + this.keyCost });
        }
        this.keyCost = a.n === 4 ? p.wFull : a.n === 2 ? p.wDouble : 0;
        if (a.n === 0) { // wait: only the cursor
          const w = this.walkAim(sim, sim.active, {}, a.w); out.push(['aim', w.x, w.y]);
          this.nextPress = tick + p.waitTicks; this.lastPressTick = tick;
        } else {
          if (a.unit !== sim.active) out.push(['tab']);
          out.push(['aim', a.x, a.y], ['split', a.n]);
          this.walkAt = tick + a.n; this.walkMode = a.w; this.nextPress = tick + p.gap; this.lastPressTick = tick;
          this.ctx.last = a.unit; if (a.unit === 0) this.ctx.idle0 = 0; else this.ctx.idle1 = 0;
        }
      } else { this.nextPress = tick + 2; if (tick !== this.walkAt) { const w = this.walkAim(sim, sim.active, {}); out.push(['aim', w.x, w.y]); } } // nothing can split: look again in two ticks
    }
    return out;
  }
}
Brain.prototype.keyCost = 0;

// Self-play: turns the trace of a game into training samples: for each press, the position
// and the return that followed (distance made minus costs, each later press counting `gamma`
// times the one before; a lost unit ends it with -lossPenalty). The last presses of a game,
// whose future is cut off, are left out. Returns { X, y, n }.
export function returnsOf(trace, p, cut = 12) {
  const X = [], y = [];
  let seg = [];
  const flush = (end) => { // end: the cost the stretch ended with (lost unit, stall), null = the game was cut off
    const lost = end != null;
    const n = seg.length; if (!n) return;
    const G = new Float64Array(n);
    // The game was cut off here: what would have followed is taken as more of the last 20 presses.
    let tail = 0; { const m = Math.min(20, n - 1); for (let k = n - m; k < n; k++) tail += seg[k].along - seg[k - 1].along - seg[k].pen; tail = m ? tail / m / (1 - p.gamma) : 0; }
    let acc = lost ? -end : tail;
    G[n - 1] = acc; // the last press before a lost unit
    // seg[k+1].along - seg[k].along - seg[k+1].pen is what press k earned
    for (let k = n - 2; k >= 0; k--) { acc = seg[k + 1].along - seg[k].along - seg[k + 1].pen + p.gamma * acc; G[k] = acc; }
    const upTo = lost ? n : n - 1 - cut;
    for (let k = 0; k < upTo; k++) { X.push(seg[k].x); y.push(G[k]); }
    seg = [];
  };
  for (const e of trace) { if (e.end != null) flush(e.end); else seg.push(e); }
  flush(null);
  return { X, y, n: y.length };
}
