// Trains the imitation policy (policy.mjs) on your recordings: for every tick after the
// 48.2 s opening, the position as you saw it, and what you did that tick (key, cursor).
// Ticks while you held feed (W/E) are left out: the bot may not feed.
//   node bot/imitate.mjs [epochs=8]   -> data/policy.json
// It first trains on three recordings and reports how well it predicts the fourth, then
// trains the final network on all four.
import { readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadRecording } from './recording.mjs';
import { encode, encodeAim, MLP, KEYS, INPUTS, MIX, OUT_MIX, mixLogit, mixMean, mixLogSd, LOGSD_MIN, LOGSD_MAX } from './policy.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const dir = here('../recordings/');
const SIZES = [INPUTS, 128, 64, OUT_MIX];

export function dataset(file) {
  const r = loadRecording(dir + file);
  const byTick = new Map(r.frames.map((f) => [f.tick, f]));
  const evAt = new Map(); for (const e of r.events) (evAt.get(e.tick) ?? evAt.set(e.tick, []).get(e.tick)).push(e);
  const cen = (f) => { let m = 0, x = 0, y = 0; for (const c of f.cells) { m += c[4]; x += c[2] * c[4]; y += c[3] * c[4]; } return m ? { x: x / m, y: y / m } : null; };
  const X = [], Y = [], A = [];
  let active = 0; const aims = [null, null]; let sinceKey = 99, sinceTab = 99, lastKey = null, feeding = false, heading = { x: 1, y: 0 };
  const t1 = r.t0 + 1205;
  for (let t = r.t0; t <= r.frames.at(-1).tick; t++) {
    const evs = evAt.get(t) ?? [];
    const f = byTick.get(t), fb = byTick.get(t - 50);
    let sample = null;
    if (t >= t1 && f && fb && !feeding && aims[0] && aims[1]) {
      const c = cen(f), cb = cen(fb);
      if (c && cb) {
        const hx = c.x - cb.x, hy = c.y - cb.y, hl = Math.hypot(hx, hy);
        if (hl > 50) heading = { x: hx / hl, y: hy / hl };
        const cells = f.cells.map(([, pid, x, y, mass, boost, angle]) => ({ unit: pid & 1, x, y, mass, boost, angle }));
        if (cells.some((k) => k.unit === active) && cells.some((k) => k.unit !== active)) {
          let m = 0, ux = 0, uy = 0; for (const k of cells) if (k.unit === active) { m += k.mass; ux += k.x * k.mass; uy += k.y * k.mass; }
          sample = { x: encode(cells, active, heading, { aim: aims[active ^ 1], sinceKey, sinceTab, lastKey }, new Float32Array(INPUTS)), centre: { x: ux / m, y: uy / m }, heading: { ...heading } };
        }
      }
    }
    // what you did this tick
    let key = 'none';
    sinceKey++; sinceTab++;
    for (const e of evs) {
      if (e.ev === 'aim') { active = e.pid & 1; aims[active] = { x: e.x, y: e.y }; }
      else if (e.ev === 'tab') { if (key === 'none') key = 'tab'; active = (e.pid & 1) ^ 1; sinceKey = 0; sinceTab = 0; lastKey = 'tab'; }
      else if (e.ev === 'split') { if (key === 'none') key = e.n >= 3 ? 'split4' : 'split1'; sinceKey = 0; lastKey = 'split'; }
      else if (e.ev === 'feedHold') feeding = !!e.on;
      else if (e.ev === 'autoSwitch') active = (e.pid & 1) ^ 1;
    }
    if (sample && aims[active]) {
      X.push(sample.x); Y.push(KEYS.indexOf(key)); A.push(encodeAim(aims[active], sample.centre, sample.heading));
    }
  }
  return { X, Y, A };
}

// log(pi_j) + log N_j(a) for every cursor choice j, with key `key`; .pi holds the weights
const clampSd = (s) => Math.max(LOGSD_MIN, Math.min(LOGSD_MAX, s));
const lse = (v) => { let m = -Infinity; for (const x of v) m = Math.max(m, x); let s = 0; for (const x of v) s += Math.exp(x - m); return m + Math.log(s); };
function mixLogLik(out, key, a) {
  const z = []; for (let j = 0; j < MIX; j++) z.push(out[mixLogit(key, j)]);
  const lz = lse(z), lp = [], pi = [];
  for (let j = 0; j < MIX; j++) {
    pi.push(Math.exp(z[j] - lz));
    let l = z[j] - lz;
    for (let i = 0; i < 2; i++) { const s = clampSd(out[mixLogSd(j) + i]), e = (a[i] - out[mixMean(j) + i]) / Math.exp(s); l += -0.5 * e * e - s - 0.9189; }
    lp.push(l);
  }
  lp.pi = pi;
  return lp;
}

