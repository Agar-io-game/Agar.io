// Bot v3 in your game: it joins the running server as an ordinary client and split-runs with
// two units, using only what a player has: the cursor, split, double split, full split, Tab.
// (Never W, never E, never freeze.)
//   in the game chat:  /bot v3        (and /bot stop)
//   or by hand:        node bot/v3/live.mjs [ws://localhost:2525] [--goal <degrees>] [--name v3] [--at x,y]
// Press Spectate and click it to watch.
//
// On join it switches Mass decay OFF and Map walls OFF, spawns, and puts its cells at start
// position 1 (recordings/positions/, scaled to 35,000 mass) with the /place command, turned to
// its course (--goal, default 0 = east). If it ever loses a unit, it loads the next start
// position (1, 2, 3, 4, 1, ...) where it is, on the next tick.
//
// Each tick it keeps its own exact copy of the game (sim.mjs) in step with what the server
// sends: positions come from the server, masses and merge timers from its own bookkeeping
// (the server only sends masses rounded to whole numbers). It thinks about each press three
// ticks ahead, on the position it predicts for that tick, so the keys go out on time.
import { ServerDecoder } from '../../protocol.mjs';
import { Writer } from '../../server/packets.mjs';
import config from '../../server/config.mjs';
import { Sim, CAP, LAYOUT as L } from './sim.mjs';
import { Brain } from './brain.mjs';
import { Net } from './net.mjs';
import { place, STARTS, TOTAL_MASS } from './starts.mjs';
import { loadParams, NET_FILE } from './evaluate.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const url = args.find((a) => a.startsWith('ws')) ?? 'ws://localhost:2525';
const goalAngle = (Number(opt('--goal', 0)) * Math.PI) / 180;
const name = opt('--name', 'v3');
const [atX, atY] = String(opt('--at', '0,0')).split(',').map(Number);
const LEAD = 3;          // ticks a press is thought about ahead of time
const TICK = config.tickMs;
const mergeMs = (mass) => (config.recombineBaseSec + config.recombineMassFactor * mass) * 1000;

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

const net = Net.load(NET_FILE);
const brain = new Brain(loadParams(), goalAngle, net);
console.log(net ? 'playing with the trained value network (bot/v3/data/value.json)' : 'no bot/v3/data/value.json yet (run node bot/v3/train.mjs): playing without the network');

const ws = new WebSocket(url); ws.binaryType = 'arraybuffer';
const send = (b) => { if (ws.readyState === 1) ws.send(b); };
const dec = new ServerDecoder();

let me = -1, tick = 0, phase = 'join', phaseAt = 0;
let posIndex = 0, resets = 0, placeTries = 0;
const model = new Sim(), ahead = new Sim();
let have = false;            // model holds a position
let prevIds = new Set();     // ids in the model before its last tick (to tell eaten cells the server still sends once)
const stats = { resyncs: 0, late: 0, thinkMax: 0, presses: 0, tabs: 0, since: 0, x0: null };

ws.onopen = () => { send(P.handshake()); send(P.entry()); send(P.option('decay off')); send(P.option('walls off')); console.log(`connected to ${url}`); };
ws.onclose = () => { console.log('disconnected'); process.exit(0); };
ws.onerror = () => { console.error(`cannot connect to ${url}: is the server running? (cd server && npm start)`); process.exit(1); };
ws.onmessage = (ev) => {
  let m; try { m = dec.decode(new Uint8Array(ev.data)); } catch { return; }
  if (m.op === 43) me = m.selfUserId;
  if (m.op === 15) onUpdate(m);
};

// My cells in a server update, per unit, oldest first (ids go up with age: the split order).
function mine(u) {
  const units = [[], []];
  for (const n of u.nodes) if (n.type === 0 && (n.owner & 0xfffe) === me) units[n.owner & 1].push(n);
  for (const cs of units) cs.sort((a, b) => a.nodeId - b.nodeId);
  return units;
}

