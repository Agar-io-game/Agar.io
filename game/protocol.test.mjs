// Round-trip tests: frames are built byte-for-byte the way the client's
// DataFrameWriter / server encoder lays them out, then decoded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Reader, ServerDecoder, decodeClient, decodePlayerId, massToRadius } from './protocol.mjs';

class W {
  b = [];
  u8(v) { this.b.push(v & 255); return this; }
  u16(v) { return this.u8(v).u8(v >> 8); }
  u16be(v) { return this.u8(v >> 8).u8(v); }
  u24(v) { return this.u16be(v >> 8).u8(v); }
  u32(v) { return this.u8(v).u8(v >> 8).u8(v >> 16).u8(v >>> 24); }
  i32(v) { if (v < 0) v += 4294967295; return this.u32(v); } // same QUIRK as the client writer
  f32(v) { const a = new Float32Array([v]); return this.u32(new Uint32Array(a.buffer)[0]); }
  strEx(s) { this.u16(s.length); for (const ch of s) this.u16(ch.charCodeAt(0)); return this; }
  utf8(s) { for (const x of new TextEncoder().encode(s)) this.u8(x); return this.u8(0); }
  dlb16(v) { return v > 127 ? this.u8(0x80 | (v >> 8)).u8(v) : this.u8(v); }
  dlb24(v) { return v > 32767 ? this.u16be(0x8000 | (v >> 8)).u8(v) : this.u16be(v); }
  dlb24s(v) { return this.dlb24((Math.abs(v) << 1) | (v < 0 ? 1 : 0)); }
  get buf() { return new Uint8Array(this.b).buffer; }
}

test('primitive codecs, including the int32 quirk', () => {
  const w = new W().i32(-1).i32(123456).dlb16(100).dlb16(30000).dlb24(1000).dlb24(5_000_000).dlb24s(-7000).dlb24s(7000).u24(0xabcdef);
  const r = new Reader(w.buf);
  assert.equal(r.i32(), -1);
  assert.equal(r.i32(), 123456);
  assert.equal(r.dlb16(), 100);
  assert.equal(r.dlb16(), 30000);
  assert.equal(r.dlb24(), 1000);
  assert.equal(r.dlb24(), 5_000_000);
  assert.equal(r.dlb24s(), -7000);
  assert.equal(r.dlb24s(), 7000);
  assert.equal(r.u24(), 0xabcdef);
  // A real two's-complement -1 (0xFFFFFFFF) decodes to 0 under the client's rule.
  assert.equal(new Reader(new W().u32(0xffffffff).buf).i32(), 0);
});

test('session handshake (client 252)', () => {
  const f = new W().u8(252).strEx('lwga-111').strEx('aB3xYz').strEx('fpVisitorId').buf;
  assert.deepEqual(decodeClient(f), { op: 252, name: 'SESSION_INIT', protocol: 'lwga-111', envSig: 'aB3xYz', fingerprint: 'fpVisitorId', trailingBytes: 0 });
});

test('player action and user entry (client 25, 30)', () => {
  const a = decodeClient(new W().u8(25).u8(0).u8(4).buf);
  assert.equal(a.actionName, 'SPLIT'); assert.equal(a.arg, 4);
  const e = decodeClient(new W().u8(30).strEx('nick').strEx('[T]').strEx('s1').strEx('code').strEx('s2').buf);
  assert.equal(e.name, 'nick'); assert.equal(e.code, 'code'); assert.equal(e.skin2, 's2');
});

test('world update, legacy encoding (server 15)', () => {
  const d = new ServerDecoder();
  const f = new W().u8(15).f32(7000).f32(7000).f32(0).f32(0)
    .u8(1).u16(10).f32(100).f32(200).u8(1).u32(5000)
    .u32(77).u8(0).f32(1.5).f32(2.5).u16(400).u16(10).u8(1).f32(0.5).f32(9)   // player cell
    .u32(78).u8(1).f32(3).f32(4).u16(5).u16(0).u32(0xff00ff).u8(0)          // food pellet
    .u32(0).u16(2).u32(5).u32(6).buf;
  const m = d.decode(f);
  assert.equal(m.name, 'WORLD_UPDATE');
  assert.deepEqual(m.aim, { playerId: 10, x: 100, y: 200, splitting: true, score: 5000 });
  assert.equal(m.nodes.length, 2);
  assert.deepEqual(m.nodes[0], { nodeId: 77, type: 0, x: 1.5, y: 2.5, mass: 400, owner: 10, color: 0, motionAngle: 0.5, motionSpeed: 9 });
  assert.equal(m.nodes[1].color, 0xff00ff);
  assert.deepEqual(m.removed, [5, 6]);
  assert.equal(m.trailingBytes, 0);
});

