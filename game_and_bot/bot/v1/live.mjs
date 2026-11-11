// Live mode: the trained bot joins your running server as an ordinary client (same packets
// as the browser: cursor, split 1/2/4, Tab; never W/E) and split-runs, so you can watch it
// in the game. Start the server (cd server && npm start), then:
//   node bot/live.mjs [ws://localhost:2525] [--goal <degrees>] [--name bot] [--samples n] [--at x,y]
// In the browser press Spectate and click the bot (or use your spectate-target hotkey).
//
// On join it switches Mass decay OFF and Map walls OFF (walls is a server-wide setting, the
// same as the menu's Extra option), spawns, and puts its cells at your 48.2 s position
// (data/start-state.json: 35,000 mass, every cell where it was, merge timers included) with
// the server's /place command, turned to the course (--goal, default 0 = east).
// If it ever loses a unit, it goes straight back to that position, where it is.
//
// The bot rebuilds the full game state each tick from what the server sends: positions,
// masses and flight of its own cells, plus the merge timers, worked out from when each cell
// appeared or halved (the rules are in server/world.mjs). It plans on that copy.
import { ServerDecoder } from '../../protocol.mjs';
import { Writer } from '../../server/packets.mjs';
import config from '../../server/config.mjs';
import { Game, moveStart } from './sim.mjs';
import { Brain, DEFAULT_PARAMS, policyNet } from './brain.mjs';
import { ImitationPlayer } from './policy.mjs';
import { Pipeline } from './planner-pool.mjs';
import { loadParams, loadStart } from './run.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const url = args.find((a) => a.startsWith('ws')) ?? 'ws://localhost:2525';
const goalAngle = (Number(opt('--goal', 0)) * Math.PI) / 180;
const name = opt('--name', 'bot');
const [atX, atY] = String(opt('--at', '0,0')).split(',').map(Number); // where it spawns (the server's /bot command passes it)
const START = loadStart();

const P = {
  handshake: () => new Writer().u8(252).strEx('lwga-111').strEx('bot').strEx('split-run-bot').bytes,
  entry: () => new Writer().u8(30).strEx(name).strEx('').strEx('').strEx('').strEx('').bytes,
  play: () => new Writer().u8(31).bytes,
  aim: (x, y) => new Writer().u8(16).i32(Math.round(x)).i32(Math.round(y)).bytes,
  split: (n) => new Writer().u8(25).u8(0).u8(n).bytes,
  tab: () => new Writer().u8(25).u8(3).u8(0).bytes,
  chat: (text) => new Writer().u8(124).u8(1).strUtf8(text).bytes,
  option: (text) => new Writer().u8(125).strUtf8(text).bytes,
};

const params = loadParams();
if (opt('--samples')) params.samples = Number(opt('--samples'));
console.log(Object.keys(params).length ? 'using trained weights (bot/data/params.json)' : 'no bot/data/params.json yet: using default weights');

const ws = new WebSocket(url); ws.binaryType = 'arraybuffer';
const send = (b) => { if (ws.readyState === 1) ws.send(b); };
const dec = new ServerDecoder();

let me = -1, tick = 0, phase = 'join', phaseAt = 0, resets = 0, placeTries = 0;
let placed = null, placedOver = new Set(); // cells just sent with /place (their merge timers, matched to the new cells), and the ids they replace
let active = 0;
const aims = [null, null];
const splitQueue = [0, 0];
const mirror = new Map(); // id -> { id, unit, x, y, mass, boost, angle, born, mergeAt }
let brain = null;
const now = () => tick * config.tickMs;

ws.onopen = () => {
  send(P.handshake()); send(P.entry());
  send(P.option('decay off')); send(P.option('walls off'));
  console.log(`connected to ${url}`);
};
ws.onclose = () => { console.log('disconnected'); process.exit(0); };
ws.onerror = (e) => { console.error(`cannot connect to ${url}: is the server running? (cd server && npm start)`); process.exit(1); };
ws.onmessage = (ev) => {
  let m; try { m = dec.decode(new Uint8Array(ev.data)); } catch { return; }
  if (m.op === 43) me = m.selfUserId;
  if (m.op === 15) onUpdate(m);
};

