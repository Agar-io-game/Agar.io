// Senpai Agar recreation client. Speaks the LWGA-NANO protocol (PROTOCOL.md) to the server
// that served this page. Draws with PixiJS 7.4.3 on WebGL, the same renderer as the original
// (client/lib/pixi-legacy.min.js, served locally so it works offline).
//
// Behaviour follows the original client (LWGA-NANO 250710A) wherever it was readable:
// camera filter and spawn jump, interpolation modes, the node analyzer that drives the
// mass / split-order / split-indicator markers, keyboard macros, mouse operation, the
// display options.
import { ServerDecoder } from '/protocol.mjs';
import { Writer } from '/packets.mjs';
import {
  settings as cfg, hsvToRgb, cssRgba, cssRgb, rgbOf, alphaOf, FRAME_RATES, hotKeyFromEvent, CELL_DISPLAY, GAME_DISPLAY,
} from '/settings.mjs';
import { buildSettingsPanel, isCapturingKey } from '/settings-ui.mjs';

// ---------- math helpers (same definitions as the original's Nums) --------------------------
const MapTo = (v, a, b) => v * (b - a) + a;
const Lerp = (a, b, t) => (1 - t) * a + t * b;
const EasyFilter = (cur, target, k) => k * cur + (1 - k) * target;
const Clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const VMap = (v, a, b, c, d, clamp = false) => { const r = ((v - a) * (d - c)) / (b - a) + c; return clamp ? Clamp(r, Math.min(c, d), Math.max(c, d)) : r; };
const massToRadius = (m) => Math.sqrt(100 * m);
const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
function linePointDist(x0, y0, x1, y1, px, py) {
  const vx = x1 - x0, vy = y1 - y0, wx = px - x0, wy = py - y0;
  if (vx * wx + vy * wy < 0) return Math.hypot(wx, wy);
  const ux = px - x1, uy = py - y1;
  if (-vx * ux + -vy * uy < 0) return Math.hypot(ux, uy);
  return Math.abs(vx * wy - vy * wx) / Math.hypot(vx, vy);
}
const hhmm = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

const Type = { PLAYER: 0, PELLET: 1, VIRUS: 2, FOOD: 3 };
const Action = { SPLIT: 0, FEED_ONE: 1, CHANGE_UNIT: 3, FEED_HOLD: 4, FREEZE: 5 };
const FALLBACK_TEAM = { name: '', color: 0xffffff };

// ---------- DOM ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
let canvas = $('game'); // drawn by PixiJS (WebGL), see the rendering section
const mini = $('minimap'), mctx = mini.getContext('2d');
const ui = {
  root: $('page-root'), menu: $('menu'), settings: $('settings'),
  name: $('in-name'), team: $('in-team'), skin: $('in-skin'), skin2: $('in-skin2'),
  play: $('btn-play'), spec: $('btn-spec'), openSettings: $('btn-settings'),
  score: $('score'), max: $('max'), cells: $('cells'), spec2: $('spec-target'),
  lb: $('leaderboard'), lbTitle: $('lb-title'), lbList: $('lb-list'),
  stats: $('stats'), fps: $('st-fps'), nodes: $('st-nodes'), lat: $('st-lat'), server: $('st-server'),
  chat: $('chat'), chatLog: $('chat-log'), chatInput: $('chat-input'), log: $('player-log'),
  toast: $('toast'),
};

// ---------- state ---------------------------------------------------------------------------
const G = {
  ws: null, dec: null, connected: false,
  selfId: -1, users: new Map(), colors: new Map(), teams: new Map(),
  nodes: new Map(), selfNodeIds: [[], []], activeSelfPlayerId: -1,
  bounds: { minX: 0, minY: 0, maxX: 32000, maxY: 32000 }, infinite: false, minimapScale: 1, options: {},
  serverEye: { x: 0, y: 0 },
  isPlaying: false, isDeadSpectation: false, isSuspend: false,
  score: 0, maxScore: 0, splitNum: 0, specScore: 0,
  latency: null, pingSentAt: 0, leaderboard: [], minimap: [],
  updateCount: 0, teamCircle: null, eatingLimitList: [], largestOwn: null,
};
const sight = {
  initDone: false, eyeX: 0, eyeY: 0, eyeScale: 0.08, eyeScale1: 0.08, eyeX1: 0, eyeY1: 0,
  mouseX: innerWidth / 2, mouseY: innerHeight / 2, aimCursorX: 0, aimCursorY: 0, aimXSent: null, aimYSent: null,
  aimPlayerId: -1, splitting: false, spawned: false, jumpTick: 0, eyeX2: 0, eyeY2: 0, tick: 0,
  scw: innerWidth, sch: innerHeight,
};
let aimLock = 0;          // the original's "u0": while set, the periodic aim update is suppressed
let lastSpecTarget = -1;  // the original's "qx", for Keep Last Spectation
let lineSplitTimer = null;

// ---------- persistence of the entry form -------------------------------------------------
const store = { get: (k, d = '') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* */ } } };
ui.name.value = store.get('rec_name'); ui.team.value = store.get('rec_team'); ui.skin.value = store.get('rec_skin'); ui.skin2.value = store.get('rec_skin2');
let envSig = store.get('rec_envsig'); if (!envSig) { envSig = Math.random().toString(36).slice(2, 8); store.set('rec_envsig', envSig); }

// ---------- outgoing packets -------------------------------------------------------------------
const P = {
  handshake: () => new Writer().u8(252).strEx('lwga-111').strEx(envSig).strEx('local-recreation').bytes,
  entry: (name, team, skin1, code, skin2) => new Writer().u8(30).strEx(name).strEx(team).strEx(skin1).strEx(code).strEx(skin2).bytes,
  spectate: () => new Writer().u8(1).bytes,
  play: () => new Writer().u8(31).bytes,
  aim: (x, y) => new Writer().u8(16).i32(x).i32(y).bytes,
  action: (a, arg) => new Writer().u8(25).u8(a).u8(arg & 255).bytes,
  specTarget: (id) => new Writer().u8(27).i32(id).bytes,
  ping: () => new Writer().u8(130).bytes,
  chat: (text) => new Writer().u8(124).u8(1).strUtf8(text).bytes,
  command: (text) => new Writer().u8(125).strUtf8(text).bytes,
  op: (code) => new Writer().u8(code).bytes,
};
const send = (bytes) => { if (G.ws && G.ws.readyState === 1) G.ws.send(bytes); };
const sendAction = (a, arg) => send(P.action(a, arg));
const sendSplit = (n) => { if (!G.isPlaying) return; sight.splitting = true; sendAction(Action.SPLIT, n); };
// The original's B(): send the aim right now, from the current mouse position.
function aimNow() {
  const [x, y] = screenToWorld(sight.mouseX, sight.mouseY).map(Math.round);
  send(P.aim(x, y)); sight.aimXSent = x; sight.aimYSent = y;
}

// ---------- connection -------------------------------------------------------------------------
function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
  ws.binaryType = 'arraybuffer';
  G.ws = ws; G.dec = new ServerDecoder();
  setConn('connecting…');
  ws.onopen = () => { G.connected = true; setConn('connected', 'ok'); send(P.handshake()); sendEntry(true); send(P.spectate()); sendDecay(); sendWalls(); sentPing = null; sendPing(); };
  ws.onmessage = (e) => onServerFrame(e.data);
  ws.onclose = () => {
    G.connected = false; resetWorld(); G.isPlaying = false; sight.initDone = false;
    setConn('disconnected — retrying…', 'bad'); showMenu(true); setTimeout(connect, 2000);
  };
}
// The Extra options (Settings > Game Display > Extra), sent to this server as options.
const sendDecay = () => send(P.command(`decay ${cfg.get('MassDecay') ? 'on' : 'off'}`));
cfg.on('MassDecay', sendDecay); cfg.on('*', sendDecay);
const sendWalls = () => send(P.command(`walls ${cfg.get('MapWalls') ? 'on' : 'off'}`));
cfg.on('MapWalls', sendWalls); cfg.on('*', sendWalls);
let sentPing = null;
// Ping/ms (Extra): the server holds every packet back by half of it each way.
const sendPing = () => { const v = Math.round(Number(cfg.get('SimulatedPing')) || 0); if (v === sentPing) return; sentPing = v; send(P.command(`ping ${v}`)); };
cfg.on('SimulatedPing', sendPing); cfg.on('*', sendPing);
function setConn() {} // (the connection line was removed from the main menu)

let entrySent = '';
function sendEntry(force = false) {
  const team = ui.team.value.trim().slice(0, 15);
  const name = ui.name.value.trim().slice(0, Math.max(0, 15 - team.length)); // the original's TrimNameAndTeamName
  const skin1 = ui.skin.value.trim(), skin2 = ui.skin2.value.trim();
  store.set('rec_name', ui.name.value.trim()); store.set('rec_team', team); store.set('rec_skin', skin1); store.set('rec_skin2', skin2);
  const sig = [name, team, skin1, skin2].join('\u0001');
  if (!force && sig === entrySent) return;
  entrySent = sig; send(P.entry(name, team, skin1, '', skin2));
}

// ---------- incoming packets (the original's DecodeFrame) --------------------------------------
function onServerFrame(data) {
  applyPacket(data);
}

