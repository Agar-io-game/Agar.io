// Plays against the recreation server with a headless client that sends exactly what the
// real client sends and decodes every reply with ../protocol.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { ServerDecoder } from '../protocol.mjs';
import { Writer } from './packets.mjs';
import { createServer } from './server.mjs';

const cmd = {
  handshake: () => new Writer().u8(252).strEx('lwga-111').strEx('TeSt01').strEx('fp-test').bytes,
  entry: (name) => new Writer().u8(30).strEx(name).strEx('').strEx('').strEx('').strEx('').bytes,
  spectate: () => new Writer().u8(1).bytes,
  play: () => new Writer().u8(31).bytes,
  aim: (x, y) => new Writer().u8(16).i32(x).i32(y).bytes,
  action: (a, arg) => new Writer().u8(25).u8(a).u8(arg).bytes,
  ping: () => new Writer().u8(130).bytes,
  spec: (id) => new Writer().u8(27).i32(id).bytes,
  chat: (text) => new Writer().u8(124).u8(1).strUtf8(text).bytes,
  option: (text) => new Writer().u8(125).strUtf8(text).bytes, // the settings menu's Extra options
};

class Client {
  constructor(port) {
    this.dec = new ServerDecoder(); this.frames = []; this.errors = [];
    this.ws = new WebSocket(`ws://localhost:${port}`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.on('message', (d) => {
      try { const m = this.dec.decode(d); if (m.unknown) this.errors.push(`unknown op ${m.op}`); if (m.trailingBytes) this.errors.push(`op ${m.op} trailing ${m.trailingBytes}`); this.frames.push(m); }
      catch (e) { this.errors.push(e.message); }
    });
    this.open = new Promise((r) => this.ws.on('open', r));
  }
  send(b) { this.ws.send(b); }
  last(op) { return this.frames.findLast((m) => m.op === op); }
  all(op) { return this.frames.filter((m) => m.op === op); }
  async until(pred, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = pred(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error('timed out waiting');
  }
  // Rebuild the client's view of the world from world updates, like NodeManager does.
  nodes() {
    const map = new Map();
    for (const m of this.all(15)) { for (const n of m.nodes) map.set(n.nodeId, n); for (const id of m.removed) map.delete(id); }
    return map;
  }
  myCells(selfId) { return [...this.nodes().values()].filter((n) => n.type === 0 && (n.owner & 0xfffe) === selfId); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('recreation server speaks the protocol end to end', async (t) => {
  // Default gameplay (infinite field, no pellets/viruses) with a short merge timer so the
  // merge test runs quickly: 1 s + 0.001 s per mass.
  const server = createServer({ recombineBaseSec: 1, recombineMassFactor: 0.001 });
  const port = await server.listen(0);
  t.after(() => server.close());

  const c = new Client(port);
  await c.open;
  c.send(cmd.handshake()); c.send(cmd.entry('tester')); c.send(cmd.spectate());

  await t.test('handshake order matches the live server', async () => {
    await c.until(() => c.last(42));
    const order = c.frames.slice(0, 6).map((m) => m.op);
    assert.deepEqual(order, [133, 133, 43, 201, 200, 65]);
    assert.equal(c.last(133).compact, false, 'legacy encoding, no "Swal"');
    assert.equal(c.last(200).options.infiniteField, true);
    assert.equal(c.last(200).options.minimapScale, 32);
    assert.ok(c.last(65).bounds.maxX >= 1e6, 'nominal huge bounds on an infinite field');
  });

  const selfId = c.last(43).selfUserId;

  await t.test('user list has us and no bots', async () => {
    await c.until(() => c.all(42).some((m) => m.users.some((u) => u.clientId === selfId && u.name === 'tester')));
    const users = c.all(42).flatMap((m) => m.users);
    assert.equal(users.filter((u) => u.isBot).length, 0);
    assert.equal(selfId % 2, 0, 'client ids are even; bit 0 is the unit');
  });

  await t.test('spectating streams world updates at about 25 Hz', async () => {
    const before = c.all(15).length;
    await wait(1000);
    const n = c.all(15).length - before;
    assert.ok(n >= 20 && n <= 30, `got ${n} updates in 1 s`);
    assert.ok(c.all(15).every((m) => m.nodes.every((n) => n.type === 0 || n.type === 3)), 'no pellets or viruses');
  });

  await t.test('play spawns one cell of mass 399 and an aim block for our unit', async () => {
    c.send(cmd.play());
    const cells = await c.until(() => { const m = c.myCells(selfId); return m.length ? m : null; });
    assert.equal(cells.length, 1);
    assert.equal(cells[0].mass, 399);
    const w = await c.until(() => c.last(15)?.aim?.playerId === selfId ? c.last(15) : null);
    assert.equal(w.aim.score, 399);
    assert.ok(Math.abs(w.view.w / w.view.h - 4 / 3) < 0.01, 'view is 4:3');
  });

  await t.test('cells move toward the aim at 88 * r^-0.439 per tick', async () => {
    const [cell] = c.myCells(selfId);
    c.send(cmd.aim(cell.x + 5000, cell.y));
    await wait(400);
    const a = c.myCells(selfId)[0]; const t0 = c.all(15).length;
    await wait(1000);
    const b = c.myCells(selfId)[0]; const ticks = c.all(15).length - t0;
    const perTick = (b.x - a.x) / ticks;
    const expected = 88 * Math.pow(Math.sqrt(100 * a.mass), -0.439);
    assert.ok(Math.abs(perTick - expected) / expected < 0.2, `moved ${perTick.toFixed(2)}/tick, expected ~${expected.toFixed(2)}`);
  });

  await t.test('split halves the cell and the new cell reports a ~194.5 boost', async () => {
    const [cell] = c.myCells(selfId);
    c.send(cmd.aim(cell.x + 5000, cell.y));
    c.send(cmd.action(0, 1));
    const boosted = await c.until(() => c.all(15).flatMap((m) => m.nodes).find((n) => n.type === 0 && (n.owner & 0xfffe) === selfId && n.motionSpeed > 150));
    assert.ok(Math.abs(boosted.motionSpeed - 194.5 * 0.8866) < 25, `boost ${boosted.motionSpeed}`);
    const cells = await c.until(() => { const m = c.myCells(selfId); return m.length === 2 ? m : null; });
    assert.ok(cells.every((x) => Math.abs(x.mass - cells[0].mass) <= 1), 'equal halves');
  });

  await t.test('feeding ejects mass-15 cells owned by our unit', async () => {
    c.send(cmd.action(1, 255));
    const ej = await c.until(() => [...c.nodes().values()].find((n) => n.type === 3 && (n.owner & 0xfffe) === selfId));
    assert.equal(ej.mass, 15);
  });

  await t.test('own cells wait for their merge timer, then merge', async () => {
    const [cell] = c.myCells(selfId);
    c.send(cmd.aim(cell.x, cell.y)); // stop and let them come together
    await wait(600);
    assert.equal(c.myCells(selfId).length, 2, 'not merged before the timer (1 s + 0.2 s)');
    await c.until(() => c.myCells(selfId).length === 1, 6000);
  });

  await t.test('change unit spawns the second unit at the cursor, near our cells', async () => {
    const [cell] = c.myCells(selfId);
    const near = { x: Math.round(cell.x + 900), y: Math.round(cell.y) };     // within reach
    c.send(cmd.aim(near.x, near.y));
    c.send(cmd.action(3, 255));
    await c.until(() => c.last(15)?.aim?.playerId === (selfId | 1));
    const units = new Set(c.myCells(selfId).map((n) => n.owner & 1));
    assert.deepEqual([...units].sort(), [0, 1]);
    const second = await c.until(() => c.myCells(selfId).find((n) => (n.owner & 1) === 1));
    // Caffe scatters it within ~2300 of the cursor; it may also have moved a tick or two.
    assert.ok(Math.hypot(second.x - near.x, second.y - near.y) < 2300 + 60, `spawned at ${second.x},${second.y}, cursor ${near.x},${near.y}`);
  });

  await t.test('latency ping and HUD packets', async () => {
    const n = c.all(131).length; c.send(cmd.ping());
    await c.until(() => c.all(131).length > n);
    await c.until(() => c.last(47) && c.last(41) && c.last(91) && c.last(203));
    assert.ok(c.last(47).entries.some((e) => e.clientId === selfId), 'on the leaderboard');
  });

  await t.test('serves the client page and only whitelisted files', async () => {
    const get = (p) => fetch(`http://localhost:${port}${p}`);
    const page = await get('/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /game\.mjs/);
    for (const p of ['/game.mjs', '/protocol.mjs', '/packets.mjs']) {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type'), /javascript/, p);
    }
    for (const p of ['/server.mjs', '/../server/config.mjs', '/package.json', '/client/../server/world.mjs', '/node_modules/ws/package.json']) {
      assert.equal((await get(p)).status, 404, p);
    }
  });

  await t.test('the Ping/ms option adds a simulated round trip, 0 removes it', async () => {
    const rtt = async () => { const n = c.all(131).length; const t0 = Date.now(); c.send(cmd.ping()); await c.until(() => c.all(131).length > n); return Date.now() - t0; };
    c.send(cmd.option('ping 200')); await wait(150);
    const slow = await rtt();
    assert.ok(slow >= 190 && slow < 600, `round trip ${slow} ms with ping 200`);
    c.send(cmd.option('ping 0')); await wait(250);
    assert.ok((await rtt()) < 100, 'back to no delay');
  });

  await t.test('the Map walls option sends the 32000 box to everyone, and back to infinite', async () => {
    const n200 = c.all(200).length;
    c.send(cmd.option('walls on')); await c.until(() => c.all(200).length > n200 && c.all(65).length > 1);
    assert.equal(c.last(200).options.infiniteField, false);
    assert.deepEqual(c.last(65).bounds, { minX: -16000, minY: -16000, maxX: 16000, maxY: 16000 });
    assert.equal(server.cfg.infiniteField, false);
    const m = c.all(200).length;
    c.send(cmd.option('walls off')); await c.until(() => c.all(200).length > m);
    assert.equal(c.last(200).options.infiniteField, true);
    assert.ok(c.last(65).bounds.maxX >= 1e6);
  });

  await t.test('removed chat commands do nothing', async () => {
    const n200 = c.all(200).length;
    for (const t of ['/walls on', '/ping 300', '/decay off', '/duo', '/run', '/s', '/l', '/help', '/dir', '/rec on']) c.send(cmd.chat(t));
    await wait(300);
    assert.equal(c.all(200).length, n200, 'no map change');
    assert.equal(server.cfg.infiniteField, true);
    assert.ok(![...server.world.players.values()].some((x) => x.isBot), 'no bot');
    assert.ok(!c.all(123).some((m) => /commands:|saved|loaded|duo|self-duo|recording/.test(m.text || '')), 'no replies');
  });

  await t.test('every frame decoded cleanly', () => {
    assert.deepEqual(c.errors, []);
    assert.ok(c.frames.length > 100);
  });

  c.ws.close();
});

test('an eaten cell is listed once more after the eater has grown, then removed (Caffe swallow)', async (t) => {
  const server = createServer({ decayBase: 0, decayPerMass: 0, secondUnitScatter: 0 }); // B spawns on the cursor
  const port = await server.listen(0);
  t.after(() => server.close());
  const c = new Client(port); await c.open;
  c.send(cmd.handshake()); c.send(cmd.entry('eater')); c.send(cmd.play());
  const selfId = (await c.until(() => c.last(43))).selfUserId;
  const A = (await c.until(() => c.myCells(selfId)[0]));
  c.send(cmd.chat('/mass 5000'));
  await c.until(() => c.myCells(selfId).some((n) => n.mass >= 4990));
  c.send(cmd.aim(A.x + 900, A.y)); await wait(100);
  c.send(cmd.action(3, 0)); // Tab: second unit near the cursor, now active
  const B = await c.until(() => c.myCells(selfId).find((n) => (n.owner & 1) === 1));
  const big = c.myCells(selfId).find((n) => (n.owner & 1) === 0);
  const steer = setInterval(() => c.send(cmd.aim(big.x, big.y)), 40); // drive the small unit into the big one
  t.after(() => clearInterval(steer));
  await c.until(() => c.all(15).some((m) => m.removed.includes(B.nodeId)), 8000);
  clearInterval(steer);
  const ups = c.all(15);
  const gone = ups.findIndex((m) => m.removed.includes(B.nodeId));
  const before = ups[gone - 1];
  const bigThen = before.nodes.find((n) => n.nodeId === big.nodeId);
  assert.ok(before.nodes.some((n) => n.nodeId === B.nodeId), 'the eaten cell is still in the update before its removal');
  assert.ok(bigThen && bigThen.mass >= 5000 + B.mass - 2, `the eater already has its mass in that update (${bigThen && bigThen.mass})`);
  assert.ok(!ups[gone].nodes.some((n) => n.nodeId === B.nodeId), 'not listed in the update that removes it');
  c.ws.close();
});

test('/mass sets the mass of the unit you control', async (t) => {
  const server = createServer({});
  const port = await server.listen(0);
  t.after(() => server.close());
  const c = new Client(port); await c.open;
  c.send(cmd.handshake()); c.send(cmd.entry('masstest')); c.send(cmd.play());
  await c.until(() => c.last(43));
  await wait(200);
  const me = [...server.world.players.values()].find((x) => x.name === 'masstest');
  c.send(cmd.chat('/mass 5000')); await wait(150);
  assert.ok(Math.abs(me.mass - 5000) < 20, `mass set (${Math.round(me.mass)})`);
  c.ws.close();
});
