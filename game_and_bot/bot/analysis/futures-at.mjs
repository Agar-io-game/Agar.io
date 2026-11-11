// What the planner sees at one moment of a recorded bot game: rebuilds the position at
// <seconds> (cells from the frame, cursors and controlled unit from the events; merge timers
// and split order are approximations) and lists the futures of one decision.
//   node bot/analysis/futures-at.mjs <recording> <seconds> [overrideJSON] [goal degrees]
// The goal defaults to the heading in a games.mjs file name (g3_p4_45.jsonl.gz -> 45).
import { load } from './splits.mjs';
import { Game } from '../sim.mjs';
import { Brain, policyNet, playerOptions } from '../brain.mjs';
import { ImitationPlayer } from '../policy.mjs';
import { loadParams } from '../run.mjs';

export function stateAt(rec, T) {
  const f = rec.byTick.get(T); if (!f) throw new Error('no frame at tick ' + T);
  const now = 1e6, aim = [null, null]; let active = rec.r.players?.[0]?.active & 1 || 0;
  for (const e of rec.r.events) { if (e.tick > T) break; if (e.ev === 'tab') active = (e.pid & 1) ^ 1; if (e.ev === 'aim') aim[e.pid & 1] = { x: e.x, y: e.y }; if (e.ev === 'reset') active = active; }
  const cells = f.map((c) => ({ id: c.id, unit: c.u, x: c.x, y: c.y, mass: c.mass, boost: c.boost, angle: c.angle, born: now - 1000, mergeAt: now + 30000 }));
  const cen = (u) => { let m = 0, x = 0, y = 0; for (const c of cells) if (c.unit === u) { m += c.mass; x += c.x * c.mass; y += c.y * c.mass; } return { x: x / m, y: y / m }; };
  return { now, active, aim: aim.map((a, u) => a ?? cen(u)), splitQueue: [0, 0], cells };
}

if (process.argv[1]?.endsWith('futures-at.mjs')) {
  const [file, sec, over = '{}', deg] = process.argv.slice(2);
  const rec = load(file, 0), T = rec.r.t0 + Math.round(+sec * 25);
  const goal = ((deg ?? +(/_(-?\d+)\.jsonl/.exec(file)?.[1] ?? 0)) * Math.PI) / 180;
  const g = new Game(stateAt(rec, T));
  const params = { ...loadParams(), ...JSON.parse(over) };
  const brain = new Brain(params, goal);
  brain.line = g.centre(); brain.mass0 = g.mass();
  const player = new ImitationPlayer(policyNet(), playerOptions(brain.p, goal));
  const sh = (s) => { const a = s.cells(0).reduce((m, c) => m + c.mass, 0), b = s.cells(1).reduce((m, c) => m + c.mass, 0); return `${(100 * a / (a + b)).toFixed(0)}/${(100 * b / (a + b)).toFixed(0)}% cells ${s.cells(0).length}/${s.cells(1).length}`; };
  console.log(`now: active u${g.active}  ${sh(g)}  key probabilities none/split/full/tab ${player.decide(g).p.map((v) => v.toFixed(3)).join(' ')}`);
  player.idle = 999; // as in a stall, so the escapes are listed too (their number is the gain over pressing nothing)
  const rows = [];
  brain.trace = (r) => rows.push({ i: r.i, v: r.v, keys: r.keys.join(' '), end: sh(r.game), tag: r.tag ?? '' });
  brain.futures(g, player, 0, brain.p.samples);
  rows.sort((a, b) => b.v - a.v);
  for (const r of rows) console.log(`${String(r.i).padStart(3)} ${r.v.toFixed(0).padStart(8)}  ${r.end}  ${r.tag} ${r.keys}`);
}