function applyPacket(data) {
  let m; try { m = G.dec.decode(data); } catch (e) { console.warn('bad packet', e); return; }
  switch (m.op) {
    case 43: G.selfId = m.selfUserId; break;
    case 65: G.bounds = m.bounds; initSight(); break;
    case 42:
      for (const u of m.users) {
        const known = G.users.has(u.clientId); G.users.set(u.clientId, u);
        if (!known && u.clientId !== G.selfId) playerLog(`${displayName(u) || 'unnamed'} joined`);
      }
      break;
    case 45: for (const id of m.leftClientIds) { const u = G.users.get(id); if (u) playerLog(`${displayName(u) || 'unnamed'} left`); G.users.delete(id); } break;
    case 39: for (const c of m.colors) G.colors.set(c.playerId, c.rgb); break;
    case 36: for (const t of m.teams) G.teams.set(t.teamId, { name: t.name, color: htmlColor(t.colorHtml) }); break;
    case 35: for (const id of m.removedTeamIds) G.teams.delete(id); break;
    case 18: clearNodes(); syncAnalysis(); break;
    case 15: worldUpdate(m); break;
    case 47: G.leaderboard = m.entries; renderLeaderboard(); break;
    case 41: G.minimap = m.players.map((p) => ({ ...p, x: p.x * G.minimapScale, y: p.y * G.minimapScale })); break;
    case 128: addChat(nameOfClient(m.clientId), m.text); break;
    case 123: addChat(m.channel === 4 ? 'SERVER' : nameOfClient(m.clientId), m.text, m.channel === 4); break;
    case 120: case 121: { const u = G.users.get(m.clientId); if (u) u.enableChat = m.op === 120; break; }
    case 122: { const u = G.users.get(m.clientId); if (u) u.profileComment = m.comment; break; }
    case 131: G.latency = Math.round(performance.now() - G.pingSentAt); break;
    case 133: console.log(m.version); break;
    case 200:
      G.options = m.options;
      if (m.options.leaderboardCaption) ui.lbTitle.textContent = m.options.leaderboardCaption;
      G.infinite = !!m.options.infiniteField; G.minimapScale = m.options.minimapScale || 1;
      break;
    case 202: toast(m.text); break;
    case 203: ui.server.textContent = m.text; break;
    case 19: G.teamCircle = { ...m.circle, t: Date.now() }; break;
    case 244: case 245: send(P.op(m.op)); break;
    case 246: toast('Server is full. Please try again later.'); break;
  }
}

function initSight() {
  if (sight.initDone) return;
  const cx = G.infinite ? 0 : (G.bounds.minX + G.bounds.maxX) / 2, cy = G.infinite ? 0 : (G.bounds.minY + G.bounds.maxY) / 2;
  Object.assign(sight, { eyeX: cx, eyeY: cy, eyeX1: cx, eyeY1: cy, eyeScale: 0.08, eyeScale1: 0.08, aimCursorX: cx, aimCursorY: cy, aimPlayerId: -1, initDone: true });
}

function worldUpdate(m) {
  G.updateCount++;
  const now = performance.now();
  G.lastUpdateAt = now;
  G.serverEye = m.eye;
  if (m.aim) {
    const H = m.aim.playerId, owner = H & 0xfffe;
    if (owner !== G.selfId) { sight.aimPlayerId = H; sight.aimCursorX = m.aim.x; sight.aimCursorY = m.aim.y; sight.splitting = m.aim.splitting; }
    else sight.aimPlayerId = H;
    if (!G.isPlaying) G.specScore = m.aim.score;
    if (owner === G.selfId) G.activeSelfPlayerId = H;
  } else { sight.aimPlayerId = -1; G.activeSelfPlayerId = -1; }
  for (const n of m.nodes) postNode(n, now);
  for (const id of m.removed) removeNode(id);
  syncAnalysis();
}

function postNode(n, now) {
  let c = G.nodes.get(n.nodeId), spawned = false;
  const r = massToRadius(n.mass);
  if (!c) {
    c = { id: n.nodeId, type: n.type, owner: n.owner, birth: G.updateCount, mass: n.mass,
      x: n.x, y: n.y, r, ox: n.x, oy: n.y, or: r, nx: n.x, ny: n.y, nr: r, x0: n.x, y0: n.y, r0: r, x1: n.x, y1: n.y, r1: r,
      updateStamp: now, time: now, vx: 0, vy: 0, angle: 0, speed: 0, speedApplyTime: 0, splitOrderWeight: -1, sizeLevel: -1 };
    G.nodes.set(n.nodeId, c);
    if (n.type === Type.PLAYER && (n.owner & 0xfffe) === G.selfId) {
      const unit = n.owner & 1;
      if (G.selfNodeIds[unit].length === 0) spawned = true; // per unit, as in the original
      G.selfNodeIds[unit].push(n.nodeId); G.selfNodeIds[unit].sort((a, b) => a - b);
    }
  }
  const type = cfg.get('InterpolationType');
  if (type === 1) { linearUpdate(c, now); c.updateStamp = now; c.ox = c.x; c.oy = c.y; c.or = c.r; }
  else if (type === 0) { c.time = now; c.x0 = c.x; c.y0 = c.y; c.r0 = c.r; }
  c.vx = n.x - c.nx; c.vy = n.y - c.ny;
  c.nx = c.x1 = n.x; c.ny = c.y1 = n.y; c.nr = c.r1 = r; c.mass = n.mass; c.type = n.type; c.owner = n.owner;
  if (n.type === Type.PELLET) c.color = n.color;
  c.angle = n.motionAngle ?? 0;
  if (type === 2) { c.speed = ((25 * (n.motionSpeed ?? 0)) / 60) * 0.6; c.speedApplyTime = 50; }
  if (spawned) sight.spawned = true;
}

function removeNode(id) {
  if (!G.nodes.delete(id)) return;
  let wasMine = false;
  for (const u of [0, 1]) { const a = G.selfNodeIds[u], i = a.indexOf(id); if (i >= 0) { a.splice(i, 1); wasMine = true; } }
  if (wasMine && !G.selfNodeIds[0].length && !G.selfNodeIds[1].length) selfUnitsDead();
}
function clearNodes() { G.nodes.clear(); G.selfNodeIds = [[], []]; }
function resetWorld() { clearNodes(); G.users.clear(); G.colors.clear(); G.teams.clear(); }
function linearUpdate(c, t) {
  const A = Clamp((t - c.updateStamp) / MapTo(cfg.get('InterpolationSpeed'), 179, 49), 0, 1);
  c.x = c.ox + (c.nx - c.ox) * A; c.y = c.oy + (c.ny - c.oy) * A; c.r = c.or + (c.nr - c.or) * A;
}

// ---------- the node analyzer (markers) ----------------------------------------------------
const operationUnit = () => (G.activeSelfPlayerId === G.selfId ? 0 : 1);
function syncAnalysis() {
  const nodes = G.nodes;
  const ids = G.selfNodeIds[operationUnit()];
  G.splitNum = ids.length;
  for (const n of nodes.values()) { n.showMark = false; n.canEat = false; n.canEaten = false; n.sizeLevel = -1; }
  G.largestOwn = null;
  if (ids.length) {
    const own = ids.map((id) => nodes.get(id)).filter(Boolean);
    let biggest = own[0]; for (const c of own) if (c.mass > biggest.mass) biggest = c;
    G.largestOwn = biggest;
    // The original sorts by node id when the server is EA-Caffe (by first-seen update elsewhere).
    const order = own.slice().sort((a, b) => a.id - b.id);
    const t = order.length, free = 16 - t; let used = 0;
    order.forEach((c, i) => {
      let w = 0;
      if (used < free) { if (c.mass >= 44) { w = 0; used++; c.canSplit = true; } else { w = 1; c.canSplit = false; } }
      else { w = VMap(i, free, t - 1, 0.4, 1, true); c.canSplit = false; }
      c.splitOrderWeight = w;
    });
    // size levels relative to your biggest cell (the original's thresholds, 1.3 eat ratio)
    const r0 = biggest.mass, k = 1.3;
    const X = 4 * r0 * k, Z = 2 * r0 * k, K = r0 * k, q = r0 / k, e0 = (r0 / 2) * k, a0 = r0 / 2 / k, f0 = r0 / 4 / k, g0 = (r0 / 8) * k, p0 = r0 / 8 / k;
    const light = cfg.get('MarkerLight'), lightLimit = light ? f0 : p0;
    for (const H of nodes.values()) {
      const m = H.mass;
      H.sizeLevel = cfg.get('MarkerExtend')
        ? (m > X ? 0 : m > Z ? 1 : m > K ? 2 : m > q ? 3 : m > e0 ? 4 : m > a0 ? 5 : m > f0 ? 6 : m > g0 ? 7 : m > p0 ? 8 : -1)
        : (m > Z ? 0 : m > K ? 1 : m > q ? 2 : m > a0 ? 3 : m > lightLimit ? 4 : light ? -1 : 5);
    }
    // split line: what each of your cells would hit if it split toward the cursor
    for (const L of own) {
      const V = 0.5 * L.mass * 0.77;
      let ax = sight.aimCursorX - L.nx, ay = sight.aimCursorY - L.ny; const al = Math.hypot(ax, ay) || 1; ax = (ax / al) * 1200; ay = (ay / al) * 1200;
      for (const H of nodes.values()) {
        if (own.includes(H) || Math.abs(H.nx - L.nx) > 1200 || Math.abs(H.ny - L.ny) > 1200) continue;
        if (linePointDist(L.nx, L.ny, L.nx + ax, L.ny + ay, H.nx, H.ny) > L.nr + H.nr) continue;
        H.showMark = true;
        const d = dist(L.nx, L.ny, H.nx, H.ny);
        if (H.mass < V && L.canSplit && d < 720 + L.nr) H.canEat = true;
        if (L === biggest && d < 720 + L.nr && H.mass > 2 * L.mass * 1.3) { H.canEaten = true; H.showMark = true; }
      }
    }
  }
  // eating limits between overlapping player cells of different owners
  G.eatingLimitList = [];
  const players = [];
  for (const n of nodes.values()) if (n.type === Type.PLAYER) players.push(n);
  for (const L of players) for (const H of players) {
    if (L === H || L.owner === H.owner) continue;
    if (Math.abs(L.nx - H.nx) > L.nr + H.nr || Math.abs(L.ny - H.ny) > L.nr + H.nr) continue;
    const big = L.nr > H.nr ? L : H, small = big === L ? H : L;
    if (dist(L.nx, L.ny, H.nx, H.ny) >= big.nr) continue;
    const limit = big.nr - 0.41 * small.nr, canEat = big.mass > 1.3 * small.mass;
    const e = G.eatingLimitList.find((x) => x.eater === big);
    if (e) { if (limit > e.limit) { e.limit = limit; e.eaten = small; } } else G.eatingLimitList.push({ eater: big, eaten: small, limit, canEat });
  }
}