function onUpdate(u) {
  tick++;
  const t = now();
  const seen = new Set();
  for (const n of u.nodes) {
    if (n.type !== 0 || (n.owner & 0xfffe) !== me) continue;
    seen.add(n.nodeId);
    const old = mirror.get(n.nodeId);
    const stamp = (c) => { c.born = t; c.mergeAt = t + (config.recombineBaseSec + config.recombineMassFactor * n.mass) * 1000; };
    const c = old ?? { id: n.nodeId, unit: n.owner & 1 };
    if (!old || n.mass < old.mass * 0.75) stamp(c); // new piece, or it halved (split)
    if (!old && placed) { // a cell we placed: its age and merge timer are the start position's
      let best = -1, bd = 400;
      placed.forEach((q, i) => { const d = Math.hypot(q.x - n.x, q.y - n.y); if (!q.used && q.unit === (n.owner & 1) && Math.abs(q.mass - n.mass) < 0.03 * q.mass + 2 && d < bd) { bd = d; best = i; } });
      if (best >= 0) { const q = placed[best]; q.used = true; c.born = t - q.age; c.mergeAt = t + q.mergeIn; }
    }
    Object.assign(c, { x: n.x, y: n.y, mass: n.mass, boost: n.motionSpeed ?? 0, angle: n.motionAngle ?? 0 });
    mirror.set(n.nodeId, c);
  }
  for (const id of u.removed) mirror.delete(id);
  for (const id of [...mirror.keys()]) if (!seen.has(id)) mirror.delete(id);
  for (const k of [0, 1]) splitQueue[k] = Math.max(0, splitQueue[k] - 1);

  const units = [0, 1].map((k) => [...mirror.values()].filter((c) => c.unit === k));
  const total = [...mirror.values()].reduce((a, c) => a + c.mass, 0);
  // the server hands control to the other unit when the active one dies
  if (!units[active].length && units[active ^ 1].length) active ^= 1;

  // ---- start: spawn, then /place your 48.2 s position there ----
  if (phase === 'join' && me >= 0) {
    send(P.aim(atX || 0, atY || 0)); send(P.play()); phase = 'spawn'; phaseAt = tick; return;
  }
  if (phase === 'spawn' && units[0].length) { placeStart(units[0][0]); return; }
  if (phase === 'placing') {
    const ready = units[0].length && units[1].length && ![...mirror.keys()].some((id) => placedOver.has(id));
    if (!ready) { // not there after 2 s: again (a server started before /place existed ignores it)
      if (tick - phaseAt > 50) { if (++placeTries === 2) console.log('the server does not place the cells: restart it (cd server && npm start) so it has the /place command'); placeStart(centreOf([...mirror.values()]) ?? { x: 0, y: 0 }); }
      return;
    }
    placeTries = 0;
    placed = null;
    if (!brain) brain = (params.planner ?? DEFAULT_PARAMS.planner) === 'imitate'
      ? new Pipeline(params, goalAngle, { ImitationPlayer, net: policyNet(), DEFAULTS: DEFAULT_PARAMS }) // plans on worker threads, 2 ticks ahead
      : new Brain(params, goalAngle);
    else brain.restart();
    console.log(`${resets ? 'back at the start position' : 'running'}: ${Math.round(total)} mass, heading ${Math.round(goalAngle * 180 / Math.PI)} deg`);
    phase = 'run'; return;
  }
  if (phase !== 'run') return;
  if (!mirror.size) { console.log('died: respawning'); phase = 'join'; return; }
  // A lost unit is never played on: straight back to the start position, where it is.
  if (!units[0].length || !units[1].length) {
    resets++; console.log(`lost a unit (${resets}): back to the start position`);
    placeStart(centreOf([...mirror.values()])); return;
  }
  // Plan once on the newest state: if planning ever takes longer than a tick, the updates
  // that arrived meanwhile are all read first (setImmediate runs after pending messages).
  if (!thinking) { thinking = true; setImmediate(think); }
}