// Brings the model in line with the server's update. Returns false if the model had to be
// rebuilt from the update (the server and the model disagreed about who was eaten or split).
function sync(units) {
  const d = model.d, F = L.F;
  // cells the model saw eaten on this tick are sent once more by the server: leave them out
  const nowIds = new Set(); for (let k = 0; k < 2; k++) for (const c of model.cells(k)) nowIds.add(c.id);
  const live = units.map((cs) => cs.filter((n) => !(prevIds.has(n.nodeId) && !nowIds.has(n.nodeId))));
  let ok = have;
  for (let k = 0; k < 2 && ok; k++) {
    if (live[k].length !== model.n(k)) { ok = false; break; }
    for (let j = 0; j < live[k].length; j++) if (Math.abs(live[k][j].mass - d[(k * CAP + j) * F + L.M]) > 1) { ok = false; break; }
  }
  if (ok) { // same cells: take the server's positions and flight, keep our masses and timers
    for (let k = 0; k < 2; k++) for (let j = 0; j < live[k].length; j++) {
      const n = live[k][j], o = (k * CAP + j) * F;
      d[o + L.X] = n.x; d[o + L.Y] = n.y; d[o + L.ID] = n.nodeId;
      const b = n.motionSpeed ?? 0;
      if (b > 0) { d[o + L.B] = b; d[o + L.A] = n.motionAngle; d[o + L.C] = Math.cos(n.motionAngle); d[o + L.S] = Math.sin(n.motionAngle); } else d[o + L.B] = 0;
    }
    return true;
  }
  // Rebuild from the update. Timers: kept for cells we know that have not halved; a new or
  // halved cell has just split. A cell lying inside a bigger cell of the other unit while the
  // masses add up to more than we have is one the server shows once more after it was eaten.
  const known = new Map(); for (let k = 0; k < 2; k++) for (const c of model.cells(k)) known.set(c.id, c);
  const now = model.now;
  let all = [...units[0], ...units[1]];
  let sum = all.reduce((a, n) => a + n.mass, 0);
  if (sum > TOTAL_MASS + 20) {
    const inside = (b) => all.some((a) => (a.owner & 1) !== (b.owner & 1) && a.mass >= b.mass * 1.25 && Math.hypot(a.x - b.x, a.y - b.y) <= Math.sqrt(100 * a.mass));
    for (const b of [...all].sort((p, q) => q.mass - p.mass)) { if (sum <= TOTAL_MASS + 20) break; if (b.mass <= sum - TOTAL_MASS + 20 && inside(b)) { all = all.filter((n) => n !== b); sum -= b.mass; } }
  }
  const cells = all.map((n) => {
    const old = known.get(n.nodeId), same = old && n.mass >= old.mass * 0.75;
    return { id: n.nodeId, unit: n.owner & 1, x: n.x, y: n.y, mass: same && Math.abs(old.mass - n.mass) <= 1 ? old.mass : n.mass, boost: n.motionSpeed ?? 0, angle: n.motionAngle ?? 0,
      born: same ? old.born : now, mergeAt: same ? old.mergeAt : now + mergeMs(n.mass) };
  });
  const st = { now, active: have ? model.active : 0, aim: have ? [model.aimOf(0), model.aimOf(1)] : null, splitQueue: have ? [model.queue(0), model.queue(1)] : [0, 0], cells };
  const by = [0, 1].map((k) => cells.filter((c) => c.unit === k));
  if (by[0].length > CAP || by[1].length > CAP) return false;
  if (by[st.active].length === 0 && by[st.active ^ 1].length) st.active ^= 1; // the server hands control to the unit that is left
  model.reload(st); have = true;
  return false;
}