// ---------- names, colours ------------------------------------------------------------------
const displayName = (u) => (u.team || '') + (u.name || '');
const nameOfClient = (id) => { const u = G.users.get(id & 0xfffe); return u ? displayName(u) || (G.options.nameForUnnamedCell || 'unnamed cell') : '?'; };
const teamOf = (u) => (u && G.teams.get(u.teamId)) || FALLBACK_TEAM;
const selfTeam = () => teamOf(G.users.get(G.selfId));
const htmlColor = (s) => (/^#[0-9a-f]{6}$/i.test(s) ? parseInt(s.slice(1), 16) : 0x888888);

// ---------- camera (the original's SightCoord) --------------------------------------------
function screenToWorld(sx, sy) { return [(sx - sight.scw / 2) / sight.eyeScale + sight.eyeX, (sy - sight.sch / 2) / sight.eyeScale + sight.eyeY]; }
function ownCenter() {
  let x = 0, y = 0, m = 0;
  for (const u of [0, 1]) for (const id of G.selfNodeIds[u]) { const c = G.nodes.get(id); if (c) { x += c.nx * c.mass; y += c.ny * c.mass; m += c.mass; } }
  return m ? [x / m, y / m] : null;
}
function updateSight() {
  {
    const [mx, my] = screenToWorld(sight.mouseX, sight.mouseY);
    let tx, ty, k = 0.985 - cfg.get('CameraMovementSpeed') * 0.0005;
    const center = G.isPlaying ? ownCenter() : null;
    if (center) {
      if (sight.spawned) { sight.jumpTick = 2000; sight.eyeX2 = center[0]; sight.eyeY2 = center[1]; sight.spawned = false; }
      if (sight.jumpTick > 0) {
        sight.jumpTick -= 17; const I = VMap(sight.jumpTick, 2000, 0, 0, 1, true);
        tx = Lerp(sight.eyeX2, center[0], I); ty = Lerp(sight.eyeY2, center[1], I); k = Lerp(0.94, 0.986, I);
      } else [tx, ty] = center;
    } else if (sight.aimPlayerId !== -1 && (sight.aimPlayerId & 0xfffe) !== G.selfId) { tx = G.serverEye.x; ty = G.serverEye.y; }
    else { tx = mx; ty = my; }
    sight.eyeX = EasyFilter(sight.eyeX, tx, k); sight.eyeY = EasyFilter(sight.eyeY, ty, k);
    sight.eyeScale = EasyFilter(sight.eyeScale, sight.eyeScale1, 0.86);
  }
  if (!G.infinite) { sight.eyeX = Clamp(sight.eyeX, G.bounds.minX, G.bounds.maxX); sight.eyeY = Clamp(sight.eyeY, G.bounds.minY, G.bounds.maxY); }
  if (G.isPlaying) [sight.aimCursorX, sight.aimCursorY] = screenToWorld(sight.mouseX, sight.mouseY);
  if (sight.tick % 2 === 0) {
    if (!aimLock) {
      const [x, y] = screenToWorld(sight.mouseX, sight.mouseY).map(Math.round);
      if (x !== sight.aimXSent || y !== sight.aimYSent) { send(P.aim(x, y)); sight.aimXSent = x; sight.aimYSent = y; }
    }
  }
  sight.tick++;
}

// ---------- play / death ---------------------------------------------------------------------
function startPlay() {
  if (G.isPlaying) { showMenu(false); return; }
  sendEntry(); send(P.specTarget(-1)); send(P.play());
  G.isPlaying = true; G.isDeadSpectation = false; G.maxScore = 0; showMenu(false);
}
function startSpectate() { sendEntry(); G.isDeadSpectation = false; showMenu(false); }
function selfUnitsDead() {
  aimLock = 0; clearInterval(lineSplitTimer);
  if (!G.isPlaying) return;
  G.isPlaying = false; G.isDeadSpectation = true;
  if (!cfg.get('HideMenuAfterDeath')) showMenu(true);
  setTimeout(() => { send(P.spectate()); if (cfg.get('KeepLastSpectation') && lastSpecTarget !== -1) send(P.specTarget(lastSpecTarget)); }, 40);
}

// ---------- keyboard (the original's KeyboardInputHandler) ----------------------------------
const menuOpen = () => !ui.menu.classList.contains('hidden');
const settingsOpen = () => !ui.settings.classList.contains('hidden');
const typingInField = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);

addEventListener('keydown', (e) => {
  if (isCapturingKey()) return;
  if (e.key === 'Escape') {
    if (settingsOpen()) { closeSettings(); e.preventDefault(); return; }
    if (document.activeElement === ui.chatInput) { ui.chatInput.blur(); ui.chatInput.classList.remove('open'); return; }
    showMenu(!menuOpen()); e.preventDefault(); return;
  }
  if (settingsOpen()) return;
  if (e.key === 'Enter') {
    if (menuOpen()) { if (typingInField()) startPlay(); return; }
    toggleChat(); e.preventDefault(); return;
  }
  if (typingInField()) return;
  if (e.keyCode === 9) e.preventDefault(); // never let Tab move browser focus
  if (e.repeat) return;
  if (keyboardInput(e, true)) e.preventDefault();
});
addEventListener('keyup', (e) => { if (isCapturingKey() || typingInField() || settingsOpen()) return; if (keyboardInput(e, false)) e.preventDefault(); });

// A key's release is matched to the exact combination it was pressed with, so changing
// Shift / Ctrl / Alt while a key is held (or letting go of Alt before S after Alt+S) can't
// leave a hold action stuck or undo a toggle.
const heldCombos = new Map();
function keyboardInput(e, down) {
  if (!sight.initDone) return false;
  let code = hotKeyFromEvent(e);
  if (down) heldCombos.set(e.keyCode, code);
  else if (heldCombos.has(e.keyCode)) { code = heldCombos.get(e.keyCode); heldCombos.delete(e.keyCode); }
  const K = cfg.controls;
  const playing = G.isPlaying;
  {
    // Stop Motion: hold to stop all your cells, both units (as on Caffe). Releasing keeps
    // them stopped if Stop Motion (Toggle) is on.
    if (code === K.hkSuspend) { aimLock = 0; sendAction(Action.FREEZE, down || G.isSuspend ? 0 : 1); return true; }
    if (code === K.hk4xLineSplit) { if (down) lineSplitMode(); return true; }
    if (code === K.hkToggleSuspend) { if (down) { G.isSuspend = !G.isSuspend; sendAction(Action.FREEZE, G.isSuspend ? 0 : 1); } return true; }
    if (playing && code === K.hkFeed) { aimLock = 0; sendAction(Action.FEED_HOLD, down ? 1 : 0); return true; }
    if (code === K.hkDoubleSplit) { aimLock = 0; aimNow(); aimLock = down ? 1 : 0; if (down) sendSplit(2); setTimeout(() => (aimLock = 0), 600); return true; }
    if (code === K.hkTripleSplit || code === K.hkSuperQuadSplit) {
      aimNow(); const was = aimLock; aimLock = down ? 1 : 0;
      sendAction(Action.FREEZE, down ? 0 : 1); if (down && !was) sendSplit(code === K.hkTripleSplit ? 3 : 4); return true;
    }
  }
  let changed = false;
  for (const k of CELL_DISPLAY) if (code === cfg.holdKeys[k]) { cfg.toggle(k); changed = true; }
  if (down) {
    if (code === K.hkStartNewGame) { if (!playing) startPlay(); return true; }
    if (code === K.hkToggelSpectateTarget) { send(P.specTarget(sight.aimPlayerId === -1 ? 0 : -1)); return true; }
    if (playing) {
      if (code === K.hkSplit) { aimLock = 0; aimNow(); sendSplit(1); return true; }
      if (code === K.hkChangeUnit) { clearInterval(lineSplitTimer); sendAction(Action.CHANGE_UNIT, -1); aimNow(); aimLock = 0; return true; }
      if (code === K.hkFeedOne) { sendAction(Action.FEED_ONE, -1); aimLock = 0; return true; }
      if (code === K.hkQuadSplit) { sendSplit(4); return true; }
      if (code === K.hkInfernoSplit) { sendSplit(2); sendAction(Action.CHANGE_UNIT, -1); aimNow(); aimLock = 0; sendSplit(4); return true; }
      if (code === K.hkTestSplit) { sendSplit(4); sendAction(Action.CHANGE_UNIT, -1); aimNow(); aimLock = 0; sendSplit(4); return true; }
    }
    for (const k of [...CELL_DISPLAY, ...GAME_DISPLAY]) if (code === cfg.toggleKeys[k]) { cfg.toggle(k); changed = true; }
  }
  return changed;
}

