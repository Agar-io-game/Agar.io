// Builds the training start state from a recording: every cell of both units at the given
// second, plus what the recording does not store directly but the rules need, rebuilt from
// the history before it: when each cell was last split (merge timer, no-collide window),
// which unit is active, and both units' cursors.
//   node bot/extract-start.mjs [recording] [seconds] [totalMass]
// Defaults: recordings/20261029-001559.jsonl.gz at 48.2 s, scaled to 35000 total mass.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadRecording } from './recording.mjs';
import config from '../../server/config.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const file = process.argv[2] ?? here('../../recordings/20261029-001559.jsonl.gz');
const seconds = Number(process.argv[3] ?? 48.2);
const totalMass = Number(process.argv[4] ?? 35000);

export function extractState(rec, seconds) {
  const { frames, events, t0 } = rec;
  const startTick = t0 + Math.round(seconds / 0.04);
  const info = new Map(); // id -> { born, mergeAt }
  let prev = new Map();
  for (const f of frames) {
    if (f.tick > startTick) break;
    const cur = new Map();
    for (const c of f.cells) {
      const [id, , , , mass] = c;
      const before = prev.get(id);
      const stamp = () => info.set(id, { born: f.tick, mergeAt: f.tick * config.tickMs + (config.recombineBaseSec + config.recombineMassFactor * mass) * 1000 });
      if (!before) stamp();                       // new piece (or spawn)
      else if (mass < before[4] * 0.75) stamp();  // halved: it split this tick
      cur.set(id, c);
    }
    prev = cur;
  }
  const frame = frames.find((f) => f.tick === startTick);
  if (!frame) throw new Error(`no frame at tick ${startTick}`);
  // Cursor of each unit and the active unit, from the input events up to the start.
  const aim = {}, pending = {}; let active = null;
  for (const e of events) {
    if (e.tick > startTick) break;
    const u = e.pid & 1;
    if (e.ev === 'aim') { aim[u] = { x: e.x, y: e.y }; active = u; }
    if (e.ev === 'tab') active = u ^ 1;
    if (e.ev === 'split') pending[u] = { tick: e.tick, n: e.n };
  }
  const splitQueue = [0, 1].map((u) => (pending[u] ? Math.max(0, pending[u].n - (startTick - pending[u].tick)) : 0));
  const cells = frame.cells.map(([id, pid, x, y, mass, boost, angle]) => ({
    id, unit: pid & 1, x, y, mass, boost, angle,
    born: info.get(id).born * config.tickMs, mergeAt: info.get(id).mergeAt,
  })).sort((a, b) => a.id - b.id); // creation order = split order
  return { source: { tick: startTick, seconds }, now: startTick * config.tickMs, active, aim: [aim[0], aim[1]], splitQueue, cells };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rec = loadRecording(file);
  const s = extractState(rec, seconds);
  const m = s.cells.reduce((a, c) => a + c.mass, 0);
  const k = totalMass / m;
  for (const c of s.cells) c.mass *= k;
  s.source.file = file.split(/[\/]/).pop(); s.source.recordedMass = m; s.source.scale = k;
  writeFileSync(here('./data/start-state.json'), JSON.stringify(s, null, 1));
  console.log(`tick ${s.source.tick}: ${s.cells.length} cells, mass ${m.toFixed(0)} -> ${totalMass}, active unit ${s.active}, splitQueue ${s.splitQueue}`);
  for (const c of s.cells) console.log(`  #${c.id} u${c.unit} m=${c.mass.toFixed(0)} boost=${c.boost} mergeIn=${((c.mergeAt - s.now) / 1000).toFixed(1)}s age=${((s.now - c.born) / 1000).toFixed(1)}s`);
}
