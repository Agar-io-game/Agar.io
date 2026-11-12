// Learns, from the bot's own games, how good a position is: a small network that predicts how
// far the mass centre will get along the course in the next 10 s. The planner only looks 2 s
// ahead, too short to see a unit slowly starving (about 1 game in 5 used to end that way:
// one unit stuck at 16 cells, the other drained); this adds the longer view to its score.
//   node bot/value-selfplay.mjs [games=96] [seconds=75] [--epochs 30] [--add] [--loss-pen 5] [--loss-ahead 20] [--params file] [--out file]
// A unit lost (the game goes back to the start position) within --loss-ahead seconds of a
// position takes --loss-pen thousand units off that position's value: drains that end in a
// lost unit take 10-20 s, longer than the planner's look-ahead.
// Plays `games` games from the start state with the current bot (data/params.json) on all
// CPU threads, then trains data/selfplay-value.json. With --add the new games are added to
// the ones kept from the previous run (data/selfplay-states.bin), for a second round played
// with the value network switched on.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { INPUTS, MLP } from './policy.mjs';
import { AHEAD, SCALE, VALUE_SIZES, valueInput } from './value-net.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const EVERY = 5;                // ticks between samples

function trainRegression(X, Y, { epochs = 30, lr = 1e-3, batch = 256 } = {}) {
  const N = X.length, nTest = Math.floor(N * 0.1);
  // hold out whole games' worth of samples at the end (samples are in game order)
  const idx = Array.from({ length: N - nTest }, (_, i) => i);
  const net = new MLP(VALUE_SIZES);
  const P = net.layers.flatMap((L) => [L.W, L.b]);
  const m1 = P.map((p) => new Float32Array(p.length)), m2 = P.map((p) => new Float32Array(p.length)), G = P.map((p) => new Float32Array(p.length));
  const acts = VALUE_SIZES.map((n) => new Float32Array(n)), deltas = VALUE_SIZES.map((n) => new Float32Array(n));
  let step = 0;
  const evalSet = (from, to) => {
    let se = 0, mean = 0; for (let k = from; k < to; k++) mean += Y[k] / (to - from);
    let vr = 0; for (let k = from; k < to; k++) { const e = net.forward(X[k])[0] - Y[k]; se += e * e; vr += (Y[k] - mean) ** 2; }
    return 1 - se / vr;
  };
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    let loss = 0;
    for (let b0 = 0; b0 < idx.length; b0 += batch) {
      for (const g of G) g.fill(0);
      const bn = Math.min(batch, idx.length - b0);
      for (let s = b0; s < b0 + bn; s++) {
        const k = idx[s];
        acts[0] = X[k];
        for (let l = 0; l < net.layers.length; l++) {
          const { n, m, W, b } = net.layers[l], a = acts[l], z = acts[l + 1];
          for (let j = 0; j < m; j++) { let v = b[j]; const off = j * n; for (let i = 0; i < n; i++) v += W[off + i] * a[i]; z[j] = l + 1 < net.layers.length ? Math.tanh(v) : v; }
        }
        const e = acts[acts.length - 1][0] - Y[k];
        deltas[deltas.length - 1][0] = e; loss += 0.5 * e * e;
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
        for (let i = 0; i < W.length; i++) { const gi = g[i] / bn; a[i] = b1 * a[i] + (1 - b1) * gi; v[i] = b2 * v[i] + (1 - b2) * gi * gi; W[i] -= lr * (a[i] / c1) / (Math.sqrt(v[i] / c2) + 1e-8); }
      }
    }
    if (ep % 5 === 4 || ep === epochs - 1) console.log(`epoch ${ep + 1}: train loss ${(loss / idx.length).toFixed(4)}  held-out R^2 ${evalSet(N - nTest, N).toFixed(3)}`);
  }
  return net;
}

