// Builds the training start state from a recording: every cell of both units at the given
// second, plus what the recording does not store directly but the rules need, rebuilt from
// the history before it: when each cell was last split (merge timer, no-collide window),
// which unit is active, and both units' cursors.
//   node bot/extract-start.mjs [recording] [seconds] [totalMass]
//   node bot/extract-start.mjs --positions   (all start positions -> data/start-positions.json)
// Defaults: recordings/20261029-001559.jsonl.gz at 48.2 s, scaled to 35000 total mass.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadRecording } from './recording.mjs';
import config from '../server/config.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const file = process.argv[2] ?? here('../recordings/20261029-001559.jsonl.gz');
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

// A position you set up and froze (recordings/positions/*.jsonl.gz: a second or two in which
// nothing moves): its first frame. Such a recording has no history, so the time since each
// cell last split is set to 1 s. In your split runs nearly every cell has split within the
// last 1-2 s whatever its age in the queue (median 0.4-1.8 s in all four games), so its
// merge timer is full and its 0.6 s no-collide window is over. Split order is the cells' ids
// (creation order), which the recording keeps. The active unit comes from the header, the
// cursors from the first aim events or else ahead of each unit.
export function frozenState(rec) {
  const f = rec.frames[0], now = f.tick * config.tickMs, since = 1000;
  const cells = f.cells.map(([id, pid, x, y, mass, boost, angle]) => ({
    id, unit: pid & 1, x, y, mass, boost, angle,
    born: now - since, mergeAt: now - since + (config.recombineBaseSec + config.recombineMassFactor * mass) * 1000,
  })).sort((a, b) => a.id - b.id);
  const course = courseOf(cells);
  const activePid = rec.header.players?.[0]?.active;
  const active = activePid != null ? activePid & 1 : 0;
  const aim = [0, 1].map((u) => {
    const e = rec.events.find((v) => v.ev === 'aim' && (v.pid & 1) === u);
    if (e) return { x: e.x, y: e.y };
    const c = centre(cells.filter((q) => q.unit === u));
    return { x: c.x + 1500 * Math.cos(course), y: c.y + 1500 * Math.sin(course) };
  });
  return { source: { tick: f.tick, seconds: 0, course }, now, active, aim, splitQueue: [0, 0], cells };
}

const centre = (cs) => { let m = 0, x = 0, y = 0; for (const c of cs) { m += c.mass; x += c.x * c.mass; y += c.y * c.mass; } return { x: x / m, y: y / m, m }; };

// Where a frozen position was running: the median direction its pieces were thrown in (a
// split piece keeps the direction of its split; spawn cells have none), one vote per piece,
// so one big cell thrown back onto the other unit does not turn the course around.
export function courseOf(cells) {
  const thrown = cells.filter((c) => c.angle !== 0).map((c) => c.angle);
  const off = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  let best = 0, bestCost = Infinity;
  for (const a of thrown) { const cost = thrown.reduce((s, b) => s + off(a, b), 0); if (cost < bestCost) { bestCost = cost; best = a; } }
  return best;
}

// Turns a state about its mass centre so that its course points east (angle 0), the way the
// bot's start state runs, and scales it to `totalMass`.
export function turnEast(s, totalMass = 35000) {
  const C = centre(s.cells), a = -(s.source.course ?? 0), cos = Math.cos(a), sin = Math.sin(a), k = totalMass / C.m;
  const T = (q) => ({ x: C.x + (q.x - C.x) * cos - (q.y - C.y) * sin, y: C.y + (q.x - C.x) * sin + (q.y - C.y) * cos });
  return {
    ...s, source: { ...s.source, recordedMass: C.m, scale: k },
    aim: s.aim.map(T),
    cells: s.cells.map((c) => ({ ...c, ...T(c), mass: c.mass * k, angle: c.angle + a })),
  };
}

// node bot/extract-start.mjs --positions: data/start-positions.json, every position the bot
// starts from (and goes back to, in turn, after a lost unit): your 48.2 s position first,
// then each frozen position in recordings/positions/, all turned east and scaled to 35,000.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes('--positions')) {
  const { readdirSync } = await import('node:fs');
  const first = extractState(loadRecording(here('../recordings/20261029-001559.jsonl.gz')), 48.2);
  const m = first.cells.reduce((a, c) => a + c.mass, 0);
  for (const c of first.cells) c.mass *= 35000 / m;
  first.source = { ...first.source, file: '20261029-001559.jsonl.gz', recordedMass: m, scale: 35000 / m, course: 0 };
  const states = [first];
  const dir = here('../recordings/positions/');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl.gz')).sort()) {
    const s = turnEast(frozenState(loadRecording(dir + f)));
    s.source.file = 'positions/' + f;
    states.push(s);
  }
  writeFileSync(here('./data/start-positions.json'), JSON.stringify(states, null, 1));
  for (const s of states) {
    const by = [0, 1].map((u) => s.cells.filter((c) => c.unit === u));
    console.log(`${s.source.file} tick ${s.source.tick}: course ${Math.round((s.source.course * 180) / Math.PI)} deg, ${by.map((cs, u) => `unit ${u} ${cs.length} cells ${Math.round(cs.reduce((a, c) => a + c.mass, 0))}`).join(', ')}; active unit ${s.active}`);
  }
} else if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
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
