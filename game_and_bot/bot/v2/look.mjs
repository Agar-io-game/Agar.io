// "Looks like yours": a small network that tells your split-run shapes from the bot's. It
// sees one moment: both units' cells around the mass centre, in the frame of where the run
// went over the last 2 s, scaled to 35,000 mass (front unit first, cells biggest first, so
// the small cells and where they sit are in plain view). Trained on your four recordings
// against the bot's own games, it answers how likely a shape is yours. The planner adds
// wLook x its log-odds to each future's score (brain.mjs), so of the futures your habits
// play out, it prefers those that leave your kind of shape: small cells tidy, not strewn.
//   node bot/look.mjs [games=48] [seconds=75]   play the bot's games, then train
//   node bot/look.mjs --from <dir>               train on bot recordings (.jsonl.gz) in <dir>
//   --test   only report how well your shapes and the bot's can be told apart (saves nothing)
// Writes data/look.json.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { MLP } from './policy.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export const LOOK_TOP = 16;                     // cells per unit
export const LOOK_INPUTS = 2 * LOOK_TOP * 5 + 4;
export const LOOK_SIZES = [LOOK_INPUTS, 64, 32, 1];
const EVERY = 5;                                // ticks between samples
const SKIP = 1205;                              // your recordings: from 48.2 s on

// cells: [{ unit, x, y, mass, boost, angle }]; H: unit vector of the run's direction.
export function lookInput(cells, H, out = new Float32Array(LOOK_INPUTS)) {
  out.fill(0);
  let M = 0, cx = 0, cy = 0;
  const U = [[], []], um = [0, 0], ux = [0, 0], uy = [0, 0];
  for (const c of cells) {
    M += c.mass; cx += c.x * c.mass; cy += c.y * c.mass;
    U[c.unit].push(c); um[c.unit] += c.mass; ux[c.unit] += c.x * c.mass; uy[c.unit] += c.y * c.mass;
  }
  if (!M || !U[0].length || !U[1].length) return out;
  cx /= M; cy /= M;
  const k = Math.sqrt(35000 / M) / 1000;
  const al = (x, y) => ((x - cx) * H.x + (y - cy) * H.y) * k, la = (x, y) => ((x - cx) * -H.y + (y - cy) * H.x) * k;
  const front = al(ux[0] / um[0], uy[0] / um[0]) >= al(ux[1] / um[1], uy[1] / um[1]) ? 0 : 1;
  [front, front ^ 1].forEach((u, r) => {
    const list = U[u].slice().sort((a, b) => b.mass - a.mass);
    for (let i = 0; i < Math.min(LOOK_TOP, list.length); i++) {
      const c = list[i], o = (r * LOOK_TOP + i) * 5;
      out[o] = 1; out[o + 1] = al(c.x, c.y); out[o + 2] = la(c.x, c.y); out[o + 3] = Math.sqrt(c.mass / M) * 4;
      out[o + 4] = c.boost > 0 ? (Math.min(200, c.boost) / 200) * (Math.cos(c.angle) * H.x + Math.sin(c.angle) * H.y) : 0;
    }
  });
  const g = 2 * LOOK_TOP * 5;
  out[g] = U[front].length / 16; out[g + 1] = U[front ^ 1].length / 16; out[g + 2] = um[front] / M; out[g + 3] = 1;
  return out;
}
const mirror = (x) => { const y = Float32Array.from(x); for (let i = 0; i < 2 * LOOK_TOP; i++) y[i * 5 + 2] = -y[i * 5 + 2]; return y; };

// For the planner: the shape of a Game, the run's direction taken from `from` (the mass centre
// 2 s earlier) or, if it barely moved, the course G. Returns the log-odds that it is yours.
let NET;
export function lookNet() {
  if (NET === undefined) { const f = here('./data/look.json'); NET = existsSync(f) ? new MLP(LOOK_SIZES, JSON.parse(readFileSync(f, 'utf8'))) : null; }
  return NET;
}
export function lookLogit(net, g, from, G, buf) {
  const c = g.centre(); if (!c) return -10;
  const dx = c.x - from.x, dy = c.y - from.y, d = Math.hypot(dx, dy);
  const H = d > 50 ? { x: dx / d, y: dy / d } : G;
  const cells = [];
  for (let u = 0; u < 2; u++) for (const k of g.cells(u)) cells.push({ unit: u, x: k.x, y: k.y, mass: k.mass, boost: k.boost, angle: k.angle });
  return net.forward(lookInput(cells, H, buf))[0];
}

