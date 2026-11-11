// Server -> client packet builders, byte-compatible with the LWGA-NANO client's
// DataFrameReader (see PROTOCOL.md §5 and §7). The world update uses the legacy
// (non-"Swal") encoding, so the version string must not contain "Swal".

export class Writer {
  constructor(size = 256) { this.buf = new Uint8Array(size); this.dv = new DataView(this.buf.buffer); this.len = 0; }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2; while (cap < this.len + n) cap *= 2;
    const nb = new Uint8Array(cap); nb.set(this.buf.subarray(0, this.len));
    this.buf = nb; this.dv = new DataView(nb.buffer);
  }
  u8(v) { this.ensure(1); this.buf[this.len++] = v & 255; return this; }
  u16(v) { this.ensure(2); this.dv.setUint16(this.len, v & 0xffff, true); this.len += 2; return this; }
  u16be(v) { this.ensure(2); this.dv.setUint16(this.len, v & 0xffff, false); this.len += 2; return this; }
  u32(v) { this.ensure(4); this.dv.setUint32(this.len, v >>> 0, true); this.len += 4; return this; }
  // Mirror the client's int32 rule (negatives offset by 2^32 - 1) so it reads back exactly.
  i32(v) { v = Math.trunc(v); return this.u32(v < 0 ? v + 4294967295 : v); }
  i16(v) { v = Math.max(-32768, Math.min(32767, Math.round(v))); return this.u16(v < 0 ? v + 65536 : v); }
  f32(v) { this.ensure(4); this.dv.setFloat32(this.len, v, true); this.len += 4; return this; }
  strEx(s) { s = String(s ?? ''); this.u16(s.length); for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i)); return this; }
  strUtf8(s) { const b = new TextEncoder().encode(String(s ?? '')); this.ensure(b.length + 1); this.buf.set(b, this.len); this.len += b.length; return this.u8(0); }
  get bytes() { return this.buf.slice(0, this.len); }
}

const op = (code) => new Writer().u8(code);
const clampU16 = (v) => Math.max(0, Math.min(65535, Math.round(v)));

export const ServerPackets = {
  version: (text) => op(133).strEx(text).bytes,
  selfUserId: (clientId) => op(43).u16(clientId).bytes,
  fieldBounds: ({ minX, minY, maxX, maxY }) => op(65).f32(minX).f32(minY).f32(maxX).f32(maxY).bytes,
  instruction: (html) => op(201).strEx(html).bytes,
  displayMessage: (text) => op(202).strEx(text).bytes,
  status: (text) => op(203).strEx(text).bytes,
  options: (obj) => op(200).strEx(JSON.stringify(obj)).bytes,
  clearNodes: () => op(18).bytes,
  latencyReply: () => op(131).bytes,

  // users: [{ clientId, name, team, skin1, skin2, isBot, teamId, tripKey }]
  userInfos(users) {
    const w = op(42).u16(users.length);
    for (const u of users) {
      w.u16(u.clientId).strEx(u.name).strEx(u.team).strEx(u.skin1).u8(u.isBot ? 1 : 0)
        .u16(u.teamId ?? 0).strEx(u.tripKey ?? '').strEx(u.skin2);
    }
    return w.bytes;
  },
  userLeave: (ids) => { const w = op(45).u16(ids.length); ids.forEach((id) => w.u16(id)); return w.bytes; },

  // colors: [{ playerId, rgb }] - one entry per unit (playerId = clientId | unit)
  playerColors(colors) {
    const w = op(39).u16(colors.length);
    for (const c of colors) w.u16(c.playerId).u16(0).u8(c.rgb >> 16).u8(c.rgb >> 8).u8(c.rgb).u8(c.playerId & 1);
    return w.bytes;
  },

  // entries: [{ clientId, score }], at most 255
  leaderboard(entries) {
    const w = op(47).u8(entries.length);
    for (const e of entries) w.u16(e.clientId).u32(Math.round(e.score));
    return w.bytes;
  },
  // players: [{ playerId, x, y, mass }]
  minimap(players) {
    const w = op(41).u16(players.length);
    for (const p of players) w.u16(p.playerId).i16(p.x).i16(p.y).u16(clampU16(p.mass));
    return w.bytes;
  },
  userCounts: (playing, total, spectating, max, mode) => op(91).u16(0).u16(playing).u16(total).u16(spectating).u16(max).strEx(mode).bytes,

  chat2: (channel, clientId, text) => op(123).u8(channel).u16be(clientId).strUtf8(text).bytes,

  // update: { eye:{x,y}, view:{w,h}, aim:{playerId,x,y,splitting,score}|null, nodes:[...], removed:[ids] }
  // node: { id, type, x, y, mass, owner, color, boost, angle }
  worldUpdate(u) {
    const w = new Writer(64 + u.nodes.length * 32 + u.removed.length * 4);
    w.u8(15).f32(u.eye.x).f32(u.eye.y).f32(u.view.w).f32(u.view.h);
    if (u.aim) {
      w.u8(1).u16(u.aim.playerId).f32(u.aim.x).f32(u.aim.y).u8(u.aim.splitting ? 1 : 0).u32(Math.round(u.aim.score));
    } else w.u8(0);
    for (const n of u.nodes) {
      w.u32(n.id).u8(n.type).f32(n.x).f32(n.y).u16(clampU16(n.mass)).u16(n.owner ?? 0);
      if (n.type === 1) w.u32(n.color ?? 0);
      if (n.boost > 0.5) w.u8(1).f32(n.angle).f32(n.boost); else w.u8(0);
    }
    w.u32(0);
    w.u16(u.removed.length);
    for (const id of u.removed) w.u32(id);
    return w.bytes;
  },
};