// 4x Line Split Mode: lock the aim onto your single cell so it stops, then report when ready.
function lineSplitMode() {
  const ids = G.selfNodeIds[operationUnit()];
  if (ids.length !== 1) { aimLock = 0; return; }
  const c = G.nodes.get(ids[0]); if (!c) return;
  const x = Math.round(c.nx), y = Math.round(c.ny);
  if (x !== sight.aimXSent || y !== sight.aimYSent) { send(P.aim(x, y)); sight.aimXSent = x; sight.aimYSent = y; }
  aimLock = aimLock ? 0 : 1;
  clearInterval(lineSplitTimer);
  if (aimLock) lineSplitTimer = setInterval(() => {
    const now = G.nodes.get(ids[0]);
    if (!now || G.selfNodeIds[operationUnit()].length !== 1) { clearInterval(lineSplitTimer); return; }
    if (Math.round(now.nx) === sight.aimXSent && Math.round(now.ny) === sight.aimYSent) {
      setTimeout(() => toast('4x Line Split is available'), 1000); clearInterval(lineSplitTimer);
    }
  }, 35);
}

// ---------- mouse (the original's MouseInputHandler) ----------------------------------------
addEventListener('mousemove', (e) => { sight.mouseX = e.clientX; sight.mouseY = e.clientY; });
addEventListener('mouseup', (e) => { if (!menuOpen() && !settingsOpen()) mouseInput(e.button, false); });
// mousedown, contextmenu and wheel are bound to the game canvas in bindCanvas()

function mouseInput(button, down) {
  let left = 0, right = 2;
  if (down) {
    if (!G.isPlaying) {
      if (button === right) {
        const [wx, wy] = screenToWorld(sight.mouseX, sight.mouseY);
        let target = -1;
        for (const c of G.nodes.values()) if (target === -1 && c.type === Type.PLAYER && dist(c.nx, c.ny, wx, wy) < c.nr) target = c.owner;
        if (target !== -1) { target &= 0xfffe; lastSpecTarget = target; send(P.specTarget(target)); }
      }
      if (button === left) { send(P.specTarget(-1)); if (G.isSuspend) { G.isSuspend = false; sendAction(Action.FREEZE, 1); } }
    }
  }
  if (cfg.get('OperationWithMouseButton')) {
    if (cfg.get('SwapMouseButtons')) { left = 2; right = 0; }
    if (G.isPlaying) {
      if (button === left && down) sendSplit(1); // the original sends no extra aim update here
      else if (button === right) sendAction(Action.FEED_HOLD, down ? 1 : 0);
      else if (button === 1 && down) sendSplit(4);
    }
  }
}
// Losing focus (clicking another window) lets go of held keys, but Stop Motion (Toggle) stays
// on until its hotkey is pressed again.
addEventListener('blur', () => { heldCombos.clear(); if (G.isPlaying) { sendAction(Action.FEED_HOLD, 0); sendAction(Action.FREEZE, G.isSuspend ? 0 : 1); } });

// ---------- UI: menu, settings, chat, log, toast ---------------------------------------------
ui.play.onclick = startPlay;
ui.spec.onclick = startSpectate;
ui.openSettings.onclick = () => ui.settings.classList.remove('hidden');
function closeSettings() { ui.settings.classList.add('hidden'); }
buildSettingsPanel(ui.settings, { onClose: closeSettings });
function showMenu(on) {
  ui.menu.classList.toggle('hidden', !on);
  if (on && !G.isPlaying) setTimeout(() => ui.name.focus(), 0); else if (!on) document.activeElement?.blur?.();
}
function toggleChat() {
  const input = ui.chatInput;
  if (document.activeElement === input) {
    const text = input.value.trim(); input.value = '';
    if (text) send(P.chat(text));
    input.blur(); input.classList.remove('open');
  } else { input.classList.add('open'); input.focus(); }
}
function addChat(name, text, system = false) {
  const div = document.createElement('div'); div.className = 'msg' + (system ? ' sys' : '');
  const t = document.createElement('span'); t.className = 'time'; t.textContent = hhmm() + ' ';
  const b = document.createElement('b'); b.textContent = name + ': ';
  const m = document.createElement('span'); m.className = 'text'; m.textContent = text;
  div.append(t, b, m); ui.chatLog.append(div);
  while (ui.chatLog.children.length > 14) ui.chatLog.firstChild.remove();
}
function playerLog(text) {
  if (!cfg.get('ShowPlayerLog')) return;
  const d = document.createElement('div'); d.textContent = `${hhmm()} ${text}`; ui.log.append(d);
  while (ui.log.children.length > 6) ui.log.firstChild.remove();
  setTimeout(() => d.remove(), 15000);
}
let toastTimer = null;
function toast(text) { ui.toast.textContent = text; ui.toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 2500); }

const fmtK = (v) => (v / 1000).toFixed(1) + 'k';
const fmtMass = (m) => (m < 1000 || !cfg.get('SimplifiedMass') ? String(Math.round(m)) : ((m / 100) >> 0) / 10 + 'K');
function renderLeaderboard() {
  const showMass = G.options.showPlayerMassInLeaderBoard !== false;
  ui.lbList.replaceChildren(...G.leaderboard.map((e, i) => {
    const li = document.createElement('li'); if (e.clientId === G.selfId) li.className = 'me';
    li.textContent = `${i + 1}. ${nameOfClient(e.clientId)}`;
    if (showMass) { const m = document.createElement('span'); m.className = 'm'; m.textContent = fmtK(e.score); li.append(m); }
    return li;
  }));
}

// Settings that change the page itself.
function applyPageSettings() {
  const set = (v, k) => ui.root.style.setProperty(v, cssRgba(cfg.color(k)));
  set('--game-bg', 'clGameBackground'); set('--game-fg', 'clGameForeground');
  set('--lb-back', 'clLeaderboardBack'); set('--lb-header', 'clLeaderboardHeader'); set('--map-back', 'clMapBackground');
  set('--chat-back', 'clChatBackground'); set('--chat-name', 'clChatSenderName'); set('--chat-msg', 'clChatMessage'); set('--chat-time', 'clChatTimeString');
  set('--panel-back', 'clMainPanelBack'); set('--panel-fg', 'clPanelForeground'); set('--panel-header', 'clPanelHeader');
  set('--main-buttons', 'clMainButtons'); set('--menu-buttons', 'clMenuButtons'); set('--button-active', 'clUiButtonActive');
  set('--overlay-back', 'clOverlayBack'); set('--ui-symbols', 'clUiSymbols');
  const panelImg = cfg.get('panelBackImageUri');
  ui.root.style.setProperty('--panel-image', panelImg ? `url("${panelImg.replace(/"/g, '%22')}")` : 'none');
  ui.root.style.setProperty('--panel-image-alpha', cfg.get('panelBackImageAlpha'));
  ui.lb.hidden = !cfg.get('ShowLeaderboard');
  mini.hidden = !cfg.get('ShowMap');
  ui.chat.hidden = !cfg.get('ShowChatBox');
  ui.stats.classList.toggle('no-client', !cfg.get('ShowClientStatus'));
  ui.server.hidden = !cfg.get('ShowServerStatus');
  resize();
}
cfg.on('*', applyPageSettings);

// ---------- rendering -----------------------------------------------------------------------
function resize() {
  sight.scw = innerWidth; sight.sch = innerHeight;
  if (!renderer) return;
  createRenderer(); // a no-op unless the Antialias option changed
  const res = cfg.get('Resolution');
  if (renderer.resolution !== res) renderer.resolution = res;
  renderer.resize(innerWidth, innerHeight);
}
addEventListener('resize', resize);

const imageCache = new Map();
function image(url) {
  if (!url || !/^(https?:|data:image\/|blob:)/i.test(url)) return null;
  let img = imageCache.get(url);
  if (!img) { img = new Image(); img.crossOrigin = 'anonymous'; img.src = url; imageCache.set(url, img); }
  return img.complete && img.naturalWidth ? img : null;
}

const FONT_NEW_NAME = 'Sawarabi Mincho, Shippori Mincho, Mina, "Gothic A1", "Do Hyeon", "Noto Sans", "Titillium Web", sans-serif';
const FONT_NEW_MASS = '"Gothic A1", "Titillium Web", sans-serif';
const FONT_OLD = 'Meiryo, Arial, sans-serif';