// Samples (every EVERY ticks) of a recording: frames -> inputs, run direction from 50 ticks before.
export function recordingSamples(rec, skip = 0) {
  const byTick = new Map(rec.frames.map((f) => [f.tick, f.cells.map(([id, pid, x, y, mass, boost, angle]) => ({ id, unit: pid & 1, x, y, mass, boost, angle }))]));
  const bad = new Set(); let on = null; // ticks around W held (feeding) are left out
  for (const e of rec.events) if (e.ev === 'feedHold') { if (e.on) on = e.tick; else if (on != null) { for (let t = on - 25; t <= e.tick + 75; t++) bad.add(t); on = null; } }
  const cen = (cs) => { let m = 0, x = 0, y = 0; for (const c of cs) { m += c.mass; x += c.x * c.mass; y += c.y * c.mass; } return m ? { x: x / m, y: y / m } : null; };
  const out = [], t0 = rec.frames[0].tick + skip;
  for (const [T, cells] of byTick) {
    if (T < t0 || T % EVERY || bad.has(T)) continue;
    const back = byTick.get(T - 50); if (!back) continue;
    const a = cen(back), b = cen(cells); if (!a || !b) continue;
    const d = Math.hypot(b.x - a.x, b.y - a.y); if (d < 50) continue;
    if (!cells.some((c) => c.unit === 0) || !cells.some((c) => c.unit === 1)) continue;
    out.push(lookInput(cells, { x: (b.x - a.x) / d, y: (b.y - a.y) / d }));
  }
  return out;
}

export function trainClassifier(Xh, Xb, { epochs = 12, lr = 1e-3, batch = 256, sizes = LOOK_SIZES, flip = mirror, quiet = false } = {}) {
  const X = [...Xh, ...Xb], Y = [...Xh.map(() => 1), ...Xb.map(() => 0)];
  const wPos = X.length / (2 * Xh.length), wNeg = X.length / (2 * Xb.length); // balanced classes
  const net = new MLP(sizes);
  const P = net.layers.flatMap((L) => [L.W, L.b]);
  const m1 = P.map((p) => new Float32Array(p.length)), m2 = P.map((p) => new Float32Array(p.length)), G = P.map((p) => new Float32Array(p.length));
  const acts = sizes.map((n) => new Float32Array(n)), deltas = sizes.map((n) => new Float32Array(n));
  const idx = X.map((_, i) => i);
  let step = 0;
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    let loss = 0;
    for (let b0 = 0; b0 < idx.length; b0 += batch) {
      for (const g of G) g.fill(0);
      const bn = Math.min(batch, idx.length - b0);
      for (let s = b0; s < b0 + bn; s++) {
        const k = idx[s], x = Math.random() < 0.5 ? X[k] : flip(X[k]); // left and right alike
        acts[0] = x;
        for (let l = 0; l < net.layers.length; l++) {
          const { n, m, W, b } = net.layers[l], a = acts[l], z = acts[l + 1];
          for (let j = 0; j < m; j++) { let v = b[j]; const off = j * n; for (let i = 0; i < n; i++) v += W[off + i] * a[i]; z[j] = l + 1 < net.layers.length ? Math.tanh(v) : v; }
        }
        const z = acts.at(-1)[0], p = 1 / (1 + Math.exp(-z)), w = Y[k] ? wPos : wNeg;
        deltas.at(-1)[0] = w * (p - Y[k]); loss -= w * Math.log(Y[k] ? p + 1e-9 : 1 - p + 1e-9);
        for (let l = net.layers.length - 1; l >= 0; l--) {
          const { n, m, W } = net.layers[l], a = acts[l], dl = deltas[l + 1], gW = G[2 * l], gb = G[2 * l + 1];
          const dprev = deltas[l]; if (l > 0) dprev.fill(0);
          for (let j = 0; j < m; j++) {
            const dj = dl[j]; if (dj === 0) continue; gb[j] += dj; const off = j * n;
            for (let i = 0; i < n; i++) { gW[off + i] += dj * a[i]; if (l > 0) dprev[i] += dj * W[off + i]; }
          }
          if (l > 0) for (let i = 0; i < n; i++) dprev[i] *= 1 - a[i] * a[i];
        }
      }
      step++;
      const b1 = 0.9, b2 = 0.999, c1 = 1 - Math.pow(b1, step), c2 = 1 - Math.pow(b2, step);
      for (let p = 0; p < P.length; p++) {
        const W = P[p], g = G[p], a = m1[p], v = m2[p];
        for (let i = 0; i < W.length; i++) { const gi = g[i] / bn + 1e-5 * W[i]; a[i] = b1 * a[i] + (1 - b1) * gi; v[i] = b2 * v[i] + (1 - b2) * gi * gi; W[i] -= lr * (a[i] / c1) / (Math.sqrt(v[i] / c2) + 1e-8); }
      }
    }
    if (!quiet) console.log(`epoch ${ep + 1}: loss ${(loss / idx.length).toFixed(3)}`);
  }
  return net;
}

