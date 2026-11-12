// A small fully connected network (ReLU hidden layers, one linear output) with its own
// trainer, in plain JavaScript: no dependencies.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export class Net {
  // sizes: [inputs, hidden..., 1]
  constructor(sizes, weights = null) {
    this.sizes = sizes; this.W = []; this.b = []; this.act = [];
    for (let l = 0; l + 1 < sizes.length; l++) {
      const nIn = sizes[l], nOut = sizes[l + 1], W = new Float32Array(nIn * nOut), b = new Float32Array(nOut);
      if (weights) { W.set(weights.W[l]); b.set(weights.b[l]); }
      else { const sd = Math.sqrt(2 / nIn); for (let i = 0; i < W.length; i++) W[i] = gauss() * sd; }
      this.W.push(W); this.b.push(b); this.act.push(new Float32Array(nOut));
    }
    this.scale = weights?.scale ?? 1; this.shift = weights?.shift ?? 0;
  }
  // x: Float32Array(inputs) -> value
  forward(x) {
    let input = x;
    const last = this.W.length - 1;
    for (let l = 0; l <= last; l++) {
      const W = this.W[l], b = this.b[l], out = this.act[l], nIn = this.sizes[l], nOut = this.sizes[l + 1];
      out.set(b);
      // weights are stored input-major, so inputs that are 0 (cells that are not there) cost nothing
      for (let i = 0, w = 0; i < nIn; i++, w += nOut) { const v = input[i]; if (v === 0) continue; for (let j = 0; j < nOut; j++) out[j] += v * W[w + j]; }
      if (l < last) for (let j = 0; j < nOut; j++) if (out[j] < 0) out[j] = 0;
      input = out;
    }
    return input[0] * this.scale + this.shift;
  }
  toJSON() { return { sizes: this.sizes, scale: this.scale, shift: this.shift, W: this.W.map((w) => Array.from(w, (v) => +v.toFixed(5))), b: this.b.map((w) => Array.from(w, (v) => +v.toFixed(5))) }; }
  save(file) { writeFileSync(file, JSON.stringify(this.toJSON())); }
  static load(file) { if (!existsSync(file)) return null; const j = JSON.parse(readFileSync(file, 'utf8')); return new Net(j.sizes, j); }
}

let spare = null;
function gauss() { if (spare != null) { const v = spare; spare = null; return v; } let u, v, s; do { u = Math.random() * 2 - 1; v = Math.random() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0); const m = Math.sqrt(-2 * Math.log(s) / s); spare = v * m; return u * m; }

// Fits net to (X, y) by Adam on squared error. X: Float32Array(n * inputs), y: Float32Array(n).
// Targets are standardised (net.scale / net.shift undo it). Returns the error on positions it
// was not fitted to (whole games held out when `groups` gives each sample its game number),
// and how much of their spread the network explains.
export function fit(net, X, y, { epochs = 12, batch = 256, lr = 1e-3, valShare = 0.05, log = null, groups = null } = {}) {
  const nIn = net.sizes[0], n = y.length, L = net.W.length;
  let mean = 0; for (let i = 0; i < n; i++) mean += y[i]; mean /= n;
  let sd = 0; for (let i = 0; i < n; i++) sd += (y[i] - mean) ** 2; sd = Math.sqrt(sd / n) || 1;
  net.scale = sd; net.shift = mean;
  const isVal = new Uint8Array(n);
  if (groups) { const pick = new Map(); for (let i = 0; i < n; i++) { if (!pick.has(groups[i])) pick.set(groups[i], Math.random() < valShare); isVal[i] = pick.get(groups[i]) ? 1 : 0; } }
  else for (let i = 0; i < n; i++) isVal[i] = Math.random() < valShare ? 1 : 0;
  const train = [], val = []; for (let i = 0; i < n; i++) (isVal[i] ? val : train).push(i);
  const gW = net.W.map((w) => new Float32Array(w.length)), gb = net.b.map((b) => new Float32Array(b.length));
  const mW = net.W.map((w) => new Float32Array(w.length)), vW = net.W.map((w) => new Float32Array(w.length));
  const mb = net.b.map((b) => new Float32Array(b.length)), vb = net.b.map((b) => new Float32Array(b.length));
  const delta = net.sizes.slice(1).map((s) => new Float32Array(s));
  const b1 = 0.9, b2 = 0.999; let step = 0;
  const evalVal = () => {
    let se = 0, vm = 0, vv = 0;
    for (const i of val) { const p = net.forward(X.subarray(i * nIn, (i + 1) * nIn)); se += (p - y[i]) ** 2; vm += y[i]; }
    vm /= val.length || 1; for (const i of val) vv += (y[i] - vm) ** 2;
    return { rmse: Math.sqrt(se / (val.length || 1)), r2: 1 - se / (vv || 1) };
  };
  const upd = (P, G, Mo, Vo, rate, c1, c2, inv) => { for (let i = 0; i < P.length; i++) { const g = G[i] * inv; Mo[i] = b1 * Mo[i] + (1 - b1) * g; Vo[i] = b2 * Vo[i] + (1 - b2) * g * g; P[i] -= rate * (Mo[i] / c1) / (Math.sqrt(Vo[i] / c2) + 1e-8); } };
  let res = null;
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = train.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = train[i]; train[i] = train[j]; train[j] = t; }
    const rate = lr * (ep < epochs * 0.6 ? 1 : ep < epochs * 0.85 ? 0.3 : 0.1);
    let loss = 0;
    for (let s = 0; s + batch <= train.length; s += batch) {
      for (let l = 0; l < L; l++) { gW[l].fill(0); gb[l].fill(0); }
      for (let k = 0; k < batch; k++) {
        const i = train[s + k], x = X.subarray(i * nIn, (i + 1) * nIn);
        const err = (net.forward(x) - y[i]) / sd; loss += err * err;
        delta[L - 1][0] = err;
        for (let l = L - 1; l >= 0; l--) {
          const input = l ? net.act[l - 1] : x, nI = net.sizes[l], nO = net.sizes[l + 1], dl = delta[l], g = gW[l], W = net.W[l];
          for (let j = 0; j < nO; j++) gb[l][j] += dl[j];
          const dprev = l ? delta[l - 1] : null;
          for (let a = 0, w = 0; a < nI; a++, w += nO) {
            const v = input[a];
            if (v !== 0) for (let j = 0; j < nO; j++) g[w + j] += v * dl[j];
            if (dprev) { let acc = 0; if (v > 0) for (let j = 0; j < nO; j++) acc += W[w + j] * dl[j]; dprev[a] = acc; }
          }
        }
      }
      step++;
      const c1 = 1 - Math.pow(b1, step), c2 = 1 - Math.pow(b2, step), inv = 1 / batch;
      for (let l = 0; l < L; l++) { upd(net.W[l], gW[l], mW[l], vW[l], rate, c1, c2, inv); upd(net.b[l], gb[l], mb[l], vb[l], rate, c1, c2, inv); }
    }
    res = evalVal();
    if (log) log(`  epoch ${ep + 1}/${epochs}: fit error ${(Math.sqrt(loss / train.length) * sd).toFixed(0)}  on held-out games ${res.rmse.toFixed(0)}  explains ${(100 * res.r2).toFixed(0)}%`);
  }
  return res;
}
