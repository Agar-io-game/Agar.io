// per 5 s: presses, tabs, both units' cells and share, progress
import { load } from './splits.mjs';
const rec = load(process.argv[2], 0), r = rec.r;
const cen = (f) => { let m = 0, x = 0, y = 0; for (const c of f) { m += c.mass; x += c.x * c.mass; y += c.y * c.mass; } return { x: x / m, y: y / m, m }; };
let prev = null;
for (let T = r.t0; T <= rec.end; T += 125) {
  const f = rec.byTick.get(T); if (!f) continue;
  const c = cen(f), by = [0, 1].map((u) => f.filter((q) => q.u === u));
  const ev = r.events.filter((e) => e.tick >= T && e.tick < T + 125);
  const d = prev ? Math.hypot(c.x - prev.x, c.y - prev.y) / 5 : 0; prev = c;
  console.log(`${((T - r.t0) / 25).toFixed(0).padStart(4)}s  ${d.toFixed(0).padStart(4)} u/s  splits ${ev.filter((e) => e.ev === 'split').length} tabs ${ev.filter((e) => e.ev === 'tab').length}  u0 ${by[0].length} cells ${(100 * by[0].reduce((a, q) => a + q.mass, 0) / c.m).toFixed(0)}% | u1 ${by[1].length} cells ${(100 * by[1].reduce((a, q) => a + q.mass, 0) / c.m).toFixed(0)}%`);
}
