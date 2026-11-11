// The imitation policy: a small neural network that has learned from your recordings what
// you do in a split-run position: which key you press next (none / split / full split /
// Tab) and where your cursor is. imitate.mjs trains it; the bot uses it to play and as the
// player inside its look-ahead.
//
// Inputs are taken in a frame that follows the play: origin at the controlled unit's mass
// centre, x axis along the heading (for the bot: its course; for your games: where you were
// going over the last 2 s). Distances in thousands of units.
export const KEYS = ['none', 'split1', 'split4', 'tab'];
export const TOP = 12; // cells per unit fed to the network, biggest first
export const INPUTS = 2 * TOP * 6 + 12;

// cells: [{ unit, x, y, mass, boost, angle }]; active: controlled unit; heading {x,y};
// other: { aim (other unit's cursor, world), sinceKey, lastKey ('split'|'tab'|null), sinceTab }
export function encode(cells, active, heading, other, out = new Float32Array(INPUTS)) {
  out.fill(0);
  let M = 0, ax = 0, ay = 0, am = 0, bx = 0, by = 0, bm = 0;
  const A = [], B = [];
  for (const c of cells) {
    M += c.mass;
    if (c.unit === active) { A.push(c); ax += c.x * c.mass; ay += c.y * c.mass; am += c.mass; }
    else { B.push(c); bx += c.x * c.mass; by += c.y * c.mass; bm += c.mass; }
  }
  if (!am) return out;
  ax /= am; ay /= am;
  const hx = heading.x, hy = heading.y;
  const rot = (dx, dy) => [(dx * hx + dy * hy) / 1000, (-dx * hy + dy * hx) / 1000];
  const put = (list, base) => {
    list.sort((p, q) => q.mass - p.mass);
    for (let i = 0; i < Math.min(TOP, list.length); i++) {
      const c = list[i], o = base + i * 6, [u, v] = rot(c.x - ax, c.y - ay);
      out[o] = 1; out[o + 1] = u; out[o + 2] = v; out[o + 3] = (c.mass / M) * 10;
      const bx2 = Math.cos(c.angle) * c.boost, by2 = Math.sin(c.angle) * c.boost;
      out[o + 4] = (bx2 * hx + by2 * hy) / 100; out[o + 5] = (-bx2 * hy + by2 * hx) / 100;
    }
  };
  put(A, 0); put(B, TOP * 6);
  const g = TOP * 12;
  out[g] = A.length / 16; out[g + 1] = B.length / 16; out[g + 2] = am / M;
  if (bm) { const [u, v] = rot(bx / bm - ax, by / bm - ay); out[g + 3] = u; out[g + 4] = v; }
  if (other.aim) { const [u, v] = rot(other.aim.x - ax, other.aim.y - ay); out[g + 5] = Math.tanh(u / 3); out[g + 6] = Math.tanh(v / 3); }
  out[g + 7] = Math.min(other.sinceKey, 50) / 25; out[g + 8] = Math.min(other.sinceTab, 75) / 25;
  out[g + 9] = other.lastKey === 'split' ? 1 : 0; out[g + 10] = other.lastKey === 'tab' ? 1 : 0;
  out[g + 11] = 1;
  return out;
}

// Cursor target in the same frame, squashed: tanh(distance / 3000) on each axis.
export const encodeAim = (aim, centre, heading) => {
  const dx = aim.x - centre.x, dy = aim.y - centre.y;
  return [Math.tanh((dx * heading.x + dy * heading.y) / 3000), Math.tanh((-dx * heading.y + dy * heading.x) / 3000)];
};
export const decodeAim = (u, v, centre, heading) => {
  const at = (z) => 3000 * Math.atanh(Math.max(-0.995, Math.min(0.995, z)));
  const a = at(u), b = at(v);
  return { x: centre.x + a * heading.x - b * heading.y, y: centre.y + a * heading.y + b * heading.x };
};

// Your cursor is a choice, not one spot: far ahead, far to a side, on the cell of your other
// unit that a half should eat or that should eat your halves, ... A network that predicts a
// single (average) cursor lands between those choices: the first policy put it on its own
// cells at 51% of its splits (you: 8%). So the cursor head is a mixture of MIX choices
// (a mixture density network): for each choice where the cursor would be and how spread,
// and for each key (none, split, full split, Tab) how likely you pick that choice when
// pressing it. The player picks one choice and keeps it until its next key press.
export const MIX = 5;
export const OUT_MIX = 4 + 8 * MIX;
export const mixLogit = (key, j) => 4 + key * MIX + j; // 4 x MIX choice logits, per key
export const mixMean = (j) => 4 + 4 * MIX + 2 * j;     // MIX x (u, v) in encodeAim space
export const mixLogSd = (j) => 4 + 6 * MIX + 2 * j;    // MIX x log spread of u and v
export const LOGSD_MIN = -4, LOGSD_MAX = 0.5;
const HOLD = 3; // ticks a split's cursor choice is kept after the press (a full split throws on 4 ticks)