if (!isMainThread) {
  // one self-play game -> samples (input, progress over the next AHEAD s)
  const { Game } = await import('./sim.mjs');
  const { Brain } = await import('./brain.mjs');
  const { loadStarts } = await import('./run.mjs');
  const { params, deg, seconds, lossPen, lossAhead, first = 0 } = workerData;
  const ga = (deg * Math.PI) / 180, H = { x: Math.cos(ga), y: Math.sin(ga) };
  const starts = loadStarts(); let pos = first % starts.length;
  const g = new Game(starts[pos]), b = new Brain(params, ga);
  const along = () => { const c = g.centre(); return c.x * H.x + c.y * H.y; };
  const xs = [], at = [], losses = [];
  const ticks = seconds * 25;
  for (let t = 0; t < ticks; t++) {
    if (t % EVERY === 0) { xs.push(valueInput(g, H)); at.push(along()); }
    b.act(g, t); g.step();
    if (!g.cells(0).length || !g.cells(1).length) { losses.push(t); pos = (pos + 1) % starts.length; g.reset(starts[pos], ga); b.restart(); } // as in every game: back to the start position
  }
  at.push(along());
  const k = (AHEAD * 25) / EVERY, n = xs.length - k;
  const X = new Float32Array(Math.max(0, n) * INPUTS), Y = new Float32Array(Math.max(0, n));
  for (let i = 0; i < n; i++) {
    X.set(xs[i], i * INPUTS);
    const t = i * EVERY, doomed = losses.some((L) => L >= t && L < t + lossAhead * 25);
    Y[i] = (at[i + k] - at[i]) / SCALE - (doomed ? lossPen : 0);
  }
  const lost = losses.length;
  parentPort.postMessage({ X, Y, lost }, [X.buffer, Y.buffer]);
} else if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : def; };
  const nums = args.filter((a, i) => /^\d+$/.test(a) && !String(args[i - 1]).startsWith('--'));
  const games = Number(nums[0] ?? 96), seconds = Number(nums[1] ?? 75), epochs = opt('--epochs', 30);
  const lossPen = opt('--loss-pen', 5), lossAhead = opt('--loss-ahead', 20);
  const outFile = args.includes('--out') ? args[args.indexOf('--out') + 1] : here('./data/selfplay-value.json');
  const { loadParams } = await import('./run.mjs');
  const params = loadParams(args.includes('--params') ? args[args.indexOf('--params') + 1] : undefined);
  const heads = [0, 15, -15, 45, -45, 90, -90, 180];
  const jobs = Array.from({ length: games }, (_, i) => ({ deg: heads[i % heads.length] + (Math.random() - 0.5) * 10, first: i % 5 }));
  const parts = []; let lost = 0, done = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: Math.max(1, availableParallelism() - 1) }, async () => {
    while (jobs.length) {
      const { deg, first } = jobs.shift();
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: { params, deg, first, seconds, lossPen, lossAhead } });
      const r = await new Promise((res, rej) => { w.once('message', res); w.once('error', rej); });
      parts.push(r); lost += r.lost;
      if (++done % 16 === 0) console.log(`${done}/${games} games (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
    }
  }));
  // store / extend the sample file: [n][inputs*n floats][n floats]
  const file = here('./data/selfplay-states.bin');
  let X = [], Y = [];
  if (args.includes('--add') && existsSync(file)) {
    const buf = readFileSync(file), n = buf.readUInt32LE(0);
    const f = new Float32Array(buf.buffer.slice(buf.byteOffset + 4, buf.byteOffset + 4 + n * (INPUTS + 1) * 4));
    for (let i = 0; i < n; i++) { X.push(f.subarray(i * INPUTS, (i + 1) * INPUTS)); Y.push(f[n * INPUTS + i]); }
    console.log(`kept ${n} samples from the previous run`);
  }
  for (const r of parts) for (let i = 0; i < r.Y.length; i++) { X.push(r.X.subarray(i * INPUTS, (i + 1) * INPUTS)); Y.push(r.Y[i]); }
  const out = new Float32Array(Y.length * (INPUTS + 1));
  X.forEach((x, i) => out.set(x, i * INPUTS)); out.set(Y, Y.length * INPUTS);
  const head = Buffer.alloc(4); head.writeUInt32LE(Y.length);
  writeFileSync(file, Buffer.concat([head, Buffer.from(out.buffer)]));
  const meanY = Y.reduce((a, y) => a + y, 0) / Y.length;
  console.log(`${games} games, ${lost} units lost; ${Y.length} samples, mean progress ${(meanY * SCALE / AHEAD).toFixed(0)} u/s over the next ${AHEAD} s`);
  // the held-out tail (last 10 % of samples) is the last games played
  const net = trainRegression(X, Y, { epochs });
  writeFileSync(outFile, JSON.stringify({ trainedAt: new Date().toISOString(), samples: Y.length, ahead: AHEAD, lossPen, lossAhead, ...net.save() }));
  console.log(`saved ${outFile}`);
}
