// What the value network sees of a position: every cell of both units, in a frame that runs
// along the course with the mass centre at the origin, so the same shape looks the same
// wherever it is and whichever way it runs. The heavier unit comes first, and the cells of
// each unit are listed biggest first.
import { CAP, LAYOUT as L, FLIGHT_K } from './sim.mjs';

const PER_CELL = 8, GLOBALS = 12;
export const INPUTS = 2 * CAP * PER_CELL + GLOBALS;
const idx = new Int32Array(CAP), rank = new Int32Array(CAP);
const um = [0, 0], big = [0, 0];

// out: Float32Array(INPUTS). idle0 / idle1: ticks since each unit last split.
export function featurize(sim, gx, gy, idle0, idle1, out) {
  const d = sim.d, F = L.F;
  out.fill(0);
  let M = 0, cx = 0, cy = 0; um[0] = um[1] = 0; big[0] = big[1] = 0;
  for (let u = 0; u < 2; u++) for (let k = 0, o = u * CAP * F; k < d[L.N0 + u]; k++, o += F) { const m = d[o + L.M]; M += m; um[u] += m; cx += d[o + L.X] * m; cy += d[o + L.Y] * m; }
  cx /= M; cy /= M;
  const first = um[1] > um[0] ? 1 : 0;
  for (let i = 0; i < 2; i++) {
    const u = i ? first ^ 1 : first, n = d[L.N0 + u], base = u * CAP * F;
    for (let k = 0; k < n; k++) idx[k] = k;
    // biggest first (insertion sort, stable)
    for (let a = 1; a < n; a++) { const v = idx[a], mv = d[base + v * F + L.M]; let b = a - 1; while (b >= 0 && d[base + idx[b] * F + L.M] < mv) { idx[b + 1] = idx[b]; b--; } idx[b + 1] = v; }
    // split order among the cells that can split: 0 = splits first
    let r = 0; for (let k = 0; k < n; k++) rank[k] = d[base + k * F + L.M] >= 44 ? r++ : CAP;
    if (n) big[u] = d[base + idx[0] * F + L.M];
    for (let j = 0; j < n; j++) {
      const k = idx[j], o = base + k * F, q = (i * CAP + j) * PER_CELL, m = d[o + L.M];
      const dx = d[o + L.X] - cx, dy = d[o + L.Y] - cy, fl = d[o + L.B] * FLIGHT_K;
      out[q] = 1;
      out[q + 1] = m / M * 4;
      out[q + 2] = Math.log(m) / 10;
      out[q + 3] = (dx * gx + dy * gy) / 2000;
      out[q + 4] = (-dx * gy + dy * gx) / 2000;
      out[q + 5] = fl * (d[o + L.C] * gx + d[o + L.S] * gy) / 800;
      out[q + 6] = fl * (-d[o + L.C] * gy + d[o + L.S] * gx) / 800;
      out[q + 7] = rank[k] / CAP;
    }
  }
  const g = 2 * CAP * PER_CELL, a = first, b = first ^ 1;
  out[g] = um[a] / M;
  out[g + 1] = d[L.N0 + a] / CAP; out[g + 2] = d[L.N0 + b] / CAP;
  out[g + 3] = Math.min(3, (a ? idle1 : idle0) / 50); out[g + 4] = Math.min(3, (b ? idle1 : idle0) / 50);
  out[g + 5] = sim.splittable(a) / M; out[g + 6] = sim.splittable(b) / M;
  out[g + 7] = sim.edible(a, big[b]) / M; out[g + 8] = sim.edible(b, big[a]) / M;
  out[g + 9] = big[a] / M; out[g + 10] = big[b] / M;
  out[g + 11] = 1;
  return out;
}

// The same position mirrored left-right across the course: it is worth the same.
export function mirror(src, out) {
  out.set(src);
  for (let q = 0; q < 2 * CAP * PER_CELL; q += PER_CELL) { out[q + 4] = -src[q + 4]; out[q + 6] = -src[q + 6]; }
  return out;
}
