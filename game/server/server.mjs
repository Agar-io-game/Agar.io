// Senpai Agar recreation server: speaks the LWGA-NANO client protocol over WebSocket and
// serves our own client on the same port, so everything runs offline.
//   npm install && npm start
//   then open http://localhost:2525
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { decodeClient } from '../protocol.mjs';
import { ServerPackets as SP } from './packets.mjs';
import { World, Player, Type } from './world.mjs';
import defaultConfig from './config.mjs';

const TICKS_PER_SECOND = (cfg) => Math.round(1000 / cfg.tickMs);
// Opcode 41 carries i16 coordinates; on an infinite field they are sent divided by this.
const MINIMAP_SCALE = (cfg) => (cfg.infiniteField ? 32 : 1);

// Only these files are served; nothing else on disk is reachable over HTTP.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STATIC = {
  '/': ['client/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['client/index.html', 'text/html; charset=utf-8'],
  '/style.css': ['client/style.css', 'text/css; charset=utf-8'],
  '/game.mjs': ['client/game.mjs', 'text/javascript; charset=utf-8'],
  '/settings.mjs': ['client/settings.mjs', 'text/javascript; charset=utf-8'],
  '/settings-ui.mjs': ['client/settings-ui.mjs', 'text/javascript; charset=utf-8'],
  '/protocol.mjs': ['protocol.mjs', 'text/javascript; charset=utf-8'],
  '/packets.mjs': ['server/packets.mjs', 'text/javascript; charset=utf-8'],
  // The original loads the same renderer: PixiJS 7.4.3 "legacy" build (WebGL, with a Canvas fallback).
  '/lib/pixi-legacy.min.js': ['client/lib/pixi-legacy.min.js', 'text/javascript; charset=utf-8'],
};
async function serveStatic(req, res) {
  const route = STATIC[new URL(req.url, 'http://localhost').pathname];
  if (!route || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found');
  }
  try {
    const body = await readFile(ROOT + route[0]);
    res.writeHead(200, { 'content-type': route[1], 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain' }); res.end('file missing: ' + route[0]);
  }
}

export function createServer(overrides = {}) {
  const cfg = { ...defaultConfig, ...overrides };
  const world = new World(cfg);
  const sessions = new Set();
  const freeIds = [];
  let nextClientId = 2;
  const allocClientId = () => freeIds.pop() ?? ((nextClientId += 2) - 2);

  // Optional simulated ping (config simulatedPingMs, or the Ping/ms slider): half of it
  // is added to everything the client sends, half to everything the server sends, so
  // practising here can feel like playing far from the server.
  const rawSend = (s, bytes) => { if (s.ws.readyState === 1) s.ws.send(bytes); };
  // Simulated ping: everything is held back by exactly pingMs / 2 each way. A plain setTimeout
  // fires late by up to 15.6 ms on Windows, in steps, which bunched frames and shifted inputs
  // between ticks; this queue sleeps until just before each due time, then waits it out
  // precisely (like the tick loop), and keeps the order packets were sent in.
  const delayed = []; let delayTimer = null;
  const later = (ms, fn, ...args) => { delayed.push({ due: performance.now() + ms, fn, args }); if (!delayTimer) pump(); };
  function pump() {
    delayTimer = null;
    const now = performance.now();
    while (delayed.length && delayed[0].due <= now) { const d = delayed.shift(); d.fn(...d.args); }
    if (!delayed.length) return;
    let next = Infinity; for (const d of delayed) if (d.due < next) next = d.due;
    const wait = next - performance.now();
    delayTimer = wait > slack ? setTimeout(pump, wait - slack) : setImmediate(pump);
  }
  const send = (s, bytes) => { const lag = s.pingMs > 0 ? s.pingMs / 2 : 0; if (lag) later(lag, rawSend, s, bytes); else rawSend(s, bytes); };
  const broadcast = (bytes) => { for (const s of sessions) if (s.ready) send(s, bytes); };
  // Field options and bounds; sent on join and again to everyone when Map walls switches the map.
  const sendField = (s) => {
    send(s, SP.options({
      enableTeamChatSeparation: false, enableTeamMapSeparation: false, enableTeamSkinSeparation: false,
      enableDualUnitOperation: true, enableDualSkinInput: true, leaderboardCaption: cfg.serverName,
      // Extensions understood by our client (the original client ignores unknown keys):
      infiniteField: !!cfg.infiniteField, minimapScale: MINIMAP_SCALE(cfg),
    }));
    send(s, SP.fieldBounds(cfg.infiniteField ? { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 } : cfg.field));
  };

  const userInfo = (p) => ({ clientId: p.clientId, name: p.name, team: p.team, skin1: p.skin1, skin2: p.skin2, isBot: p.isBot, teamId: 0, tripKey: '' });
  const colorsOf = (p) => p.units.map((u) => ({ playerId: u.playerId, rgb: u.color }));


  // ---- per-connection protocol --------------------------------------------------------
  function onHandshake(s, msg) {
    if (s.ready) return;
    s.ready = true;
    s.protocol = msg.protocol;
    const p = s.player;
    world.players.set(p.clientId, p);
    send(s, SP.version(`server version: ${cfg.serverName} recreation 0.1`));
    send(s, SP.version('server config signature: recreation'));
    send(s, SP.selfUserId(p.clientId));
    send(s, SP.instruction(`<p><b>${cfg.serverName}</b></p>`)); // kept for the live server's handshake order; the menu no longer shows it
    sendField(s);
    send(s, SP.clearNodes());
    const everyone = [...world.players.values()];
    send(s, SP.userInfos(everyone.map(userInfo)));
    send(s, SP.playerColors(everyone.flatMap(colorsOf)));
    broadcastExcept(s, SP.userInfos([userInfo(p)]));
    broadcastExcept(s, SP.playerColors(colorsOf(p)));
  }
  const broadcastExcept = (skip, bytes) => { for (const o of sessions) if (o !== skip && o.ready) send(o, bytes); };

  function onMessage(s, data) {
    let msg;
    try { msg = decodeClient(new Uint8Array(data)); } catch { return; }
    const p = s.player;
    if (msg.op !== 252 && !s.ready) return;
    switch (msg.op) {
      case 252: onHandshake(s, msg); break;
      case 30: {
        p.name = msg.name.slice(0, 15); p.team = msg.team.slice(0, 15);
        p.skin1 = msg.skin1; p.skin2 = msg.skin2; p.code = msg.code;
        broadcast(SP.userInfos([userInfo(p)]));
        break;
      }
      case 31: if (!p.alive) { p.activeUnit = 0; world.spawnUnit(p.units[0], { ...p.pointer }); } break; // Play: you spawn where your mouse is
      case 1: break; // spectate: nothing to do server-side until the player presses Play
      case 16: {
        p.pointer = { x: msg.x, y: msg.y };
        if (p.alive) p.active.aim = { x: msg.x, y: msg.y };
        break;
      }
      case 25: onAction(p, msg.action, msg.arg); break;
      case 27: p.specTarget = msg.targetPlayerId; break;
      case 130: send(s, SP.latencyReply()); break;
      case 124: {
        if (!msg.text) break;
        if (msg.text.startsWith('/')) { onCommand(s, msg.text); break; }
        broadcast(SP.chat2(msg.channel === 2 ? 2 : 1, p.clientId, msg.text.slice(0, 200)));
        break;
      }
      case 125: onOption(s, msg.text); break; // the menu's Extra options (not chat commands)
      default: break; // 126/127 chat presence, 244/245 echoes: ignored
    }
  }

  function onAction(p, action, arg) {
    if (!p.alive) return;
    const u = p.active;
    switch (action) {
      case 0: world.requestSplit(u, Math.max(1, Math.min(4, arg))); break;   // SPLIT(n): one pass per tick
      case 1: world.requestEject(u); break;                                  // FEED_ONE (next tick)
      case 4: p.feedHold = arg === 1; break;                                 // FEED_HOLD press/release
      case 5: p.frozen = arg === 0; break;                                   // FREEZE: 0 = frozen; both units stop
      case 3: {                                                              // CHANGE_UNIT
        p.activeUnit ^= 1;
        // The second unit spawns on first switch, at the cursor but close to your cells.
        const other = p.units[p.activeUnit];
        if (!other.cells.length) world.spawnSecondUnit(p, other);
        break;
      }
    }
  }

  // Chat command: /mass <n>.
  function onCommand(s, text) {
    const [cmd, arg] = String(text).trim().split(/\s+/);
    const p = s.player;
    if (cmd === '/mass' && p.alive) { // /mass 5000
      const m = Math.max(10, Math.min(60000, Number(arg) || cfg.spawnMass));
      for (const c of p.active.cells) c.mass = m / p.active.cells.length;
    }
  }

  // The settings menu's Extra section: "decay on|off", "walls on|off", "ping <ms>".
  function onOption(s, text) {
    const [opt, arg] = String(text).trim().split(/\s+/);
    const p = s.player;
    if (opt === 'ping') s.pingMs = Math.max(0, Math.min(1000, Number(arg) || 0));
    else if (opt === 'walls') { // on: Caffe's 32000 box with walls; off: infinite
      const on = arg === 'on';
      if (on === cfg.infiniteField) { cfg.infiniteField = !on; for (const t of sessions) if (t.ready) sendField(t); }
    } else if (opt === 'decay') p.noDecay = arg === 'off';
  }

  // ---- per-tick world updates ---------------------------------------------------------
  // Measured on Caffe: the eye it sends (what a spectator's camera follows) is the plain
  // average of the player's cell centres, both units, not weighted by mass.
  const eyeOf = (p) => { let x = 0, y = 0, n = 0; for (const u of p.units) for (const c of u.cells) { x += c.x; y += c.y; n++; } return n ? { x: x / n, y: y / n } : null; };
  function viewFor(p) {
    const c = p.alive ? eyeOf(p) : null;
    if (c) {
      const scale = Math.min(3, Math.max(1, Math.pow(p.mass / cfg.spawnMass, 0.2)));
      const k = scale * cfg.viewRangeMultiplier;
      return { eye: c, view: { w: cfg.baseView.w * k, h: cfg.baseView.h * k }, aimPlayer: p };
    }
    let target = null;
    if (p.specTarget === 0) target = [...world.players.values()].filter((o) => o.alive).sort((a, b) => b.mass - a.mass)[0];
    else if (p.specTarget > 0) target = world.players.get(p.specTarget & 0xfffe);
    const spec = { w: cfg.spectateView.w * cfg.viewRangeMultiplier, h: cfg.spectateView.h * cfg.viewRangeMultiplier };
    if (target?.alive) return { eye: eyeOf(target), view: spec, aimPlayer: target };
    return { eye: p.pointer, view: spec, aimPlayer: null };
  }

  function updateFor(s) {
    const p = s.player;
    const { eye, view, aimPlayer } = viewFor(p);
    const hw = view.w / 2, hh = view.h / 2;
    const nodes = []; const visible = new Set();
    world.query(eye.x - hw - 600, eye.y - hh - 600, eye.x + hw + 600, eye.y + hh + 600, (c) => {
      const r = c.r;
      if (c.x + r < eye.x - hw || c.x - r > eye.x + hw || c.y + r < eye.y - hh || c.y - r > eye.y + hh) return;
      visible.add(c.id);
      nodes.push({ id: c.id, type: c.type, x: c.x, y: c.y, mass: c.mass, owner: c.owner, color: c.color, boost: c.type === Type.PLAYER ? c.boost : 0, angle: c.angle });
    });
    // Own cells are always included so the client never loses track of them.
    if (p.alive) for (const u of p.units) for (const c of u.cells) if (!visible.has(c.id)) {
      visible.add(c.id); nodes.push({ id: c.id, type: c.type, x: c.x, y: c.y, mass: c.mass, owner: c.owner, boost: c.boost, angle: c.angle });
    }
    // Cells eaten this tick are sent once more where they were (as Caffe does), so they
    // disappear inside the eater one tick after it has grown.
    for (const g of world.ghosts) if (s.visible.has(g.id) && !visible.has(g.id)) {
      visible.add(g.id); nodes.push({ id: g.id, type: g.type, x: g.x, y: g.y, mass: g.mass, owner: g.owner, color: g.color, boost: 0, angle: g.angle });
    }
    const removed = [];
    for (const id of s.visible) if (!visible.has(id)) removed.push(id);
    s.visible = visible;
    const aim = aimPlayer ? {
      playerId: aimPlayer.active.playerId, x: aimPlayer.active.aim.x, y: aimPlayer.active.aim.y,
      splitting: false, score: aimPlayer.mass,
    } : null;
    send(s, SP.worldUpdate({ eye, view, aim, nodes, removed }));
  }

  function hudUpdate() {
    const all = [...world.players.values()];
    const alive = all.filter((p) => p.alive).sort((a, b) => b.mass - a.mass);
    broadcast(SP.leaderboard(alive.slice(0, 10).map((p) => ({ clientId: p.clientId, score: p.mass }))));
    broadcast(SP.minimap(alive.flatMap((p) => p.units.filter((u) => u.cells.length).map((u) => {
      const m = u.mass; let x = 0, y = 0; for (const c of u.cells) { x += c.x * c.mass; y += c.y * c.mass; }
      const k = MINIMAP_SCALE(cfg);
      return { playerId: u.playerId, x: x / m / k, y: y / m / k, mass: m };
    }))));
    const humans = [...sessions].filter((s) => s.ready);
    broadcast(SP.userCounts(humans.filter((s) => s.player.alive).length, all.length, humans.filter((s) => !s.player.alive).length, 50, 'FFA'));
    broadcast(SP.status(`Server fps: ${stats.fps}\r\nAverage load: ${stats.load.toFixed(1)}%\r\nCells: ${world.cells.size}`));
  }

  // ---- loop ---------------------------------------------------------------------------
  const stats = { fps: 0, load: 0, ticks: 0, busy: 0, since: Date.now() };
  let timer = null, lastTick = performance.now(), closed = false;
  function loop() {
    const t0 = Date.now(), p0 = performance.now();
    world.tick(t0);
    for (const s of sessions) if (s.ready) updateFor(s);
    if (world.tickCount % TICKS_PER_SECOND(cfg) === 0) hudUpdate();
    const t1 = Date.now();
    stats.ticks++; stats.busy += performance.now() - p0;
    if (t1 - stats.since >= 1000) {
      stats.fps = stats.ticks; stats.load = (100 * stats.busy) / (t1 - stats.since);
      stats.ticks = 0; stats.busy = 0; stats.since = t1;
    }
    lastTick += cfg.tickMs;
    if (performance.now() - lastTick > 1000) lastTick = performance.now(); // after a long stall, don't race to catch up
    schedule();
  }
  // Ticks must leave every 40 ms on the dot (Caffe: 39.2-41.3 ms). Windows timers only fire
  // to about 15.6 ms, which made ours 31-49 ms apart. So sleep with setTimeout until just
  // before the tick (by the timer's measured slack), then wait the rest with setImmediate.
  let slack = 2;
  function schedule() {
    if (closed) return;
    const wait = lastTick - performance.now();
    if (wait > slack) timer = setTimeout(schedule, wait - slack);
    else if (wait > 0) timer = setImmediate(schedule);
    else loop();
  }
  // Measure how late setTimeout fires on this machine.
  (function probeTimer(n = 0, worst = 0) {
    const t = performance.now();
    setTimeout(() => { const late = performance.now() - t - 1; worst = Math.max(worst, late); if (n < 20) probeTimer(n + 1, worst); else slack = Math.min(20, Math.max(2, Math.ceil(worst) + 1)); }, 1);
  })();

  function attach(wss) {
    wss.on('connection', (ws) => {
      const s = { ws, player: new Player(allocClientId()), ready: false, visible: new Set(), pingMs: cfg.simulatedPingMs || 0 };
      ws.binaryType = 'arraybuffer';
      sessions.add(s);
      ws.on('message', (data, isBinary) => {
        if (!isBinary) return;
        const lag = s.pingMs > 0 ? s.pingMs / 2 : 0;
        if (lag) later(lag, onMessage, s, data); else onMessage(s, data);
      });
      ws.on('close', () => {
        sessions.delete(s);
        const p = s.player;
        for (const u of p.units) for (const c of [...u.cells]) world.remove(c);
        world.players.delete(p.clientId);
        freeIds.push(p.clientId);
        if (s.ready) broadcast(SP.userLeave([p.clientId]));
      });
    });
  }

  return {
    cfg, world, sessions,
    listen(port = cfg.port) {
      const http = createHttpServer(serveStatic);
      const wss = new WebSocketServer({ server: http });
      attach(wss);
      this.http = http; this.wss = wss;
      lastTick = performance.now(); closed = false; loop();
      return new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(port, () => resolve(http.address().port));
      });
    },
    close() {
      closed = true; clearTimeout(timer); clearImmediate(timer); clearTimeout(delayTimer); clearImmediate(delayTimer); delayed.length = 0;
      for (const s of sessions) s.ws.terminate();
      return new Promise((r) => { if (!this.http) return r(); this.wss.close(); this.http.close(() => r()); });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer();
  server.listen().then((port) => {
    console.log(`recreation server running`);
    console.log(`  play:  http://localhost:${port}`);
  }, (err) => {
    console.error(err.code === 'EADDRINUSE' ? `port ${server.cfg.port} is already in use (is the server already running?)` : err);
    process.exit(1);
  });
}