// ---- a tiny MLP: inputs -> H1 tanh -> H2 tanh -> [4 key logits, cursor head] ----
// cursor head: 2 values (old single-cursor policy) or the mixture above (OUT_MIX outputs)
export class MLP {
  constructor(sizes, weights = null) {
    this.sizes = sizes; this.layers = [];
    for (let l = 0; l + 1 < sizes.length; l++) {
      const n = sizes[l], m = sizes[l + 1];
      const W = new Float32Array(n * m), b = new Float32Array(m);
      const s = Math.sqrt(1 / n);
      for (let i = 0; i < W.length; i++) W[i] = (Math.random() * 2 - 1) * s * 1.7;
      this.layers.push({ n, m, W, b });
    }
    if (weights) this.load(weights);
    this.acts = sizes.map((n) => new Float32Array(n));
  }
  forward(x) {
    let a = x; this.acts[0] = x;
    for (let l = 0; l < this.layers.length; l++) {
      const { n, m, W, b } = this.layers[l], z = this.acts[l + 1];
      for (let j = 0; j < m; j++) {
        let s = b[j]; const off = j * n;
        for (let i = 0; i < n; i++) s += W[off + i] * a[i];
        z[j] = l + 1 < this.layers.length ? Math.tanh(s) : s;
      }
      a = z;
    }
    return a;
  }
  save() { return { sizes: this.sizes, layers: this.layers.map((L) => ({ W: Array.from(L.W, (v) => +v.toFixed(5)), b: Array.from(L.b, (v) => +v.toFixed(5)) })) }; }
  load(w) { w.layers.forEach((L, i) => { this.layers[i].W.set(L.W); this.layers[i].b.set(L.b); }); }
}

const softmax = (z, k) => { let m = -Infinity; for (let i = 0; i < k; i++) m = Math.max(m, z[i]); let s = 0; const p = new Array(k); for (let i = 0; i < k; i++) { p[i] = Math.exp(z[i] - m); s += p[i]; } return p.map((v) => v / s); };

