// Trains the bot: a cross-entropy evolution strategy over the bot's judgement weights
// (brain.mjs DEFAULT_PARAMS). Each candidate plays full games from the start state
// (data/start-state.json: your game at 48.2 s, 35000 mass) with mass decay OFF and map
// walls OFF, on all CPU threads; the best weights so far are saved to data/params.json.
//   node bot/train.mjs [generations=30] [--seconds 75] [--warmup 25] [--pop 12] [--resume] [--init params.json]
// A candidate is scored on its speed from `warmup` to `seconds` only: the start state is a
// good split-run position, and spending it in the first seconds must not count as skill.
// For the 'imitate' planner (the one in use) the score also holds what you asked for:
//   - a lost unit is a massive no: -LOSS per unit lost per game (the game resets to the start
//     position, so the speed alone would hide it);
//   - a faster split rhythm than yours: +SPLIT per split/s above your 1.37/s (capped at +1/s);
//   - your shape: +LOOK x (how often its positions pass for yours (look.mjs) - 0.5).
// It writes the best candidate to data/params.json and the centre of the search (often the
// better pick: the best single candidate was partly lucky) to data/params-cem-mean.json.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { DEFAULT_PARAMS } from './brain.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

// What training may change, and over what range ("log" = searched on a log scale).
export const SPACE = {
  horizon: [24, 64, 'int'],
  wHuman: [0, 3],               // weight of your learned speed model
  rolloutBase: [0, 1],          // > 0.5: judge moves by playing on with the split-run routine
  basePeriod: [4, 25, 'int'],
  aimHold: [2, 40, 'int'],
  near: [400, 4000],
  wSlot: [1, 200, 'log'],
  wSpeed: [0, 100],
  wLat: [0.01, 1, 'log'],
  wSep: [0.005, 0.5, 'log'],
  sepFree: [300, 4000],
  wEdible: [10, 3000, 'log'],
  wBoost: [0.05, 3, 'log'],
  wBal: [10, 3000, 'log'],
  minShare: [0.02, 0.3],
  wStarve: [1, 300, 'log'],
  wKey: [0, 20],
};
// For the 'imitate' planner.
export const SPACE_IMITATE = {
  keyGap: [1, 4, 'int'],        // fastest key rhythm (ticks)
  keyBias: [-2, 1.5],           // how readily your habits press keys in the futures
  temp: [0.7, 1.5],
  wSplit: [0, 120],
  wLook: [0, 150],
  wStuck: [0, 120],
  wSelf: [0, 1],
  wHuman: [0, 3],
  wSlot: [1, 200, 'log'],
  wSpeed: [0, 100],
  wLat: [0.01, 1, 'log'],
  wSep: [0.005, 0.5, 'log'],
  sepFree: [300, 4000],
  wEdible: [10, 3000, 'log'],
  wBoost: [0.05, 3, 'log'],
  wBal: [10, 3000, 'log'],
  minShare: [0.02, 0.3],
  wStarve: [1, 300, 'log'],
};
export const LOSS = 150, SPLIT = 40, LOOK = 100, YOUR_SPLITS = 1.37;
let SPACE_USED = SPACE;
let KEYS = Object.keys(SPACE);
const toUnit = (k, v) => { const [a, b, t] = SPACE_USED[k]; return t === 'log' ? Math.log(v / a) / Math.log(b / a) : (v - a) / (b - a); };
const fromUnit = (k, u) => {
  const [a, b, t] = SPACE_USED[k]; u = Math.min(1, Math.max(0, u));
  const v = t === 'log' ? a * Math.pow(b / a, u) : a + u * (b - a);
  return t === 'int' ? Math.round(v) : v;
};
const decode = (vec) => {
  const p = Object.fromEntries(KEYS.map((k, i) => [k, fromUnit(k, vec[i])]));
  if (SPACE_USED === SPACE) p.rollout = p.rolloutBase > 0.5 ? 'base' : 'noop';
  return p;
};
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// Games each candidate plays: the course straight on from your heading at 48.2 s (east),
// and 30 degrees either side, so the weights do not overfit one exact trajectory.
let GOALS = [0, 0.52, -0.52];
// 'imitate': six headings, so a unit lost or a collapse on any course shows up
const GOALS_IMITATE = [0, 30, -30, 90, -90, 180].map((d) => (d * Math.PI) / 180);

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainThread && isCli) {
  const args = process.argv.slice(2);
  const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : def; };
  const generations = Number(args.find((a) => /^\d+$/.test(a)) ?? 30);
  const seconds = opt('--seconds', 75), warmup = opt('--warmup', 25), pop = opt('--pop', 12), elite = Math.max(2, Math.round(pop / 4));
  const paramsFile = here('./data/params.json'), logFile = here('./data/train-log.jsonl');

  let start = { ...DEFAULT_PARAMS };
  let best = null;
  if (args.includes('--resume') && existsSync(paramsFile)) { best = JSON.parse(readFileSync(paramsFile, 'utf8')); start = { ...start, ...best.params }; }
  const init = args.indexOf('--init'); if (init >= 0) start = { ...start, ...JSON.parse(readFileSync(args[init + 1], 'utf8')).params };
  const imitate = start.planner === 'imitate';
  if (imitate) { SPACE_USED = SPACE_IMITATE; KEYS = Object.keys(SPACE_IMITATE); GOALS = GOALS_IMITATE; }
  if (!imitate && start.rolloutBase === undefined) start.rolloutBase = start.rollout === 'base' ? 0.75 : 0.25;
  const threads = Math.min(os.cpus().length, pop * GOALS.length);
  let mean = KEYS.map((k) => toUnit(k, start[k] ?? DEFAULT_PARAMS[k]));
  let sigma = KEYS.map(() => opt('--sigma', 0.18));

  // worker pool
  const workers = [], idle = [], queue = [];
  for (let i = 0; i < threads; i++) {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: {} });
    w.on('message', (m) => { w.job.resolve(m); w.job = null; idle.push(w); pump(); });
    w.on('error', (e) => { console.error(e); process.exit(1); });
    workers.push(w); idle.push(w);
  }
  function pump() { while (idle.length && queue.length) { const w = idle.pop(), job = queue.shift(); w.job = job; w.postMessage(job.msg); } }
  const run = (msg) => new Promise((resolve) => { queue.push({ msg, resolve }); pump(); });

  const evaluate = async (params) => {
    const rs = await Promise.all(GOALS.map((goalAngle) => run({ params, goalAngle, seconds, warmup })));
    const speed = rs.reduce((a, r) => a + r.speed, 0) / rs.length;
    const worst = Math.min(...rs.map((r) => r.speed));
    const avg = (f) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
    const lost = avg((r) => r.resets), splits = avg((r) => r.splitsPerSec), look = avg((r) => r.look);
    const fitness = imitate
      ? 0.7 * speed + 0.3 * worst - LOSS * lost + SPLIT * Math.min(1, splits - YOUR_SPLITS) + (Number.isFinite(look) ? LOOK * (look - 0.5) : 0)
      : 0.7 * speed + 0.3 * worst - (rs.some((r) => r.resets) ? 100 : 0);
    return { fitness, speed, worst, lost, splits, look, rs: rs.map((r) => ({ speed: +r.speed.toFixed(1), splits: +r.splitsPerSec.toFixed(2), tabs: +r.tabsPerSec.toFixed(2), lost: r.resets, look: +(r.look ?? NaN).toFixed(2) })) };
  };

  if (!best) {
    const e = await evaluate(start);
    best = { fitness: e.fitness, speed: e.speed, params: start, games: e.rs };
    console.log(`start weights: fitness ${e.fitness.toFixed(1)}  speed ${e.speed.toFixed(1)} u/s  (${e.rs.map((r) => r.speed).join(' / ')})  lost ${e.lost.toFixed(2)}/game  splits ${e.splits.toFixed(2)}/s  looks yours ${e.look?.toFixed(2)}`);
  }
  for (let gen = 1; gen <= generations; gen++) {
    const t0 = performance.now();
    const samples = [];
    for (let i = 0; i < pop; i++) {
      const vec = i === 0 ? mean.slice() : mean.map((m, j) => Math.min(1, Math.max(0, m + sigma[j] * gauss())));
      samples.push({ vec, params: { ...(imitate ? start : DEFAULT_PARAMS), ...decode(vec) } });
    }
    const results = await Promise.all(samples.map((s) => evaluate(s.params)));
    samples.forEach((s, i) => Object.assign(s, results[i]));
    samples.sort((a, b) => b.fitness - a.fitness);
    const top = samples.slice(0, elite);
    mean = KEYS.map((_, j) => top.reduce((a, s) => a + s.vec[j], 0) / elite);
    sigma = KEYS.map((_, j) => { const sd = Math.sqrt(top.reduce((a, s) => a + (s.vec[j] - mean[j]) ** 2, 0) / elite); return Math.max(0.04, 0.6 * sigma[j] + 0.4 * sd); });
    if (samples[0].fitness > best.fitness) best = { fitness: samples[0].fitness, speed: samples[0].speed, params: samples[0].params, games: samples[0].rs };
    writeFileSync(paramsFile, JSON.stringify({ ...best, trainedAt: new Date().toISOString(), seconds, warmup, goals: GOALS, note: `speed = u/s along the course from ${warmup} s to ${seconds} s` }, null, 1));
    appendFileSync(logFile, JSON.stringify({ gen, at: new Date().toISOString(), bestGen: samples[0].fitness, speedGen: samples[0].speed, meanGen: samples.reduce((a, s) => a + s.speed, 0) / pop, best: best.fitness, params: samples[0].params }) + '\n');
    // the centre of the search: less lucky than the single best, often the better pick
    writeFileSync(here('./data/params-cem-mean.json'), JSON.stringify({ gen, params: { ...(imitate ? start : DEFAULT_PARAMS), ...decode(mean) } }, null, 1));
    console.log(`gen ${String(gen).padStart(3)}  best ${samples[0].fitness.toFixed(1)} (speed ${samples[0].speed.toFixed(1)}, worst goal ${samples[0].worst.toFixed(1)}, lost ${samples[0].lost?.toFixed(2)}/game, splits ${samples[0].splits?.toFixed(2)}/s, looks yours ${samples[0].look?.toFixed(2)})  pop mean speed ${(samples.reduce((a, s) => a + s.speed, 0) / pop).toFixed(1)}  all-time ${best.fitness.toFixed(1)}  ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  }
  for (const w of workers) w.terminate();
} else if (!isMainThread) {
  const { play } = await import('./run.mjs');
  const { lookNet, lookLogit, LOOK_INPUTS } = await import('./look.mjs');
  const buf = new Float32Array(LOOK_INPUTS);
  parentPort.on('message', ({ params, goalAngle, seconds, warmup }) => {
    // how often its positions pass for yours (look.mjs), once a second from warmup on
    const net = lookNet(), G = { x: Math.cos(goalAngle), y: Math.sin(goalAngle) }, centres = [];
    let look = 0, n = 0;
    const r = play({ params, goalAngle, seconds, onSecond: (sec, g) => {
      centres.push(g.centre());
      if (net && sec > warmup && sec >= 3) { look += 1 / (1 + Math.exp(-lookLogit(net, g, centres[sec - 3], G, buf))); n++; }
    } });
    const sustained = (r.perSecond[seconds - 1] - r.perSecond[warmup - 1]) / (seconds - warmup);
    parentPort.postMessage({ speed: sustained, firstSpeed: r.perSecond[warmup - 1] / warmup, lateral: r.lateral, splitsPerSec: r.splitsPerSec, tabsPerSec: r.tabsPerSec, resets: r.resets, mass: r.mass, look: n ? look / n : NaN });
  });
}