function interpolate(now, dt) {
  const type = cfg.get('InterpolationType'), speed = cfg.get('InterpolationSpeed');
  const clock = performance.now(); // Classic reads the plain clock: the original applies RenderingTimeOffset to Linear only
  G.lastInterp = { now, clock, dt };
  for (const c of G.nodes.values()) {
    if (type === 2) {
      const F = MapTo(speed, 0.9, 0.5);
      c.x = EasyFilter(c.x, c.x1, F); c.y = EasyFilter(c.y, c.y1, F); c.r = EasyFilter(c.r, c.r1, F);
      c.speedApplyTime -= dt; if (c.speedApplyTime <= 0) c.speed = 0;
      // the original stops the motion lead when the target touches the field border
      const b = G.bounds, size = b.maxX - b.minX, rr = massToRadius(c.mass);
      if (!(c.x1 - b.minX >= rr && c.x1 - b.minX <= size - rr && c.y1 - b.minY >= rr && c.y1 - b.minY <= size - rr)) c.speed = 0;
      c.x1 += Math.cos(c.angle) * c.speed; c.y1 += Math.sin(c.angle) * c.speed;
    } else if (type === 1) linearUpdate(c, now);
    else {
      const R = Clamp((clock - c.time) / MapTo(speed, 120, 40), 0, 1);
      c.x = Lerp(c.x0, c.x1, R); c.y = Lerp(c.y0, c.y1, R); c.r = Lerp(c.r0, c.r1, R);
    }
  }
}

function viewRect() {
  const z = sight.eyeScale;
  return [sight.eyeX - sight.scw / 2 / z, sight.eyeY - sight.sch / 2 / z, sight.eyeX + sight.scw / 2 / z, sight.eyeY + sight.sch / 2 / z];
}

// ---------- rendering: PixiJS 7.4.3 on WebGL, built like the original's scene ---------------
// The original loads pixi-legacy 7.4.3 and draws the field with a WebGL renderer on a
// transparent background, so the page colour (Game Background) shows through. Its scene,
// read from the live client:
//   stage > world (scaled by the zoom, moved by the camera) > [ background | cells | overlay ]
//   background: field wallpaper sprite, the sector grid (lines plus A1..E5 labels) in a
//               container whose alpha is the coords colour's alpha, and the field border as a
//               pre-rendered glowing texture drawn with SCREEN blending
//   cells: one container per cell scaled to its radius, holding
//          - a white disc sprite tinted with the cell colour: GP_BASE_LOW / MEDIUM / HIGH
//            (200 / 400 / 800 px) chosen by Render Quality, pellets always LOW, or the
//            GP_GLOWING_* versions when glowing cells are on
//          - the skin sprite, pre-clipped to a circle
//          - a Graphics for the markers
//          - the name, pre-rendered to its own texture (52 px, stroke 11.5 % of the size)
//          - the mass as a BitmapText (fonts GAMEPLAY_MASS, _C new style, _R reversed, _CR)
//   overlay: one Graphics for cursor lines and the other world overlays
// The minimap and leaderboard chart stay 2D canvases, as in the original.
const PX = window.PIXI;
const LOCAL_R = 200;      // a cell container's local radius: container.scale = r / LOCAL_R
const LABEL_PX = 52;      // the original's label size in local units (0.26 r)
const LABEL_RES = 2;      // names are drawn at twice that and shown at half size, for sharpness
const QUALITY = ['LOW', 'MEDIUM', 'HIGH'];

let renderer = null;
const stage = new PX.Container();
const world = new PX.Container();
const bgLayer = new PX.Container(), cellLayer = new PX.Container(), overlayLayer = new PX.Container();
cellLayer.sortableChildren = true;
stage.addChild(world);
world.addChild(bgLayer, cellLayer, overlayLayer);
const overlay = new PX.Graphics();
overlayLayer.addChild(overlay);

function bindCanvas(el) {
  el.addEventListener('mousedown', (e) => { if (!menuOpen() && !settingsOpen()) mouseInput(e.button, true); });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  // The original: F = wheelDelta / 120 * CameraZoomSpeed / 100, then ShiftScale(F) multiplies
  // the target zoom by 1 + 0.13 F. No rounding and no cap, so touchpads and smooth wheels
  // (many small deltas) zoom as gently as there. Firefox has no wheelDelta, so use -deltaY.
  el.addEventListener('wheel', (e) => {
    if (menuOpen()) return;
    const wheelDelta = typeof e.wheelDelta === 'number' && e.wheelDelta !== 0 ? e.wheelDelta : -e.deltaY * (e.deltaMode === 1 ? 40 : 1.2);
    const F = (wheelDelta / 120) * (cfg.get('CameraZoomSpeed') / 100);
    sight.eyeScale1 = Clamp(sight.eyeScale1 * (1 + 0.13 * F), 0.005, 1.5);
  }, { passive: true });
}

// WebGL fixes antialiasing when the context is created, so changing the Antialias option
// swaps in a fresh canvas and renderer.
let rendererAntialias = null;
function createRenderer() {
  const aa = !!cfg.get('Antialias');
  if (renderer && aa === rendererAntialias) return;
  if (renderer) {
    const fresh = document.createElement('canvas'); fresh.id = canvas.id;
    canvas.replaceWith(fresh); renderer.destroy(false); canvas = fresh;
  }
  rendererAntialias = aa;
  renderer = PX.autoDetectRenderer({
    view: canvas, width: innerWidth, height: innerHeight, resolution: cfg.get('Resolution'), autoDensity: true,
    antialias: aa, backgroundAlpha: 0, powerPreference: 'high-performance',
  });
  bindCanvas(canvas);
}

// ---- generated textures (the original's GP_* textures) ----
function canvasOf(size) { const c = document.createElement('canvas'); c.width = c.height = size; return [c, c.getContext('2d')]; }
function discCanvas(size) {
  const [c, g] = canvasOf(size);
  g.fillStyle = '#fff'; g.beginPath(); g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); g.fill();
  return c;
}
function glowCanvas(size, discR, blur) {
  const [c, g] = canvasOf(size);
  g.shadowColor = '#fff'; g.shadowBlur = blur; g.fillStyle = '#fff';
  g.beginPath(); g.arc(size / 2, size / 2, discR, 0, Math.PI * 2); g.fill();
  return c;
}
function pelletGlowCanvas() { // measured: a 75 % disc with a long faint halo out to about 4 radii
  const [c, g] = canvasOf(1000), m = 500;
  const halo = g.createRadialGradient(m, m, 100, m, m, 400);
  [[0, 0.27], [0.08, 0.25], [0.19, 0.2], [0.29, 0.157], [0.39, 0.11], [0.5, 0.075], [0.6, 0.05], [0.71, 0.027], [0.81, 0.016], [0.92, 0.004], [1, 0]]
    .forEach(([o, a]) => halo.addColorStop(o, `rgba(255,255,255,${a})`));
  g.fillStyle = halo; g.fillRect(0, 0, 1000, 1000);
  g.globalCompositeOperation = 'copy'; g.fillStyle = 'rgba(255,255,255,0.75)';
  g.beginPath(); g.arc(m, m, 100, 0, Math.PI * 2); g.fill();
  return c;
}
const TEX = {};
function buildTextures() {
  const add = (key, cv, discR) => { TEX[key] = { tex: PX.Texture.from(cv), discR }; };
  add('GP_BASE_LOW', discCanvas(200), 100);
  add('GP_BASE_MEDIUM', discCanvas(400), 200);
  add('GP_BASE_HIGH', discCanvas(800), 400);
  add('GP_GLOWING_LOW', glowCanvas(1000, 100, 30), 100);
  add('GP_GLOWING_MEDIUM', glowCanvas(1200, 200, 50), 200);
  add('GP_GLOWING_HIGH', glowCanvas(1600, 400, 80), 400);
  add('GP_GLOWING_PELLET', pelletGlowCanvas(), 100);
}

// ---- mass fonts: 104 px bitmap fonts shown at 52 (glyph widths match bold Arial) ----
function buildMassFonts() {
  const opts = { chars: '0123456789.K', resolution: 1, padding: 4 };
  const base = { fontSize: 104, lineJoin: 'round' };
  const oldFont = { fontFamily: 'Arial, sans-serif', fontWeight: 'bold' };
  const newFont = { fontFamily: FONT_NEW_MASS, fontWeight: '600' };
  PX.BitmapFont.from('GAMEPLAY_MASS', { ...base, ...oldFont, fill: '#ffffff', stroke: '#000000', strokeThickness: 12 }, opts);
  PX.BitmapFont.from('GAMEPLAY_MASS_C', { ...base, ...newFont, fill: '#ffffff', stroke: '#1e2a46', strokeThickness: 11 }, opts);
  PX.BitmapFont.from('GAMEPLAY_MASS_R', { ...base, ...oldFont, fill: '#000000', stroke: '#ffffff', strokeThickness: 14 }, opts);
  PX.BitmapFont.from('GAMEPLAY_MASS_CR', { ...base, ...newFont, fill: '#000000', stroke: '#ffffff', strokeThickness: 13 }, opts);
}

