// Live mode's planner: the 'imitate' planner's futures (brain.mjs, Brain.futures) spread over
// worker threads, so a decision takes about one tick instead of two or three. live.mjs hands
// it the state predicted for the tick the new inputs will start on.
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { pickFuture } from './brain.mjs';

export class PlannerPool {
  constructor(params, goalAngle, threads = 4) {
    this.params = params; this.goalAngle = goalAngle;
    this.workers = Array.from({ length: threads }, () => new Worker(fileURLToPath(import.meta.url)));
    for (const w of this.workers) w.unref();
  }
  // state: Game.state(); player: { sinceKey, sinceTab, lastKey }; ctx: { line, mass0 }.
  // Resolves to { acts, value } of the future to play over all workers (brain.mjs, pickFuture).
  plan(state, player, ctx, samples) {
    const n = this.workers.length, per = Math.ceil(samples / n);
    return Promise.all(this.workers.map((w, k) => new Promise((res, rej) => {
      const ok = (m) => { w.off('error', bad); res(m); }, bad = (e) => { w.off('message', ok); rej(e); };
      w.once('message', ok); w.once('error', bad);
      w.postMessage({ params: this.params, goalAngle: this.goalAngle, state, player, ctx, from: k * per, count: Math.max(0, Math.min(per, samples - k * per)) });
    }))).then((rs) => pickFuture(rs, this.params));
  }
  close() { for (const w of this.workers) w.terminate(); }
}

// Plays the imitate planner in real time. Call step(g) once per tick, before the tick, with
// that tick's Game (inputs go through its methods). It sends the queued input for this tick;
// when one input is left in the queue, it predicts the state 2 ticks ahead (by playing the
// queued inputs in a copy) and has the pool plan from there, so the plan is ready by then.
// If a plan is late anyway, it plays the learned policy's cursor without keys meanwhile.
export class Pipeline {
  constructor(params, goalAngle, { threads = 4, ImitationPlayer, net, DEFAULTS, playerOptions }) {
    const p = (this.p = { ...DEFAULTS, ...params });
    this.pool = new PlannerPool(params, goalAngle, threads);
    this.player = new ImitationPlayer(net, playerOptions(p, goalAngle));
    this.queue = []; this.inflight = null; this.tick = 0; this.ctx = null; this.late = 0; this.epoch = 0;
  }
  // After a reset to the start position: plans made for the old position are dropped.
  restart() { this.queue = []; this.epoch++; this.player.hold = 0; this.player.comp = -1; }
  step(g) {
    if (!this.ctx) this.ctx = { line: g.centre(), mass0: g.mass() };
    let d = this.queue.shift();
    if (!d) { this.late++; d = { key: 'none', aim: this.player.decide(g).aim }; }
    this.player.apply(g, d);
    this.tick++;
    if (!this.inflight && this.queue.length <= 1) {
      const s = g.clone(), pl = this.player.clone();
      s.step();
      for (const a of this.queue) { pl.apply(s, a); s.step(); }
      const startTick = this.tick + this.queue.length, epoch = this.epoch;
      this.inflight = this.pool.plan(s.state(), { sinceKey: pl.sinceKey, sinceTab: pl.sinceTab, lastKey: pl.lastKey, comp: pl.comp, hold: pl.hold, tokens: pl.tokens, sinceSplit: pl.sinceSplit, lastSplitUnit: pl.lastSplitUnit, idle: pl.idle }, this.ctx, this.p.samples).then((r) => {
        if (epoch === this.epoch) this.queue.push(...r.acts.slice(Math.max(0, this.tick - startTick)));
        this.inflight = null;
      });
    }
    return this.inflight;
  }
  close() { this.pool.close(); }
}

if (!isMainThread) {
  const { Game } = await import('./sim.mjs');
  const { Brain, policyNet, playerOptions } = await import('./brain.mjs');
  const { ImitationPlayer } = await import('./policy.mjs');
  let brain = null, player = null, key = null;
  parentPort.on('message', ({ params, goalAngle, state, player: ps, ctx, from, count }) => {
    if (key !== goalAngle) {
      key = goalAngle; brain = new Brain(params, goalAngle);
      player = new ImitationPlayer(policyNet(), playerOptions(brain.p, goalAngle));
    }
    if (!count) { parentPort.postMessage({ acts: null, value: -Infinity, esc: null }); return; }
    brain.line = ctx.line; brain.mass0 = ctx.mass0;
    Object.assign(player, ps);
    parentPort.postMessage(brain.futures(new Game(state), player, from, count));
  });
}
