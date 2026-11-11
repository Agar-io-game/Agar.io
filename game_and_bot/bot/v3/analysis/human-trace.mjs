// Your play, press by press: which unit splits, its cells, and who eats whom afterwards.
//   node bot/v3/analysis/human-trace.mjs [recording index 0-3] [from second] [seconds]
import { loadRecording } from '../recording.mjs';
import { readdirSync } from 'node:fs';
const dir = new URL('../../../recordings/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.gz')).sort();
const r = loadRecording(new URL(files[Number(process.argv[2] ?? 3)], dir));
const from = r.t0 + Math.round(Number(process.argv[3] ?? 300) * 25), to = from + Math.round(Number(process.argv[4] ?? 12) * 25);
const byTick = new Map(r.frames.map((f) => [f.tick, f]));
const evs = r.events.filter((e) => e.ev !== 'aim' && e.tick >= from && e.tick < to);
const aims = r.events.filter((e) => e.ev === 'aim');
let prev = byTick.get(from - 1), x0 = null;
const cen = (cs) => { let m = 0, x = 0, y = 0; for (const c of cs) { m += c[4]; x += c[2] * c[4]; y += c[3] * c[4]; } return { x: x / m, y: y / m, m }; };
// course over the stretch
const ca = cen(byTick.get(from).cells), cb = cen(byTick.get(to).cells), ang = Math.atan2(cb.y - ca.y, cb.x - ca.x), gx = Math.cos(ang), gy = Math.sin(ang);
console.log(`course ${Math.round(ang * 180 / Math.PI)} deg, ${Math.round(Math.hypot(cb.x - ca.x, cb.y - ca.y) / ((to - from) / 25))} u/s net`);
for (let t = from; t < to; t++) {
  const f = byTick.get(t); if (!f) continue;
  const now = new Map(f.cells.map((c) => [c[0], c])), was = new Map((prev?.cells ?? []).map((c) => [c[0], c]));
  const eats = [];
  for (const [id, c] of was) if (!now.has(id)) {
    let who = null; for (const [id2, n] of now) { const w = was.get(id2); if (w && Math.abs(n[4] - w[4] - c[4]) < 0.02 * c[4] + 1) who = n; }
    eats.push(`${Math.round(c[4])}(u${c[1] & 1})->${who ? Math.round(who[4]) + '(u' + (who[1] & 1) + ')' : '?'}`);
  }
  if (eats.length) console.log(`   t=${((t - r.t0) / 25).toFixed(2)} eaten: ${eats.join(', ')}`);
  for (const e of evs.filter((e) => e.tick === t)) {
    const c = cen(f.cells);
    const fmt = (u) => f.cells.filter((q) => (q[1] & 1) === u).sort((a, b) => a[0] - b[0]).map((q) => `${Math.round(q[4])}@${Math.round((q[2] - c.x) * gx + (q[3] - c.y) * gy)}`).join(' ');
    let extra = '';
    if (e.ev === 'split') {
      const u = e.pid & 1, mineC = cen(f.cells.filter((q) => (q[1] & 1) === u));
      let am = null; for (const a of aims) { if (a.tick > t) break; if (a.pid === e.pid) am = a; }
      if (am) { const dx = am.x - mineC.x, dy = am.y - mineC.y; extra = ` aim ${Math.round((Math.atan2(dy, dx) - ang) * 180 / Math.PI)}deg/${Math.round(Math.hypot(dx, dy))}`; }
    }
    console.log(`t=${((t - r.t0) / 25).toFixed(2)} ${e.ev}${e.n ?? ''} u${e.pid & 1}${extra} | U0[${f.cells.filter((q) => (q[1] & 1) === 0).length}] ${fmt(0)} | U1[${f.cells.filter((q) => (q[1] & 1) === 1).length}] ${fmt(1)}`);
  }
  prev = f;
}