// ---- name textures, cached per text, colour and style ----
const nameCache = new Map();
function cachedTexture(key, make) {
  let e = nameCache.get(key);
  if (!e) { e = make(); nameCache.set(key, e); }
  e.used = performance.now();
  return e.tex;
}
function nameTexture(text, color, newStyle) {
  return cachedTexture(`n|${newStyle ? 1 : 0}|${color}|${text}`, () => {
    const fs = LABEL_PX * LABEL_RES, font = `${newStyle ? 600 : 'bold'} ${fs}px ${newStyle ? FONT_NEW_NAME : FONT_OLD}`;
    const c = document.createElement('canvas'), g = c.getContext('2d');
    g.font = font;
    const sw = fs * 0.115; // the original's stroke: 6 px on 52 px text (half of it shows outside)
    c.width = Math.max(2, Math.min(4096, Math.ceil(g.measureText(text).width + sw * 2 + 8)));
    c.height = Math.ceil(fs * 1.4 + sw * 2);
    g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    g.lineWidth = sw; g.strokeStyle = newStyle ? 'rgba(0,0,0,0.65)' : '#000';
    g.strokeText(text, c.width / 2, c.height / 2);
    g.fillStyle = cssRgb(color); g.fillText(text, c.width / 2, c.height / 2);
    return { tex: PX.Texture.from(c) };
  });
}
function circularNameTexture(text, color) {
  return cachedTexture(`c|${color}|${text}`, () => {
    const R = LOCAL_R * LABEL_RES, size = R * 2 + 8, fs = 0.2 * R, rr = 0.8 * R;
    const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d');
    g.translate(size / 2, size / 2); g.font = `bold ${fs}px ${FONT_OLD}`; g.fillStyle = cssRgb(color); g.strokeStyle = '#000'; g.lineWidth = fs * 0.13;
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    let a = 1.5;
    for (const ch of [...text]) {
      g.save(); g.rotate(a); const w = g.measureText(ch).width; g.strokeText(ch, 0, rr); g.fillText(ch, 0, rr); g.restore();
      const K = 0.4 * w + 0.2 * fs; a -= 2 * Math.atan2(K, Math.sqrt(Math.max(1, rr * rr - K * K)));
    }
    return { tex: PX.Texture.from(c) };
  });
}
function sweepNameCache(now) {
  for (const [k, e] of nameCache) if (now - e.used > 20000) { e.tex.destroy(true); nameCache.delete(k); }
}

// ---- skins: pre-clipped to a circle, like the original's skin textures ----
const skinCache = new Map();
function skinTexture(url, size) {
  const img = image(url); if (!img) return null;
  const key = `${size}|${url}`;
  let tex = skinCache.get(key);
  if (!tex) {
    const [c, g] = canvasOf(size);
    g.beginPath(); g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); g.clip();
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    const s = Math.min(img.width, img.height);
    g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
    tex = PX.Texture.from(c); skinCache.set(key, tex);
  }
  return tex;
}
const imageTextures = new Map();
function imageTexture(url) {
  const img = image(url); if (!img) return null;
  let tex = imageTextures.get(url);
  if (!tex) { tex = PX.Texture.from(img); imageTextures.set(url, tex); }
  return tex;
}

// ---- background: wallpaper, sector grid, border ----
const fieldImg = new PX.Sprite(); fieldImg.anchor.set(0.5);
const fieldMask = new PX.Graphics();
const grid = new PX.Container(), gridLines = new PX.Graphics(), gridLabels = new PX.Container();
grid.addChild(gridLines, gridLabels);
const border = new PX.Sprite(); border.blendMode = PX.BLEND_MODES.SCREEN;
bgLayer.addChild(fieldImg, fieldMask, grid, border);
const labelTextures = new Map();
function labelTexture(label) {
  let t = labelTextures.get(label);
  if (!t) {
    const text = new PX.Text(label, { fontFamily: '"ReFormation Sans", "Titillium Web", Arial, sans-serif', fontSize: 288, fill: '#ffffff' });
    text.updateText(true); t = text.texture; labelTextures.set(label, t);
  }
  return t;
}
let borderKey = '';
function updateBorder(size, ox, oy) {
  border.visible = !G.infinite;
  if (G.infinite) return;
  const glow = !!cfg.get('GlowingBorder'), margin = size * 0.15, w = size * 0.015, k = 10;
  const key = `${size}|${glow}`;
  if (key !== borderKey) { // pre-rendered at a tenth of world size, like the original's 4160 px texture
    borderKey = key;
    const px = Math.ceil((size + margin * 2) / k);
    const [c, g] = canvasOf(px);
    if (glow) { g.shadowColor = '#fff'; g.shadowBlur = 80; }
    g.strokeStyle = '#fff'; g.lineWidth = w / k;
    g.strokeRect((margin - w / 2) / k, (margin - w / 2) / k, (size + w) / k, (size + w) / k);
    if (border.texture && border.texture !== PX.Texture.EMPTY) border.texture.destroy(true);
    border.texture = PX.Texture.from(c);
  }
  const col = cfg.color('clFieldBorder');
  border.scale.set(k); border.position.set(ox - margin, oy - margin);
  border.tint = rgbOf(col); border.alpha = alphaOf(col);
}
function updateBackground() {
  const b = G.bounds, z = sight.eyeScale;
  const size = G.infinite ? 32000 : b.maxX - b.minX, ox = G.infinite ? -16000 : b.minX, oy = G.infinite ? -16000 : b.minY;
  // wallpaper
  const tex = imageTexture(cfg.get('fieldBackImageUri'));
  fieldImg.visible = !!tex;
  if (tex) {
    const mode2 = cfg.get('fieldBackImageDrawingMode2');
    const s = (size / Math.min(tex.width, tex.height)) * (mode2 ? 2 : 1);
    if (fieldImg.texture !== tex) fieldImg.texture = tex;
    fieldImg.position.set(ox + size / 2, oy + size / 2); fieldImg.scale.set(s); fieldImg.alpha = cfg.get('fieldBackImageAlpha');
    fieldMask.clear();
    if (!mode2) { fieldMask.beginFill(0xffffff).drawRect(ox, oy, size, size).endFill(); fieldImg.mask = fieldMask; } else fieldImg.mask = null;
  }
  // sector grid A1..E5 (it repeats outward on an infinite field)
  grid.visible = cfg.get('ShowCoord');
  if (grid.visible) {
    const col = cfg.color('clFieldCoords'), rgb = rgbOf(col), step = size / 5, [x0, y0, x1, y1] = viewRect();
    grid.alpha = alphaOf(col);
    const gx0 = G.infinite ? x0 : Math.max(x0, ox), gx1 = G.infinite ? x1 : Math.min(x1, ox + size);
    const gy0 = G.infinite ? y0 : Math.max(y0, oy), gy1 = G.infinite ? y1 : Math.min(y1, oy + size);
    gridLines.clear(); gridLines.lineStyle({ width: size * 0.001875, color: rgb, alpha: 1 }); // the original's 60 per 32000
    for (let x = Math.ceil((gx0 - ox) / step) * step + ox; x <= gx1; x += step) gridLines.moveTo(x, gy0).lineTo(x, gy1);
    for (let y = Math.ceil((gy0 - oy) / step) * step + oy; y <= gy1; y += step) gridLines.moveTo(gx0, y).lineTo(gx1, y);
    const i0 = Math.floor((gx0 - ox) / step), i1 = Math.floor((gx1 - ox) / step), j0 = Math.floor((gy0 - oy) / step), j1 = Math.floor((gy1 - oy) / step);
    let n = 0;
    if ((i1 - i0 + 1) * (j1 - j0 + 1) <= 400) {
      const ls = size / 32000 * 10; // labels are 288 px text shown 10x, as in the original
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        if (!G.infinite && (i < 0 || j < 0 || i > 4 || j > 4)) continue;
        const label = String.fromCharCode(65 + (((j % 5) + 5) % 5)) + ((((i % 5) + 5) % 5) + 1);
        let s = gridLabels.children[n];
        if (!s) { s = new PX.Sprite(); s.anchor.set(0.5); gridLabels.addChild(s); }
        s.visible = true; s.texture = labelTexture(label); s.tint = rgb; s.scale.set(ls);
        s.position.set(ox + (i + 0.43) * step, oy + (j + 0.5) * step); n++;
      }
    }
    for (let k = n; k < gridLabels.children.length; k++) gridLabels.children[k].visible = false;
  }
  updateBorder(size, ox, oy);
}

// ---- cells ----
const views = new Map();
function viewOf(c) {
  let v = views.get(c.id);
  if (!v) {
    const box = new PX.Container();
    const body = new PX.Sprite(PX.Texture.EMPTY); body.anchor.set(0.5);
    const skin = new PX.Sprite(PX.Texture.EMPTY); skin.anchor.set(0.5);
    const marks = new PX.Graphics();
    const name = new PX.Sprite(PX.Texture.EMPTY); name.anchor.set(0.5);
    const mass = new PX.BitmapText('', { fontName: 'GAMEPLAY_MASS', fontSize: LABEL_PX, letterSpacing: 1.56 });
    box.addChild(body, skin, marks, name, mass);
    v = { box, body, skin, marks, name, mass, virus: null, marked: false, z: NaN };
    cellLayer.addChild(box); views.set(c.id, v);
  }
  return v;
}
function dropView(id) {
  const v = views.get(id); if (!v) return;
  v.box.destroy({ children: true }); views.delete(id);
}

// a ring in a cell's local units: width and radius are given as fractions of the radius
function ringLocal(g, color, alpha, width, radius) {
  g.lineStyle({ width: width * LOCAL_R, color, alpha, alignment: 0.5 });
  g.drawCircle(0, 0, Math.max(0.1, radius * LOCAL_R));
}