function train(data, { epochs = 8, lr = 1e-3, batch = 256, aimWeight = 0.5, valid = null } = {}) {
  const net = new MLP(SIZES);
  // start the cursor choices apart: far ahead, ahead-left, ahead-right, near, behind
  const last = net.layers.at(-1), init = [[0.76, 0], [0.6, 0.6], [0.6, -0.6], [0.15, 0], [-0.4, 0]];
  for (let j = 0; j < MIX; j++) for (let i = 0; i < 2; i++) { last.b[mixMean(j) + i] = init[j][i]; last.b[mixLogSd(j) + i] = -1.5; }
  const N = data.X.length;
  const freq = [0, 0, 0, 0]; for (const y of data.Y) freq[y]++;
  const cw = freq.map((f) => Math.pow(N / 4 / Math.max(1, f), 0.5));
  // Adam state
  const P = net.layers.flatMap((L) => [L.W, L.b]);
  const m1 = P.map((p) => new Float32Array(p.length)), m2 = P.map((p) => new Float32Array(p.length)), G = P.map((p) => new Float32Array(p.length));
  let step = 0;
  const idx = Array.from({ length: N }, (_, i) => i);
  const acts = SIZES.map((n) => new Float32Array(n)), deltas = SIZES.map((n) => new Float32Array(n));
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = N - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    let loss = 0;
    for (let b0 = 0; b0 < N; b0 += batch) {
      for (const g of G) g.fill(0);
      const bn = Math.min(batch, N - b0);
      for (let s = b0; s < b0 + bn; s++) {
        const k = idx[s], x = data.X[k];
        // forward with stored activations
        acts[0] = x;
        for (let l = 0; l < net.layers.length; l++) {
          const { n, m, W, b } = net.layers[l], a = acts[l], z = acts[l + 1];
          for (let j = 0; j < m; j++) { let v = b[j]; const off = j * n; for (let i = 0; i < n; i++) v += W[off + i] * a[i]; z[j] = l + 1 < net.layers.length ? Math.tanh(v) : v; }
        }
        const out = acts[acts.length - 1], d = deltas[deltas.length - 1];
        // key: weighted softmax cross-entropy
        let mx = -Infinity; for (let i = 0; i < 4; i++) mx = Math.max(mx, out[i]);
        let se = 0; const pr = [0, 0, 0, 0]; for (let i = 0; i < 4; i++) { pr[i] = Math.exp(out[i] - mx); se += pr[i]; }
        const y = data.Y[k], w = cw[y];
        for (let i = 0; i < 4; i++) { pr[i] /= se; d[i] = w * (pr[i] - (i === y ? 1 : 0)); }
        loss += -w * Math.log(pr[y] + 1e-9);
        // cursor: negative log-likelihood of your cursor under the mixture of choices for
        // the key you pressed (gradients: logits pi - resp, means and log-spreads resp-weighted)
        const ta = data.A[k];
        d.fill(0, 4);
        const lp = mixLogLik(out, y, ta), logp = lse(lp);
        loss += -aimWeight * logp;
        for (let j = 0; j < MIX; j++) {
          const r = Math.exp(lp[j] - logp);
          d[mixLogit(y, j)] = aimWeight * (lp.pi[j] - r);
          for (let i = 0; i < 2; i++) {
            const raw = out[mixLogSd(j) + i], sd = Math.exp(clampSd(raw)), e = (ta[i] - out[mixMean(j) + i]) / sd;
            d[mixMean(j) + i] = aimWeight * r * (-e / sd);
            d[mixLogSd(j) + i] = raw > LOGSD_MIN && raw < LOGSD_MAX ? aimWeight * r * (1 - e * e) : 0;
          }
        }
        // backward
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
    const msg = [`epoch ${ep + 1}: train loss ${(loss / N).toFixed(3)}`];
    if (valid) msg.push(report(net, valid));
    console.log(msg.join('  |  '));
  }
  return net;
}

export function report(net, data) {
  let correct = 0, keyTrue = 0, keyHit = 0, keyPred = 0, se = 0, vr = 0, nll = 0;
  const conf = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  const meanA = [0, 0]; for (const a of data.A) { meanA[0] += a[0] / data.A.length; meanA[1] += a[1] / data.A.length; }
  for (let k = 0; k < data.X.length; k++) {
    const out = net.forward(data.X[k]);
    let best = 0; for (let i = 1; i < 4; i++) if (out[i] > out[best]) best = i;
    const y = data.Y[k]; conf[y][best]++;
    if (best === y) correct++;
    if (y) keyTrue++; if (best) keyPred++; if (y && best === y) keyHit++;
    // cursor: the mixture's mean for the key pressed (comparable with the old single cursor),
    // and the log-likelihood of your cursor
    const lp = mixLogLik(out, y, data.A[k]); nll -= lse(lp);
    for (let i = 0; i < 2; i++) { let m = 0; for (let j = 0; j < MIX; j++) m += lp.pi[j] * out[mixMean(j) + i]; se += (m - data.A[k][i]) ** 2; vr += (data.A[k][i] - meanA[i]) ** 2; }
  }
  return `held-out: key precision ${(100 * keyHit / Math.max(1, keyPred)).toFixed(0)}% recall ${(100 * keyHit / Math.max(1, keyTrue)).toFixed(0)}%, cursor R^2 (mixture mean) ${(1 - se / vr).toFixed(2)}, cursor log-likelihood ${(-nll / data.X.length).toFixed(2)}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const epochs = Number(process.argv[2] ?? 8);
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl.gz')).sort();
  const sets = files.map((f) => { const d = dataset(f); console.log(`${f}: ${d.X.length} samples, keys ${KEYS.map((k, i) => `${k} ${d.Y.filter((y) => y === i).length}`).join(', ')}`); return d; });
  const merge = (list) => ({ X: list.flatMap((d) => d.X), Y: list.flatMap((d) => d.Y), A: list.flatMap((d) => d.A) });
  if (!process.argv.includes('--final-only')) {
    console.log(`\nvalidation: train on ${files.slice(0, 3).join(', ')}, test on ${files[3]}`);
    train(merge(sets.slice(0, 3)), { epochs, valid: sets[3] });
  }
  console.log('\nfinal: all four recordings');
  const net = train(merge(sets), { epochs });
  writeFileSync(here('./data/policy.json'), JSON.stringify({ trainedAt: new Date().toISOString(), samples: sets.reduce((a, d) => a + d.X.length, 0), ...net.save() }));
  console.log('saved bot/data/policy.json');
}