// How well a network tells the two apart: accuracy at 0.5 and the share of (yours, bot) pairs
// it ranks the right way round (AUC; 0.5 = can't tell them apart).
export function separation(net, Xh, Xb) {
  const sh = Xh.map((x) => net.forward(x)[0]), sb = Xb.map((x) => net.forward(x)[0]);
  const acc = (sh.filter((z) => z > 0).length + sb.filter((z) => z <= 0).length) / (sh.length + sb.length);
  const all = [...sh.map((z) => [z, 1]), ...sb.map((z) => [z, 0])].sort((a, b) => a[0] - b[0]);
  let rank = 0, sum = 0; all.forEach(([, y], i) => { if (y) { sum += i - rank; rank++; } });
  return { acc, auc: sum / (sh.length * sb.length), meanP: { yours: sh.reduce((a, z) => a + 1 / (1 + Math.exp(-z)), 0) / sh.length, bot: sb.reduce((a, z) => a + 1 / (1 + Math.exp(-z)), 0) / sb.length } };
}

if (!isMainThread && workerData?.lookWorker) {
  // one bot game -> samples
  const { play } = await import('./run.mjs');
  const { params, deg, seconds } = workerData;
  const r = play({ params, goalAngle: (deg * Math.PI) / 180, seconds, record: true });
  const X = recordingSamples({ frames: r.frames, events: [] });
  parentPort.postMessage(X);
} else if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { loadRecording } = await import('./recording.mjs');
  const args = process.argv.slice(2);
  const from = args.includes('--from') ? args[args.indexOf('--from') + 1] : null;
  const human = readdirSync(here('../../recordings')).filter((f) => f.endsWith('.jsonl.gz')).sort();
  const Hs = human.map((f) => recordingSamples(loadRecording(here('../../recordings/' + f)), SKIP));
  let Bs;
  if (from) Bs = readdirSync(from).filter((f) => f.endsWith('.jsonl.gz')).sort().map((f) => recordingSamples(loadRecording(from + '/' + f)));
  else {
    const nums = args.filter((a) => /^\d+$/.test(a));
    const games = Number(nums[0] ?? 48), seconds = Number(nums[1] ?? 75);
    const { loadParams } = await import('./run.mjs');
    const params = loadParams(), heads = [0, 15, -15, 45, -45, 90, -90, 180];
    const jobs = Array.from({ length: games }, (_, i) => heads[i % 8] + ((i * 37) % 11) - 5);
    Bs = [];
    await Promise.all(Array.from({ length: Math.max(1, availableParallelism() - 1) }, async () => {
      while (jobs.length) {
        const deg = jobs.shift(), w = new Worker(fileURLToPath(import.meta.url), { workerData: { lookWorker: true, params, deg, seconds } });
        Bs.push(await new Promise((res, rej) => { w.once('message', res); w.once('error', rej); }));
      }
    }));
  }
  // held out: your last recording and the last 1/8 of the bot's games
  const nb = Math.max(1, Math.round(Bs.length / 8));
  const Xh = Hs.slice(0, -1).flat(), Xb = Bs.slice(0, -nb).flat(), Th = Hs.at(-1), Tb = Bs.slice(-nb).flat();
  console.log(`yours: ${Xh.length} moments to learn from, ${Th.length} held out; bot: ${Xb.length} / ${Tb.length}`);
  const net = trainClassifier(Xh, Xb);
  const s = separation(net, Th, Tb);
  console.log(`held out: accuracy ${(100 * s.acc).toFixed(1)}%, AUC ${s.auc.toFixed(3)}, mean "yours" probability: yours ${s.meanP.yours.toFixed(2)}, bot ${s.meanP.bot.toFixed(2)}`);
  if (args.includes('--test')) process.exit(0);
  // the saved network learns from everything
  const full = trainClassifier(Hs.flat(), Bs.flat());
  writeFileSync(here('./data/look.json'), JSON.stringify({ trainedAt: new Date().toISOString(), yours: Hs.flat().length, bot: Bs.flat().length, heldOut: { acc: +s.acc.toFixed(3), auc: +s.auc.toFixed(3) }, ...full.save() }));
  console.log('saved bot/data/look.json');
}