const centreOf = (cs) => { let m = 0, x = 0, y = 0; for (const c of cs) { m += c.mass; x += c.x * c.mass; y += c.y * c.mass; } return m ? { x: x / m, y: y / m } : null; };

// Sends /place with your 48.2 s position, its mass centre at `at`, turned to the course.
function placeStart(at) {
  const st = moveStart(START, { at, angle: goalAngle, now: now() });
  const r = (v, k = 1) => +v.toFixed(k);
  const cells = st.cells.map((c) => [c.unit, r(c.x), r(c.y), r(c.mass), r(c.boost), r(c.angle, 3), Math.round(st.now - c.born), Math.round(c.mergeAt - st.now)]);
  send(P.chat('/place ' + JSON.stringify({ active: st.active, aim: st.aim.map((a) => ({ x: Math.round(a.x), y: Math.round(a.y) })), cells })));
  placed = st.cells.map((c) => ({ unit: c.unit, x: c.x, y: c.y, mass: c.mass, age: st.now - c.born, mergeIn: c.mergeAt - st.now }));
  placedOver = new Set(mirror.keys());
  active = st.active; aims[0] = { ...st.aim[0] }; aims[1] = { ...st.aim[1] }; splitQueue.fill(0); eatenNext = new Set();
  phase = 'placing'; phaseAt = tick;
}

// The server sends each eaten cell once more, one tick after the eater has grown. Cells our
// one-tick prediction says were just eaten are left out of what the bot plans on.
let eatenNext = new Set();
let thinking = false, lastLog = 0, thinkMax = 0, thinkTicks = 0, lastLogTick = 0;
function think() {
  thinking = false;
  const t = now();
  const units = [0, 1].map((k) => [...mirror.values()].filter((c) => c.unit === k));
  const total = [...mirror.values()].reduce((a, c) => a + c.mass, 0);
  if (!units[0].length && !units[1].length) return;
  // ---- the bot: rebuild the game from what we see, plan, send the inputs ----
  const c0 = [0, 1].map((k) => { let m = 0, x = 0, y = 0; for (const c of units[k]) { m += c.mass; x += c.x * c.mass; y += c.y * c.mass; } return m ? { x: x / m, y: y / m } : { x: 0, y: 0 }; });
  const state = {
    now: t, active, splitQueue: [...splitQueue],
    aim: [aims[0] ?? c0[0], aims[1] ?? c0[1]],
    cells: [...mirror.values()].filter((c) => !eatenNext.has(c.id)).sort((a, b) => a.id - b.id).map((c) => ({ ...c })),
  };
  const g = new Game(state);
  const aim = g.aim.bind(g), split = g.split.bind(g), tab = g.tab.bind(g);
  g.aim = (x, y) => { aim(x, y); aims[active] = { x, y }; send(P.aim(x, y)); };
  g.split = (n) => { split(n); splitQueue[active] += n; send(P.split(n)); };
  g.tab = () => { tab(); active ^= 1; send(P.tab()); };
  const t0 = performance.now(); if (brain instanceof Pipeline) brain.step(g); else brain.act(g, tick);
  { const q = g.clone(); q.step(); const alive = new Set(); for (let k = 0; k < 2; k++) for (const c of q.cells(k)) alive.add(c.id); eatenNext = new Set(state.cells.filter((c) => !alive.has(c.id)).map((c) => c.id)); } thinkMax = Math.max(thinkMax, performance.now() - t0); thinkTicks++;
  if (tick - lastLog >= 125) {
    lastLog = tick;
    const c = g.centre();
    console.log(`t=${(tick * 0.04).toFixed(0)}s  mass ${Math.round(g.mass())}  cells ${g.cells(0).length}/${g.cells(1).length}  at (${Math.round(c.x)}, ${Math.round(c.y)})  played ${thinkTicks}/${tick - lastLogTick} ticks, slowest ${thinkMax.toFixed(0)} ms${brain.late !== undefined ? `, plans late ${brain.late}` : ''}`);
    thinkMax = 0; thinkTicks = 0; lastLogTick = tick;
  }
}