function onUpdate(u) {
  tick++;
  const units = mine(u);
  if (phase === 'join') { if (me >= 0) { send(P.aim(atX || 0, atY || 0)); send(P.play()); phase = 'spawn'; phaseAt = tick; } return; }
  if (phase === 'spawn') { if (units[0].length) startAt({ x: units[0][0].x, y: units[0][0].y }); return; }
  if (!units[0].length && !units[1].length) { if (tick - phaseAt > 50) { console.log('no cells: spawning again'); phase = 'join'; have = false; } return; }
  if (phase === 'placing') {
    // wait until the placed cells are there (new ids, both units)
    const fresh = [...units[0], ...units[1]].every((n) => !placedOver.has(n.nodeId));
    if (!(fresh && units[0].length && units[1].length)) {
      if (tick - phaseAt > 50) { if (++placeTries === 2) console.log('the server does not place the cells: restart it (cd server && npm start) so it has the /place command'); startAt(centreOf(units)); }
      return;
    }
    placeTries = 0; phase = 'run';
    console.log(`${resets ? `lost a unit (${resets}): now at start position ${posIndex + 1}` : `running from start position ${posIndex + 1}`}, heading ${Math.round(goalAngle * 180 / Math.PI)} deg`);
  }
  const inStep = sync(units);
  if (!inStep) { stats.resyncs++; brain.planned = null; }
  // A lost unit is never played on: the next start position, here, now.
  if (model.lost) { resets++; posIndex = (posIndex + 1) % STARTS.length; startAt(centreOf(units)); return; }

  // ---- the keys of this tick ----
  const t0 = performance.now();
  const hadPlan = brain.planned?.tick === tick;
  const cmds = brain.act(model, tick);
  for (const c of cmds) {
    if (c[0] === 'aim') { send(P.aim(c[1], c[2])); model.aim(c[1], c[2]); }
    else if (c[0] === 'tab') { send(P.tab()); model.tab(); stats.tabs++; }
    else if (c[0] === 'split') { send(P.split(c[1])); model.split(c[1]); stats.presses++; if (!hadPlan) stats.late++; }
  }
  // ---- what the server will send next ----
  prevIds = new Set(); for (let k = 0; k < 2; k++) for (const c of model.cells(k)) prevIds.add(c.id);
  model.tick();
  // ---- think about the next press ahead of time, on the position predicted for its tick ----
  if (!brain.planned && brain.nextPress - tick === LEAD && !model.lost) {
    ahead.copyFrom(model);
    for (let i = 1; i < LEAD; i++) ahead.tick();
    if (!ahead.lost) brain.prethink(ahead, brain.nextPress);
  }
  const ms = performance.now() - t0; if (ms > stats.thinkMax) stats.thinkMax = ms;
  report();
}

const centreOf = (units) => { let m = 0, x = 0, y = 0; for (const cs of units) for (const c of cs) { m += c.mass; x += c.x * c.mass; y += c.y * c.mass; } return m ? { x: x / m, y: y / m } : { x: atX || 0, y: atY || 0 }; };

// Puts start position `posIndex` on the field with /place, its mass centre at `at`.
let placedOver = new Set();
function startAt(at) {
  const st = place(posIndex, { at, angle: goalAngle, now: model.now });
  const r = (v, k = 1) => +v.toFixed(k);
  for (const c of st.cells) { c.x = r(c.x); c.y = r(c.y); c.mass = r(c.mass); c.angle = r(c.angle, 3); }
  for (const a of st.aim) { a.x = Math.round(a.x); a.y = Math.round(a.y); }
  const cells = st.cells.map((c) => [c.unit, c.x, c.y, c.mass, 0, c.angle, Math.round(st.now - c.born), Math.round(c.mergeAt - st.now)]);
  send(P.chat('/place ' + JSON.stringify({ active: st.active, aim: st.aim, cells })));
  placedOver = new Set(); for (let k = 0; k < 2; k++) for (const c of model.cells(k)) placedOver.add(c.id);
  model.reload(st); have = true; prevIds = new Set();
  model.tick(); // the server moves the placed cells once before it sends them
  brain.reset();
  phase = 'placing'; phaseAt = tick;
}

function report() {
  if (tick - stats.since < 250) return;
  const c = model.centre(), secs = (tick - stats.since) * TICK / 1000;
  const along = c.x * Math.cos(goalAngle) + c.y * Math.sin(goalAngle);
  if (stats.x0 != null) console.log(`t=${Math.round(tick * TICK / 1000)}s  ${Math.round((along - stats.x0) / secs)} u/s  ${(stats.presses / secs).toFixed(2)} splits/s  ${(stats.tabs / secs).toFixed(2)} tabs/s  mass ${Math.round(c.m)}  cells ${model.n(0)}/${model.n(1)}  units lost ${resets}  slowest tick ${stats.thinkMax.toFixed(0)} ms  presses decided late ${stats.late}  model rebuilt ${stats.resyncs}x`);
  stats.x0 = along; stats.since = tick; stats.presses = 0; stats.tabs = 0; stats.thinkMax = 0; stats.late = 0; stats.resyncs = 0;
}