test('world update switches to compact encoding after a "Swal" version (133 then 15)', () => {
  const d = new ServerDecoder();
  assert.equal(d.decode(new W().u8(133).strEx('SwalServer 1.2').buf).compact, true);
  const f = new W().u8(15).f32(0).f32(0).f32(0).f32(0).u8(0)
    .dlb24(40000).u8(0).dlb24s(-1200).dlb24s(3300).dlb24(50000).u16(11).u8(0)      // player, varint coords
    .dlb24(3).u8(4).f32(10.25).f32(-4.5).dlb24(900).u16(12).u8(0)                // type 4: full precision, becomes 0
    .dlb24(4).u8(1).dlb24s(5).dlb24s(6).dlb16(200).u24(0x123456).u8(0)           // food pellet
    .dlb24(5).u8(2).dlb24s(0).dlb24s(0).dlb16(100).u8(0)                         // virus, no owner
    .dlb24(0).u16(0).buf;
  const m = d.decode(f);
  assert.equal(m.compact, true);
  assert.deepEqual(m.nodes.map((n) => [n.nodeId, n.type, n.x, n.y, n.mass, n.owner, n.color]), [
    [40000, 0, -1200, 3300, 50000, 11, 0],
    [3, 0, 10.25, -4.5, 900, 12, 0],
    [4, 1, 5, 6, 200, 0, 0x123456],
    [5, 2, 0, 0, 100, 0, 0],
  ]);
  assert.equal(m.trailingBytes, 0);
});

test('user list with optional profile block (server 42)', () => {
  const f = new W().u8(42).u16(2)
    .u16(20).strEx('alice').strEx('[A]').strEx('skinA').u8(2).u8(1).strEx('hi').u16(3).strEx('trip').strEx('skinA2')
    .u16(22).strEx('bot').strEx('').strEx('').u8(1).u16(0).strEx('').strEx('').buf;
  const m = new ServerDecoder().decode(f);
  assert.equal(m.users[0].profileComment, 'hi');
  assert.equal(m.users[0].enableChat, true);
  assert.equal(m.users[1].isBot, true);
  assert.equal(m.trailingBytes, 0);
});

test('chat v2, leaderboard, options (server 123, 47, 200)', () => {
  const d = new ServerDecoder();
  assert.deepEqual(d.decode(new W().u8(123).u8(3).u16be(20).utf8('こんにちは').u16be(22).buf),
    { op: 123, name: 'CHAT2', channel: 3, clientId: 20, text: 'こんにちは', peerId: 22, trailingBytes: 0 });
  assert.deepEqual(d.decode(new W().u8(47).u8(1).u16(20).u32(99999).buf).entries, [{ clientId: 20, score: 99999 }]);
  assert.equal(d.decode(new W().u8(200).strEx('{"enableTeamChatSeparation":true}').buf).options.enableTeamChatSeparation, true);
});

test('helpers', () => {
  assert.deepEqual(decodePlayerId(21), { clientId: 20, unit: 1 });
  assert.equal(massToRadius(100), 100);
});

// Real frames captured from ws://sv-caffe.senpai-agar.online:2520 (TsOgarRx_r A112d_251109a)
// on 2026-10-17. Handshake and name-bearing frames are deliberately left out.
const hex = (s) => Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16)).buffer;
const LIVE = {
  worldUpdate: '0fa7f6a846834194444688cb4534a6984501bb1e0054a14600409344006300000020775400003fe7b24638384f45a50d5200002f7b5400007b67a64664777f444504ba1e010000000000000000887b540000e119ac464d139d443100bb1e010000000000000000977b5400004db7a846b31f9a443100bb1e01d29445c075d6a742000000000100957b5400',
  fieldBounds: '4100000000000000000000fa460000fa46',
  userCounts: '5b030000002d0002003200030046004600410000000000',
  addNode: '202f7b5400',
  leaderboard: '2f065800dc2e00003200ac2800000c006e1d00004200aa18000052001a17000046004a150000',
};

test('live: world update parses to the last byte', () => {
  const m = new ServerDecoder().decode(hex(LIVE.worldUpdate));
  assert.equal(m.trailingBytes, 0);
  assert.equal(m.compact, false);
  assert.equal(m.nodes.length, 4);
  assert.ok(m.aim, 'spectating/playing frame carries an aim block');
  assert.ok(Math.abs(m.view.w / m.view.h - 4 / 3) < 0.01, 'view range is 4:3');
  const moving = m.nodes.filter((n) => n.motionSpeed > 0);
  assert.equal(moving.length, 1);
  assert.equal(m.removed.length, 1);
});

test('live: field bounds, user counts, AddNode, leaderboard', () => {
  const d = new ServerDecoder();
  assert.deepEqual(d.decode(hex(LIVE.fieldBounds)).bounds, { minX: 0, minY: 0, maxX: 32000, maxY: 32000 });
  const uc = d.decode(hex(LIVE.userCounts));
  assert.deepEqual([uc.counts, uc.text, uc.trailingBytes], [[0, 45, 2, 50], 'FFA', 0]);
  assert.deepEqual(d.decode(hex(LIVE.addNode)), { op: 32, name: 'OGAR_ADD_NODE', nodeId: 0x547b2f, trailingBytes: 0 });
  const lb = d.decode(hex(LIVE.leaderboard));
  assert.equal(lb.entries.length, 6);
  assert.equal(lb.trailingBytes, 0);
  assert.ok(lb.entries.every((e, i, a) => i === 0 || a[i - 1].score >= e.score), 'sorted by score');
});

test('live: client frames', () => {
  assert.deepEqual(decodeClient(hex('1903ff')), { op: 25, name: 'PLAYER_ACTION', action: 3, actionName: 'CHANGE_UNIT', arg: 255, trailingBytes: 0 });
  assert.deepEqual(decodeClient(hex('100000000000000000')), { op: 16, name: 'AIM_CURSOR', x: 0, y: 0, trailingBytes: 0 });
});