function drawVirusBody(c, v) {
  if (!v.virus) { v.virus = new PX.Graphics(); v.box.addChildAt(v.virus, 1); }
  const g = v.virus, R = LOCAL_R;
  // (the virus options were removed from the menus: viruses are drawn with the default look)
  const stroke = c.mass >= 200 ? 0xffff6699 : c.mass === 50 ? 0xff0099ff : 0xff00ff00, fill = 0x88444444;
  g.clear();
  g.beginFill(rgbOf(fill), alphaOf(fill));
  g.lineStyle({ width: R * 0.08, color: rgbOf(stroke), alpha: alphaOf(stroke) }); g.drawCircle(0, 0, R * 0.96);
  g.endFill();
  // glowing non-player cells: a glow disc behind the virus, in its stroke colour
  const glow = cfg.get('GlowingNonPlayerCells');
  v.body.visible = glow;
  if (glow) { const t = TEX.GP_GLOWING_MEDIUM; if (v.body.texture !== t.tex) v.body.texture = t.tex; v.body.scale.set(LOCAL_R / t.discR); v.body.tint = rgbOf(stroke); v.body.alpha = alphaOf(stroke); }
}

function updateLabels(c, v, name, labelColor, circular) {
  const z = sight.eyeScale, ts = cfg.get('TextSize'), newStyle = cfg.get('NewTextStyle');
  let show = !(cfg.get('AutoHideText') && c.type !== Type.VIRUS && !(z * z * c.mass > 9));
  if (show && 0.26 * c.r * ts * z < 3) show = false;
  // name
  const showName = show && !!name;
  v.name.visible = showName;
  if (showName) {
    const tex = circular ? circularNameTexture(name, labelColor) : nameTexture(name, labelColor, newStyle);
    if (v.name.texture !== tex) v.name.texture = tex;
    v.name.scale.set(circular ? 1 / LABEL_RES : ts / LABEL_RES);
  }
  // mass
  const showMass = show && cfg.get('ShowMass') && (c.type === Type.PLAYER || c.type === Type.VIRUS);
  v.mass.visible = showMass;
  if (showMass) {
    let text = fmtMass(c.mass), scale = 1;
    if (c.type === Type.VIRUS) {
      scale = 2.5;
      if (c.mass < 200 && c.mass > 50) { text = String(Math.round(7 - (c.mass - 100) / 16)); scale = 4; }
    }
    const reverse = cfg.get('ReverseTextFill') && labelColor !== 0x999999 && labelColor !== 0xacacac;
    const font = 'GAMEPLAY_MASS' + (newStyle ? (reverse ? '_CR' : '_C') : (reverse ? '_R' : ''));
    const m = v.mass;
    if (m.fontName !== font) m.fontName = font;
    const fsz = LABEL_PX * ts * scale;
    if (m.fontSize !== fsz) { m.fontSize = fsz; m.letterSpacing = 1.56 * ts * scale; }
    m.text = text;
    m.tint = reverse || c.type === Type.VIRUS ? 0xffffff : labelColor;
    if (name && !circular) { m.anchor.set(0.5, 0); m.y = 44.25 * ts; } // the original's placement under the name
    else { m.anchor.set(0.5, 0.5); m.y = 0; }
  }
}

const MARKER_KEYS = ['clMarkerA', 'clMarkerB', 'clMarkerC', 'clMarkerD', 'clMarkerE', 'clMarkerF', 'clMarkerG', 'clMarkerH'];
function updateCell(c) {
  const v = viewOf(c);
  v.box.visible = true;
  v.box.position.set(c.x, c.y);
  v.box.scale.set(Math.max(1e-4, c.r / LOCAL_R));
  // The original: zIndex = 2r / cardSize + 1e-8 * nodeId (+100 for cells of another team
  // section, which FFA servers don't have). The id term matters: with real node ids of a few
  // million it outweighs a few units of radius, so newer pieces go on top of slightly bigger ones.
  const zi = (2 * c.r) / (200 << Clamp(Math.round(cfg.get('RenderQuality')), 0, 2)) + 1e-8 * c.id;
  if (zi !== v.z) { v.z = zi; v.box.zIndex = zi; }

  if (c.type === Type.VIRUS) {
    v.skin.visible = false; v.marks.clear(); v.marked = false; v.marksKey = '';
    drawVirusBody(c, v); updateLabels(c, v, null, 0xffffff, false); return;
  }
  if (v.virus) { v.virus.destroy(); v.virus = null; }

  const unit = c.owner & 1, clientId = c.owner & 0xfffe;
  const user = G.users.get(clientId), team = teamOf(user);
  const isMine = c.type === Type.PLAYER && clientId === G.selfId;
  const isActive = c.type === Type.PLAYER && c.owner === G.activeSelfPlayerId;
  const sameTeam = team === selfTeam();
  let base = -1, edge = -1, slash = false, alert = -1, indicator = -1;
  if (c.type === Type.PLAYER || c.type === Type.FOOD) base = G.colors.get(c.owner) ?? 0x888888;
  else if (c.type === Type.PELLET) base = c.color;

  // skin (enemy skins are dimmed while playing unless all skins are shown)
  const q = Clamp(Math.round(cfg.get('RenderQuality')), 0, 2);
  const skinSize = 200 << q;
  let skin = null, skinAlpha = 0;
  if (c.type === Type.PLAYER) {
    const url = user ? (user[unit ? 'skin2' : 'skin1'] || user.skin1) : '';
    const inGame = G.isPlaying || G.isDeadSpectation;
    const allSkins = !cfg.get('ShowEnemyHint') || G.options.enableTeamSkinSeparation === false || user?.isBot;
    let visible = !!url && cfg.get('ShowSkin'); skinAlpha = 1;
    if (visible && inGame && !sameTeam && !allSkins) { if (cfg.get('ShowEnemySkin')) skinAlpha = 0.6; else visible = false; }
    if (visible) { skin = skinTexture(url, skinSize); if (!skin) visible = false; }
    if (!visible) skinAlpha = 0;
  }

  if (c.type === Type.PLAYER) {
    if (cfg.get('ShowSplitPrediction') && isActive && c.splitOrderWeight >= 0) edge = hsvToRgb(MapTo(c.splitOrderWeight, 0.9, 0.58), 1, 1);
    if (cfg.get('ShowMassMarker') && !isActive && c.sizeLevel !== -1) {
      const palette = cfg.get('MarkerExtend') ? MARKER_KEYS.map((k) => rgbOf(cfg.color(k))).concat([0x0000cc]) : [0xff0000, 0xff6600, 0xffff00, 0x00ddff, 0x00aa00, 0x0000cc];
      const col = palette[c.sizeLevel];
      if (col !== undefined) { if (skinAlpha > 0) { edge = col; slash = !user?.isBot && !sameTeam; } else base = col; }
    }
    if (cfg.get('ShowSplitIndicator') && G.isPlaying && !isMine && c.showMark) indicator = c.canEat ? 0x00ff00 : 0xaaaaaa;
    if (cfg.get('ShowAutoSplitAlert') && c.mass >= 17325) {
      let D = ((Date.now() / 400) * 0.5) % 1; D *= 2; if (D > 1) D = 2 - D;
      alert = hsvToRgb(MapTo(D, 0, 0.33), 1, 1);
    }
  }

  // body: a white disc texture tinted with the cell colour
  const transparent = cfg.get('TogglePlayerTransparentCells') && c.type === Type.PLAYER;
  const pelletLike = (c.type === Type.FOOD || c.type === Type.PELLET) && !cfg.get('GlowingNonPlayerCells');
  const bodyAlpha = transparent ? cfg.get('PlayerCellsAlpha') : pelletLike ? cfg.get('PelletCellsAlpha') : 1;
  const glow = c.type === Type.PLAYER ? cfg.get('GlowingCells') : cfg.get('GlowingNonPlayerCells');
  const key = glow ? (c.type === Type.PLAYER ? 'GP_GLOWING_' + QUALITY[q] : 'GP_GLOWING_PELLET') : (c.type === Type.PLAYER ? 'GP_BASE_' + QUALITY[q] : 'GP_BASE_LOW');
  const t = TEX[key];
  const white = isMine && skin && skinAlpha > 0 && cfg.get('MakeSelfWhite');
  v.body.visible = true;
  if (v.body.texture !== t.tex) v.body.texture = t.tex;
  v.body.scale.set(LOCAL_R / t.discR);
  v.body.tint = white ? 0xffffff : base;
  v.body.alpha = white ? 1 : bodyAlpha;
  // skin
  v.skin.visible = !!skin && skinAlpha > 0 && !white;
  if (v.skin.visible) { if (v.skin.texture !== skin) v.skin.texture = skin; v.skin.scale.set((LOCAL_R * 2) / skinSize); v.skin.alpha = bodyAlpha * skinAlpha; }

  // markers, in the cell's local units
  const g = v.marks;
  const hint = v.skin.visible && c.type === Type.PLAYER && cfg.get('ShowEnemySkin') && cfg.get('ShowEnemyHint') && (G.isPlaying || G.isDeadSpectation) && !user?.isBot && !sameTeam;
  const needMarks = hint || (c.type === Type.PLAYER && (edge >= 0 || alert >= 0 || indicator >= 0 || (cfg.get('ShowRocketPunchMarker') && c === G.largestOwn && c.mass > 2000)));
  const marksKey = needMarks ? [hint, team.color, edge, slash, alert, indicator, isActive, cfg.get('MarkerAlpha'), cfg.get('SOMarkerSize'), cfg.get('MMarkerSize'), cfg.get('AutoSplitAlertSize'), c.mass > 20000,
    cfg.get('ShowRocketPunchMarker') && c === G.largestOwn && c.mass > 2000 ? Math.max(0.014, 2 / sight.eyeScale / c.r).toFixed(4) : 0].join() : '';
  const redraw = marksKey !== v.marksKey;
  if (redraw) { g.clear(); v.marksKey = marksKey; }
  v.marked = needMarks;
  if (needMarks && redraw) {
    if (hint) {
      g.lineStyle(0); g.beginFill(0x000000, 0.3).drawCircle(0, 0, LOCAL_R).endFill();
      ringLocal(g, team.color, 0.8, 0.12, 0.86);
      const d = (0.707 - 0.14) * LOCAL_R; g.moveTo(d, -d).lineTo(-d, d);
    }
    const ma = cfg.get('MarkerAlpha');
    if (edge >= 0) {
      const w = isActive ? cfg.get('SOMarkerSize') : cfg.get('MMarkerSize');
      ringLocal(g, edge, ma, w, 1 - w / 2);
      if (slash) { const j = 0.707 * LOCAL_R; g.moveTo(j, -j).lineTo(-j, j); }
    }
    if (cfg.get('ShowRocketPunchMarker') && c === G.largestOwn && c.mass > 2000) ringLocal(g, 0x00ffff, ma, Math.max(0.014, 2 / sight.eyeScale / c.r), 2.4);
    if (alert >= 0) {
      const w = cfg.get('AutoSplitAlertSize');
      if (c.mass > 20000) { ringLocal(g, alert, ma, w * 0.62, 1 - w * 0.31); ringLocal(g, alert, ma, w * 0.38, 1 - w); } else ringLocal(g, alert, ma, w, 1 - w / 2);
    }
    if (indicator >= 0) ringLocal(g, indicator, ma, 0.05, 1.1);
  }

  // labels
  if (c.type !== Type.PLAYER) { v.name.visible = false; v.mass.visible = false; return; }
  const showName = cfg.get('ShowName') && !(!cfg.get('ShowSelfName') && isMine);
  const name = user ? displayName(user) : '';
  updateLabels(c, v, showName && name ? name : null, team.color, !!(showName && name && cfg.get('ShowCircularName')));
}

