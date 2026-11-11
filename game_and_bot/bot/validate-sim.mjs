// Replays your recorded inputs from the start state in the headless game and compares it
// with what the recording shows, to check the training game behaves like the real one.
import { fileURLToPath } from 'node:url';
import { loadRecording, massCentre } from './recording.mjs';
import { extractState } from './extract-start.mjs';
import { Game } from './sim.mjs';

const file = fileURLToPath(new URL('../recordings/20261029-001559.jsonl.gz', import.meta.url));
const rec = loadRecording(file);
const offset = Number(process.argv[2] ?? 0), secs = Number(process.argv[3] ?? 48.2), dur = Number(process.argv[4] ?? 10);
const s = extractState(rec, secs);
const g = new Game(s);
const byTick = new Map(rec.frames.map((f) => [f.tick, f]));
const evAt = new Map(); for (const e of rec.events) (evAt.get(e.tick) ?? evAt.set(e.tick, []).get(e.tick)).push(e);
let t = s.source.tick; const errs = [];
for (let k = 0; k < dur * 25; k++) {
  for (const e of evAt.get(t + offset) ?? []) {
    if (e.ev === 'aim') g.aim(e.x, e.y);
    else if (e.ev === 'split') g.split(e.n);
    else if (e.ev === 'tab') g.tab();
  }
  g.step(); t++;
  const f = byTick.get(t); if (!f) continue;
  const real = new Map(f.cells.map((c) => [c[0], c]));
  let err = 0, n = 0, miss = 0;
  for (const u of g.player.units) for (const c of u.cells) { const r = real.get(c.id); if (r) { err += Math.hypot(r[2] - c.x, r[3] - c.y); n++; } else miss++; }
  const a = massCentre(f.cells), b = g.centre();
  errs.push(err / Math.max(1, n));
  if (k % 25 === 24) console.log(`+${((k + 1) / 25).toFixed(0)}s  cells sim ${g.player.units.map((u) => u.cells.length).join('/')} rec ${[0, 1].map((u) => f.cells.filter((c) => (c[1] & 1) === u).length).join('/')}  mean pos err ${(err / Math.max(1, n)).toFixed(1)}  unmatched ${miss}  centre err ${Math.hypot(a.x - b.x, a.y - b.y).toFixed(0)}`);
}