// Plays a Game with the learned policy. keyGap as in the bot (no key faster than yours).
export class ImitationPlayer {
  // aimSwitch: chance per tick of picking a cursor choice again without a key press
  // splitRate / splitBurst: at most splitRate splits a second on average, splitBurst at once (a
  // bucket of splitBurst presses that refills at splitRate a second; 0 = no limit). lightShare:
  // the lighter unit, under this share of the mass, does not split when no half of its
  // splitting cells could eat a cell of the other unit (0 = no such rule).
  constructor(net, { goalAngle = 0, keyGap = 4, temperature = 1, keyBias = 0, aimNoise = 0, aimSwitch = 0.05, keyNet = null, choiceAt = 'always', splitRate = 0, splitBurst = 3, lightShare = 0 } = {}) {
    this.net = net; this.heading = { x: Math.cos(goalAngle), y: Math.sin(goalAngle) };
    this.keyGap = keyGap; this.temperature = temperature; this.keyBias = keyBias; this.aimNoise = aimNoise;
    this.sinceKey = 99; this.sinceTab = 99; this.lastKey = null; this.aims = [null, null];
    this.buf = new Float32Array(INPUTS);
    this.mix = net.sizes.at(-1) === OUT_MIX; this.aimSwitch = aimSwitch; this.comp = -1;
    this.keyNet = keyNet; // optional: another policy that decides the keys (comparisons)
    // 'always': keep a cursor choice between key presses; 'split': your choice only while a split
    // is thrown (the press and HOLD ticks after it), the average of your choices otherwise
    this.choiceAt = choiceAt; this.hold = 0;
    this.splitRate = splitRate; this.splitBurst = splitBurst; this.tokens = splitBurst; this.lightShare = lightShare;
    this.sinceSplit = 99; this.lastSplitUnit = -1;
  }
  // May the active unit split now? The split budget, and the lighter unit's rule.
  maySplit(g) {
    if (this.splitRate > 0 && this.tokens < 1) return false;
    if (!this.lightShare) return true;
    const mine = g.cells(g.active), other = g.cells(g.active ^ 1);
    if (!mine.length || !other.length) return true;
    let um = 0, om = 0, minOther = Infinity;
    for (const c of mine) um += c.mass;
    for (const o of other) { om += o.mass; if (o.mass < minOther) minOther = o.mass; }
    if (um / (um + om) >= this.lightShare) return true;
    let slots = 16 - mine.length;
    for (const c of mine) { if (slots <= 0) break; if (c.mass < 44) continue; slots--; if (c.mass / 2 > 1.3 * minOther) return true; }
    return false;
  }
  clone() { const p = Object.assign(Object.create(ImitationPlayer.prototype), this); p.aims = this.aims.map((a) => a && { ...a }); p.buf = new Float32Array(INPUTS); return p; }
  observe(g) {
    const cells = [];
    for (let u = 0; u < 2; u++) for (const c of g.cells(u)) cells.push({ unit: u, x: c.x, y: c.y, mass: c.mass, boost: c.boost, angle: c.angle });
    return encode(cells, g.active, this.heading, { aim: g.player.units[g.active ^ 1].aim, sinceKey: this.sinceKey, sinceTab: this.sinceTab, lastKey: this.lastKey }, this.buf);
  }
  // Returns { key, aim } without applying it. rnd: () => [0,1)
  decide(g, rnd = Math.random) {
    const x = this.observe(g), out = this.net.forward(x), ko = this.keyNet ? this.keyNet.forward(x) : out;
    const z = [ko[0], ko[1] + this.keyBias, ko[2] + this.keyBias, ko[3] + this.keyBias].map((v) => v / this.temperature);
    const p = softmax(z, 4);
    let key = 'none';
    if (this.sinceKey >= this.keyGap && (p[1] + p[2] > 0) && !this.maySplit(g)) { const r = p[0] + p[3]; p[0] /= r; p[3] /= r; p[1] = 0; p[2] = 0; }
    if (this.sinceKey >= this.keyGap) {
      let r = rnd(), k = 0; while (k < 3 && r > p[k]) { r -= p[k]; k++; }
      key = KEYS[k];
    }
    let u = out[4], v = out[5], comp, hold;
    const kk = KEYS.indexOf(key), splitting = kk === 1 || kk === 2;
    if (this.mix && this.choiceAt === 'split' && !this.avgAim && (splitting || this.hold > 0)) {
      comp = this.comp; hold = this.hold - 1;
      if (splitting) {
        const z = []; for (let j = 0; j < MIX; j++) z.push(out[mixLogit(kk, j)]);
        const w = softmax(z, MIX);
        if (!this.aimNoise) { comp = 0; for (let j = 1; j < MIX; j++) if (w[j] > w[comp]) comp = j; }
        else { let r = rnd(); comp = 0; while (comp < MIX - 1 && r > w[comp]) { r -= w[comp]; comp++; } }
        hold = HOLD;
      }
      u = out[mixMean(comp)]; v = out[mixMean(comp) + 1];
    } else if (this.mix && (this.avgAim || this.choiceAt === 'split')) {
      hold = 0;
      // the average of your choices for this key (what a single-cursor network learns)
      const k = KEYS.indexOf(key), z = []; for (let j = 0; j < MIX; j++) z.push(out[mixLogit(k, j)]);
      const w = softmax(z, MIX); u = 0; v = 0;
      for (let j = 0; j < MIX; j++) { u += w[j] * out[mixMean(j)]; v += w[j] * out[mixMean(j) + 1]; }
    } else if (this.mix) {
      // a new cursor choice with every key press (from your choices for that key), now and
      // then without one; the first future (no noise) takes the likeliest choice
      comp = this.comp;
      const k = KEYS.indexOf(key);
      if (comp < 0 || k > 0 || rnd() < this.aimSwitch) {
        const z = []; for (let j = 0; j < MIX; j++) z.push(out[mixLogit(k, j)]);
        const w = softmax(z, MIX);
        if (!this.aimNoise) { comp = 0; for (let j = 1; j < MIX; j++) if (w[j] > w[comp]) comp = j; }
        else { let r = rnd(); comp = 0; while (comp < MIX - 1 && r > w[comp]) { r -= w[comp]; comp++; } }
      }
      u = out[mixMean(comp)]; v = out[mixMean(comp) + 1];
    }
    const centre = g.unitCentre(g.active);
    const aim = decodeAim(u + (this.aimNoise ? (rnd() - 0.5) * this.aimNoise : 0), v + (this.aimNoise ? (rnd() - 0.5) * this.aimNoise : 0), centre, this.heading);
    return { key, aim, p, comp, hold };
  }
  apply(g, d) {
    if (d.comp !== undefined) this.comp = d.comp;
    if (d.hold !== undefined) this.hold = d.hold;
    this.sinceKey++; this.sinceTab++; this.sinceSplit++;
    if (this.splitRate > 0) this.tokens = Math.min(this.splitBurst, this.tokens + this.splitRate / 25);
    if (d.key === 'tab') { g.tab(); this.sinceKey = 0; this.sinceTab = 0; this.lastKey = 'tab'; }
    g.aim(d.aim.x, d.aim.y);
    if (d.key === 'split1' || d.key === 'split4') {
      if (g.cells(g.active).length < 16 && !(this.splitRate > 0 && this.tokens < 1)) { // the budget is a hard limit
        g.split(d.key === 'split1' ? 1 : 4);
        this.tokens -= 1; this.sinceSplit = 0; this.lastSplitUnit = g.active;
      }
      this.sinceKey = 0; this.lastKey = 'split';
    }
  }
  act(g, rnd) { const d = this.decide(g, rnd); this.apply(g, d); return d; }
}
