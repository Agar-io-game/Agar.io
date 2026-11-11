// The start positions: the four frozen positions in recordings/positions/, in file order
// (1, 2, 3, 4). Each is scaled to 35,000 total mass and turned so that the way it was running
// points east; place() then turns it to the bot's course and puts it where the bot is.
// The bot starts from position 1 and, if it ever loses a unit, goes to the next one in turn
// (1, 2, 3, 4, 1, ...) on the very next tick.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadRecording } from './recording.mjs';
import config from '../../server/config.mjs';

export const TOTAL_MASS = 35000;
const DIR = fileURLToPath(new URL('../../recordings/positions/', import.meta.url));
const mergeMs = (mass) => (config.recombineBaseSec + config.recombineMassFactor * mass) * 1000;

const centre = (cs) => { let m = 0, x = 0, y = 0; for (const c of cs) { m += c.mass; x += c.x * c.mass; y += c.y * c.mass; } return { x: x / m, y: y / m, m }; };
// Where a frozen position was running: the median direction its pieces were thrown in.
function courseOf(cells) {
  const thrown = cells.filter((c) => c.angle !== 0).map((c) => c.angle);
  const off = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  let best = 0, bestCost = Infinity;
  for (const a of thrown) { const cost = thrown.reduce((s, b) => s + off(a, b), 0); if (cost < bestCost) { bestCost = cost; best = a; } }
  return best;
}

// A frozen position has no history, so the time since each cell last split is taken as 1 s:
// its merge timer is full and its 0.6 s pass-through window is over (in your runs nearly every
// cell has split within the last second or two).
function frozen(file) {
  const rec = loadRecording(DIR + file), f = rec.frames[0];
  let cells = f.cells.map(([id, pid, x, y, mass, , angle]) => ({ id, unit: pid & 1, x, y, mass, boost: 0, angle }));
  const course = courseOf(cells), C = centre(cells), k = TOTAL_MASS / C.m;
  const cos = Math.cos(-course), sin = Math.sin(-course);
  cells = cells.map((c) => ({ ...c, x: (c.x - C.x) * cos - (c.y - C.y) * sin, y: (c.x - C.x) * sin + (c.y - C.y) * cos, mass: c.mass * k, angle: c.angle - course }))
    .sort((a, b) => a.id - b.id);
  const activePid = rec.header.players?.[0]?.active;
  return { file, active: activePid != null ? activePid & 1 : 0, cells };
}

export const STARTS = readdirSync(DIR).filter((f) => f.endsWith('.jsonl.gz')).sort().map(frozen);

// Start position `index` (0-3) as a game state: mass centre at `at`, running along `angle`,
// clock at `now`, new cell ids from idBase up (in the same split order).
export function place(index, { at = { x: 0, y: 0 }, angle = 0, now = 0, idBase = 1 } = {}) {
  const s = STARTS[index % STARTS.length], cos = Math.cos(angle), sin = Math.sin(angle), since = 1000;
  const cells = s.cells.map((c, i) => ({
    id: idBase + i, unit: c.unit, x: at.x + c.x * cos - c.y * sin, y: at.y + c.x * sin + c.y * cos,
    mass: c.mass, boost: 0, angle: c.angle + angle, born: now - since, mergeAt: now - since + mergeMs(c.mass),
  }));
  const aim = [0, 1].map((u) => { const c = centre(cells.filter((q) => q.unit === u)); return { x: c.x + 3000 * cos, y: c.y + 3000 * sin }; });
  return { now, active: s.active, aim, splitQueue: [0, 0], cells, nextId: idBase + cells.length };
}