function updateOverlay() {
  const z = sight.eyeScale, g = overlay;
  g.clear();
  if ((G.isPlaying ? cfg.get('ShowCursorLine') : cfg.get('ShowSpecAimCursor')) && sight.aimPlayerId > 0) {
    const col = cfg.color('clCursorLine'), rgb = rgbOf(col);
    g.lineStyle({ width: (cfg.get('CursorLineThickness') * 0.2) / z, color: rgb, alpha: alphaOf(col) });
    let n = 0;
    for (const c of G.nodes.values()) if (c.owner === sight.aimPlayerId && c.type === Type.PLAYER) { g.moveTo(c.x, c.y).lineTo(sight.aimCursorX, sight.aimCursorY); n++; }
    if (n && !G.isPlaying) { // the spectated player's cursor
      g.lineStyle({ width: 2 / z, color: rgb, alpha: 1 });
      g.beginFill(sight.splitting ? 0xffff44 : 0xffffff, sight.splitting ? 1 : 0.4).drawCircle(sight.aimCursorX, sight.aimCursorY, 9 / z).endFill();
    }
    sight.splitting = false;
  }
  if (cfg.get('ShowEatLimitMarker')) for (const e of G.eatingLimitList) {
    g.lineStyle({ width: 10, color: e.canEat ? 0x00ffff : 0xaaaaaa, alpha: 1 });
    for (const p of [e.eater, e.eaten]) { g.moveTo(p.x - 100, p.y).lineTo(p.x + 100, p.y); g.moveTo(p.x, p.y - 100).lineTo(p.x, p.y + 100); }
    g.drawCircle(e.eater.x, e.eater.y, Math.max(0, e.limit));
  }
  if (cfg.get('ShowCellDirectionMarker')) for (const c of G.nodes.values()) {
    if (c.type !== Type.PLAYER || (c.vx === 0 && c.vy === 0)) continue;
    const a = Math.atan2(c.vy, c.vx), team = teamOf(G.users.get(c.owner & 0xfffe));
    g.lineStyle({ width: Math.max(0.05 * c.nr, 15), color: team.color, alpha: 1 });
    g.moveTo(c.x + Math.cos(a) * c.r * 0.8, c.y + Math.sin(a) * c.r * 0.8).lineTo(c.x + Math.cos(a) * c.r * 1.05, c.y + Math.sin(a) * c.r * 1.05);
  }
  if (G.teamCircle && Date.now() - G.teamCircle.t < 500) { g.lineStyle({ width: 10, color: 0xffffff, alpha: 1 }); g.drawCircle(G.teamCircle.x, G.teamCircle.y, G.teamCircle.radius); }
}

let lastSweep = 0;
function renderScene(now) {
  const z = sight.eyeScale;
  world.scale.set(z);
  world.position.set(sight.scw / 2 - sight.eyeX * z, sight.sch / 2 - sight.eyeY * z);
  updateBackground();
  const [x0, y0, x1, y1] = viewRect();
  for (const [id, v] of views) if (!G.nodes.has(id)) dropView(id); else v.box.visible = false;
  for (const c of G.nodes.values()) if (c.x + c.r > x0 && c.x - c.r < x1 && c.y + c.r > y0 && c.y - c.r < y1) updateCell(c);
  updateOverlay();
  renderer.render(stage);
  if (now - lastSweep > 5000) { lastSweep = now; sweepNameCache(now); }
}

function drawMinimap() {
  const W = mini.width, H = mini.height, span = 24000;
  const b = G.infinite ? { minX: sight.eyeX - span / 2, minY: sight.eyeY - span / 2, maxX: sight.eyeX + span / 2, maxY: sight.eyeY + span / 2 } : G.bounds;
  const sx = W / (b.maxX - b.minX), sy = H / (b.maxY - b.minY);
  mctx.clearRect(0, 0, W, H);
  mctx.strokeStyle = 'rgba(255,255,255,0.1)'; mctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) { mctx.beginPath(); mctx.moveTo((i * W) / 5, 0); mctx.lineTo((i * W) / 5, H); mctx.moveTo(0, (i * H) / 5); mctx.lineTo(W, (i * H) / 5); mctx.stroke(); }
  for (const p of G.minimap) {
    const mine = (p.playerId & 0xfffe) === G.selfId, r = Math.max(2, Math.sqrt(p.mass) * 0.12);
    mctx.fillStyle = mine ? '#ffffff' : cssRgb(G.colors.get(p.playerId) ?? 0x999999);
    mctx.beginPath(); mctx.arc((p.x - b.minX) * sx, (p.y - b.minY) * sy, r, 0, Math.PI * 2); mctx.fill();
  }
  const z = sight.eyeScale;
  mctx.strokeStyle = 'rgba(255,255,255,0.4)';
  mctx.strokeRect((sight.eyeX - sight.scw / 2 / z - b.minX) * sx, (sight.eyeY - sight.sch / 2 / z - b.minY) * sy, (sight.scw / z) * sx, (sight.sch / z) * sy);
  if (G.infinite) { mctx.fillStyle = 'rgba(255,255,255,0.5)'; mctx.font = '11px sans-serif'; mctx.textAlign = 'left'; mctx.textBaseline = 'top'; mctx.fillText(`${Math.round(sight.eyeX)}, ${Math.round(sight.eyeY)}`, 6, 5); }
}

let renderDelta = 0;
let frameIndex = 0, lastFrame = performance.now(), fpsFrames = 0, fpsT = performance.now(), lastHudT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  frameIndex++;
  const every = Math.max(1, Math.round(60 / FRAME_RATES[cfg.get('FrameRateOption')]));
  if (frameIndex % every !== 0) return;
  const dt = now - lastFrame; lastFrame = now;
  if (!sight.initDone) return;
  updateSight();
  const t0 = performance.now();
  interpolate(t0 + renderDelta * cfg.get('RenderingTimeOffset'), dt);

  renderScene(now);
  renderDelta = (renderDelta + performance.now() - t0) / 2; // the original's this.delta

  if (now - lastHudT > 250) {
    lastHudT = now;
    let score = 0; for (const u of [0, 1]) for (const id of G.selfNodeIds[u]) { const c = G.nodes.get(id); if (c) score += c.mass; }
    G.score = score; if (G.isPlaying) G.maxScore = Math.max(G.maxScore, score);
    ui.score.textContent = `Score: ${fmtK(score)}`; ui.max.textContent = `Max: ${fmtK(G.maxScore)}`;
    ui.cells.textContent = `${G.isPlaying && G.splitNum ? G.splitNum : ''}/16`;
    const target = sight.aimPlayerId > 0 && !G.isPlaying ? nameOfClient(sight.aimPlayerId) : '';
    ui.spec2.textContent = target ? `Spectating ${target}  ${fmtK(G.specScore)}` : '';
  }
  fpsFrames++;
  if (now - fpsT >= 500) {
    ui.fps.textContent = ((fpsFrames * 1000) / (now - fpsT)).toFixed(1); fpsFrames = 0; fpsT = now;
    ui.nodes.textContent = G.nodes.size; ui.lat.textContent = G.latency ?? '-';
    if (cfg.get('ShowMap')) drawMinimap();
  }
}

setInterval(() => { if (G.connected) { G.pingSentAt = performance.now(); send(P.ping()); } }, 1000);

buildTextures();
buildMassFonts();
createRenderer();
applyPageSettings();
connect();
showMenu(true);
requestAnimationFrame(frame);
window.__rec = { G, sight, cfg, stage, views, get renderer() { return renderer; }, get renderDelta() { return renderDelta; } }; // handy for debugging in the console
