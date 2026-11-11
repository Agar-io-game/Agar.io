// Learns, from YOUR recordings, how fast you get on from a given split-run position:
// for every 5th tick (after the 48.2 s opening) it takes the position's features
// (features.mjs) and the distance you covered over the next `ahead` seconds along your
// heading, then fits a ridge regression. The bot uses it as part of its judgement of the
// positions its look-ahead reaches ("from here, you would usually make X u/s").
// Tested on a recording it was not fitted on.
//   node bot/learn-value.mjs [aheadSeconds=2]   -> data/value-model.json
import { readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadRecording } from './recording.mjs';
import { features, FEATURE_NAMES } from './features.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const dir = here('../recordings/');
const ahead = Number(process.argv[2] ?? 2);
const A = Math.round(ahead * 25), BACK = 50;

function samples(file) {
  const r = loadRecording(dir + file), out = [];
  const fr = r.frames, byTick = new Map(fr.map((f) => [f.tick, f]));
  const cen = (f) => { let m = 0, x = 0, y = 0; for (const c of f.cells) { m += c[4]; x += c[2] * c[4]; y += c[3] * c[4]; } return m ? { x: x / m, y: y / m } : null; };
  for (const f of fr) {
    if (f.tick < r.t0 + 1205 || f.tick % 5) continue;
    const fb = byTick.get(f.tick - BACK), fa = byTick.get(f.tick + A);
    if (!fb || !fa) continue;
    const c = cen(f), cb = cen(fb), ca = cen(fa);
    if (!c || !cb || !ca) continue;
    const hx = c.x - cb.x, hy = c.y - cb.y, hl = Math.hypot(hx, hy);
    if (hl < 50) continue; // standing still: no heading
    const h = { x: hx / hl, y: hy / hl };
    const cells = f.cells.map(([, pid, x, y, mass, boost, angle]) => ({ unit: pid & 1, x, y, mass, boost, angle }));
    if (!cells.some((k) => k.unit === 0) || !cells.some((k) => k.unit === 1)) continue;
    out.push({ x: features(cells, h), y: ((ca.x - c.x) * h.x + (ca.y - c.y) * h.y) / ahead });
  }
  return out;
}

// ridge regression: (X'X + lambda I) w = X'y
function fit(data, lambda = 1) {
  const d = data[0].x.length, XtX = Array.from({ length: d }, () => new Float64Array(d)), Xty = new Float64Array(d);
  for (const { x, y } of data) for (let i = 0; i < d; i++) { Xty[i] += x[i] * y; for (let j = 0; j < d; j++) XtX[i][j] += x[i] * x[j]; }
  for (let i = 1; i < d; i++) XtX[i][i] += lambda * data.length / 1000;
  // Gaussian elimination
  const A = XtX.map((row, i) => [...row, Xty[i]]);
  for (let i = 0; i < d; i++) {
    let p = i; for (let k = i + 1; k < d; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k;
    [A[i], A[p]] = [A[p], A[i]];
    for (let k = i + 1; k < d; k++) { const f = A[k][i] / A[i][i]; for (let j = i; j <= d; j++) A[k][j] -= f * A[i][j]; }
  }
  const w = new Array(d).fill(0);
  for (let i = d - 1; i >= 0; i--) { let s = A[i][d]; for (let j = i + 1; j < d; j++) s -= A[i][j] * w[j]; w[i] = s / A[i][i]; }
  return w;
}
const predict = (w, x) => x.reduce((s, v, i) => s + v * w[i], 0);
function r2(w, data) {
  const mean = data.reduce((s, d) => s + d.y, 0) / data.length;
  let ss = 0, sr = 0; for (const d of data) { ss += (d.y - mean) ** 2; sr += (d.y - predict(w, d.x)) ** 2; }
  return 1 - sr / ss;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl.gz')).sort();
  const per = Object.fromEntries(files.map((f) => [f, samples(f)]));
  for (const test of files) {
    const train = files.filter((f) => f !== test).flatMap((f) => per[f]);
    const w = fit(train);
    console.log(`held out ${test}: R^2 ${r2(w, per[test]).toFixed(3)} (train ${r2(w, train).toFixed(3)}), ${per[test].length} samples`);
  }
  const all = files.flatMap((f) => per[f]);
  const w = fit(all);
  const mean = all.reduce((s, d) => s + d.y, 0) / all.length;
  console.log(`all: ${all.length} samples, mean ${mean.toFixed(0)} u/s, R^2 ${r2(w, all).toFixed(3)}`);
  // effect of one standard deviation of each feature
  for (let i = 1; i < w.length; i++) {
    const m = all.reduce((s, d) => s + d.x[i], 0) / all.length;
    const sd = Math.sqrt(all.reduce((s, d) => s + (d.x[i] - m) ** 2, 0) / all.length);
    console.log(`  ${FEATURE_NAMES[i].padEnd(20)} w=${w[i].toFixed(1).padStart(8)}  mean ${m.toFixed(3)}  1 sd -> ${(w[i] * sd).toFixed(1).padStart(6)} u/s`);
  }
  writeFileSync(here('./data/value-model.json'), JSON.stringify({ ahead, names: FEATURE_NAMES, w, meanSpeed: mean, samples: all.length }, null, 1));
}
