// Senpai Agar (LWGA-NANO 250710A) wire protocol decoder.
// Reconstructed from the deobfuscated client bundle /nano/assets/index-3b34c03e.js.
// Decode-only: parses server->client and client->server frames for analysing
// captures and replays. Quirks of the original codec are reproduced on purpose
// and marked QUIRK.

export class Reader {
  constructor(buf) {
    this.u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.dv = new DataView(this.u8.buffer, this.u8.byteOffset, this.u8.byteLength);
    this.pos = 0;
  }
  get remaining() { return this.u8.length - this.pos; }
  need(n) { if (this.pos + n > this.u8.length) throw new RangeError(`read past end @${this.pos}+${n}`); }
  u8_() { this.need(1); return this.u8[this.pos++]; }
  u16() { this.need(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  u16be() { this.need(2); const v = this.dv.getUint16(this.pos, false); this.pos += 2; return v; }
  u24() { const hi = this.u16be(); return (hi << 8) | this.u8_(); }            // big-endian 24-bit
  u32() { this.need(4); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  i16() { const v = this.u16(); return v >= 32768 ? v - 65536 : v; }
  // QUIRK: client subtracts 2^32-1, not 2^32, so 0xFFFFFFFF reads as 0 and 0xFFFFFFFE as -1.
  i32() { const v = this.u32(); return v >= 2147483648 ? v - 4294967295 : v; }
  f32() { this.need(4); const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  // "StringEx": u16 length, then that many UTF-16LE code units.
  strEx() { const n = this.u16(); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.u16()); return s; }
  // Null-terminated UTF-8.
  strUtf8() {
    const start = this.pos; while (this.u8_() !== 0) { /* scan */ }
    return new TextDecoder().decode(this.u8.subarray(start, this.pos - 1));
  }
  // Variable-length ints used by the compact ("Swal") world-update encoding.
  dlb16() { const b = this.u8_(); return b > 127 ? ((b & 127) << 8) | this.u8_() : b; }
  dlb24() { const v = this.u16be(); return v > 32767 ? ((v & 0x7fff) << 8) | this.u8_() : v; }
  dlb24s() { const v = this.dlb24(); return (v >> 1) * (v & 1 ? -1 : 1); }
}

// Confirmed by live capture: type 1 = food pellet (mass 10, random colour), type 3 = ejected
// mass (mass 15, owner = ejecting player; the client calls it "food" as in "feed").
export const CellType = { PLAYER: 0, PELLET: 1, VIRUS: 2, EJECTED: 3 };
// Player ids carry the controlled unit in bit 0 (each client can drive two units).
export const decodePlayerId = (id) => ({ clientId: id & 0xfffe, unit: id & 1 });
export const massToRadius = (mass) => Math.sqrt(100 * mass);

export const ServerOp = {
  SELF_USER_ID: 43, FIELD_BOUNDS: 65, USER_INFOS: 42, USER_LEAVE: 45, PLAYER_COLORS: 39,
  TEAM_INFOS: 36, TEAM_REMOVAL: 35, CLEAR_NODES: 18, WORLD_UPDATE: 15, LEADERBOARD: 47,
  TEAM_RANKING: 46, MINIMAP: 41, CHAT: 128, NOOP: 14, CHAT_ENABLE: 120, CHAT_DISABLE: 121,
  PROFILE_COMMENT: 122, CHAT2: 123, LATENCY_REPLY: 131, SERVER_VERSION: 133, SERVER_OPTIONS: 200,
  INSTRUCTION_TEXT: 201, DISPLAY_MESSAGE: 202, STATUS_TEXT: 203, USER_COUNTS: 91, TEAM_CIRCLE: 19,
  ECHO_244: 244, ECHO_245: 245, SERVER_FULL: 246,
  // Sent by TsOgarRx servers but ignored by the client (confirmed in a live capture):
  // 32 = Ogar AddNode (u32 id of a newly created own cell), 16 = Ogar UpdateNodes and
  // 208 = one-byte marker, both only in the first ~200 ms before the server switches to LWGA.
  OGAR_ADD_NODE: 32, OGAR_UPDATE_NODES: 16, OGAR_208: 208,
  // Internal recording opcodes (written by the client into its replay buffer; also decodable).
  REC_NODE_REMOVAL: 161, REC_USER_INFO: 162, REC_PLAYER_COLOR: 163, REC_TEAM_COLOR: 164, REC_SIGHT_STATE: 166,
};

export const ClientOp = {
  SESSION_INIT: 252, AIM_CURSOR: 16, USER_ENTRY: 30, START_PLAY: 31, START_SPECTATE: 1,
  PLAYER_ACTION: 25, CHAT_LEGACY: 128, LATENCY_REQUEST: 130, SPEC_TARGET: 27, CHAT_GAME: 124,
  CHAT_AVAILABILITY: 126, PROFILE_COMMENT: 127,
  COMMAND: 125, SANDBOX_MODE: 223, SANDBOX_INC_MASS: 51, SANDBOX_DEC_MASS: 52, SANDBOX_CLEAN: 53,
  ECHO_244: 244, ECHO_245: 245,
};

export const PlayerAction = { SPLIT: 0, FEED_ONE: 1, CHANGE_UNIT: 3, FEED_HOLD: 4, FREEZE: 5 };

const nameOf = (table, op) => Object.keys(table).find((k) => table[k] === op) ?? `UNKNOWN_${op}`;

// Stateful because opcode 133 switches opcode 15 to the compact encoding.
export class ServerDecoder {
  constructor() { this.compact = false; }

  decode(buf) {
    const r = new Reader(buf);
    const op = r.u8_();
    const out = { op, name: nameOf(ServerOp, op) };
    switch (op) {
      case 43: out.selfUserId = r.u16(); break;
      case 65: out.bounds = { minX: r.f32(), minY: r.f32(), maxX: r.f32(), maxY: r.f32() }; break;
      case 42: {
        out.users = [];
        for (let n = r.u16(); n > 0; n--) {
          const u = { clientId: r.u16(), name: r.strEx(), team: r.strEx(), skin1: r.strEx() };
          const kind = r.u8_();
          u.isBot = kind === 1;
          if (kind === 2) { u.enableChat = r.u8_() > 0; u.profileComment = r.strEx(); }
          u.teamId = r.u16(); u.tripKey = r.strEx(); u.skin2 = r.strEx();
          out.users.push(u);
        }
        break;
      }
      case 45: out.leftClientIds = []; for (let n = r.u16(); n > 0; n--) out.leftClientIds.push(r.u16()); break;
      case 39: {
        out.colors = [];
        for (let n = r.u16(); n > 0; n--) {
          const playerId = r.u16(); r.u16(); // second u16 is read and discarded by the client
          const R = r.u8_(), G = r.u8_(), B = r.u8_(), flags = r.u8_();
          out.colors.push({ playerId, rgb: (R << 16) | (G << 8) | B, flags });
        }
        break;
      }
      case 36: {
        out.teams = [];
        for (let n = r.u16(); n > 0; n--) out.teams.push({ teamId: r.u16(), name: r.strEx(), colorHtml: r.strEx(), extra: r.strEx() });
        break;
      }
      case 35: out.removedTeamIds = []; for (let n = r.u16(); n > 0; n--) out.removedTeamIds.push(r.u16()); break;
      case 18: case 14: case 131: case 244: case 245: case 246: case 208: break;
      case 32: out.nodeId = r.u32(); break;
      case 16: out.legacyOgar = true; r.pos = r.u8.length; break; // not parsed: vanilla Ogar node format
      case 15: Object.assign(out, this.#worldUpdate(r)); break;
      case 47: out.entries = []; for (let n = r.u8_(); n > 0; n--) out.entries.push({ clientId: r.u16(), score: r.u32() }); break;
      case 46: out.entries = []; for (let n = r.u8_(); n > 0; n--) out.entries.push({ teamId: r.u16(), score: r.u16() }); break;
      case 41: out.players = []; for (let n = r.u16(); n > 0; n--) out.players.push({ playerId: r.u16(), x: r.i16(), y: r.i16(), mass: r.u16() }); break;
      case 128: out.clientId = r.u16(); r.strEx(); out.text = r.strEx(); break;
      case 120: case 121: out.clientId = r.u16be(); break;
      case 122: out.clientId = r.u16be(); out.comment = r.strUtf8(); break;
      case 123: {
        out.channel = r.u8_(); // 1 all, 2 team, 3 private, 4 system
        out.clientId = r.u16be(); out.text = r.strUtf8();
        if (out.channel === 3) out.peerId = r.u16be();
        break;
      }
      case 133: out.version = r.strEx(); this.compact = out.version.includes('Swal'); out.compact = this.compact; break;
      case 200: out.options = JSON.parse(r.strEx()); break;
      case 201: case 202: case 203: out.text = r.strEx(); break;
      // Live frames carry 4 extra zero bytes after the text that the client never reads.
      case 91: r.u16(); out.counts = [r.u16(), r.u16(), r.u16(), r.u16()]; out.text = r.strEx(); r.pos = r.u8.length; break;
      case 19: r.u8_(); out.circle = { x: r.i32(), y: r.i32(), radius: r.i32() }; break;
      case 161: out.nodeId = r.u32(); break;
      case 162: out.user = { clientId: r.u16(), name: r.strEx(), team: r.strEx(), teamId: r.u16(), skin1: r.strEx(), skin2: r.strEx() }; break;
      case 163: out.playerId = r.u16(); out.color = r.u32(); break;
      case 164: out.teamId = r.u16(); out.color = r.u32(); break;
      case 166: out.sight = { eyeX: r.i32(), eyeY: r.i32(), scale: r.f32(), aimX: r.i32(), aimY: r.i32(), splitting: r.u8_() > 0, aimPlayerId: r.u16() }; break;
      default: out.unknown = true;
    }
    out.trailingBytes = r.remaining;
    return out;
  }

  #worldUpdate(r) {
    const res = { eye: { x: r.f32(), y: r.f32() }, compact: this.compact };
    // Ignored by the client. Live values are always 4:3 (7920x5940 at spawn, shrinking as you
    // grow), so these are very likely the server's view-range width and height in world units.
    res.view = { w: r.f32(), h: r.f32() };
    if (r.u8_() > 0) {
      const playerId = r.u16();
      res.aim = { playerId, x: r.f32(), y: r.f32() };
      res.aim.splitting = (r.u8_() & 1) > 0;
      res.aim.score = r.u32();
    }
    res.nodes = [];
    for (;;) {
      const nodeId = this.compact ? r.dlb24() : r.u32();
      if (nodeId === 0) break;
      res.nodes.push(this.compact ? this.#nodeCompact(r, nodeId) : this.#nodeLegacy(r, nodeId));
    }
    res.removed = [];
    for (let n = r.u16(); n > 0; n--) res.removed.push(r.u32());
    return res;
  }

  #nodeLegacy(r, nodeId) {
    const n = { nodeId, type: r.u8_(), x: r.f32(), y: r.f32(), mass: r.u16(), owner: r.u16(), color: 0 };
    if (n.type === 1) n.color = r.u32();
    if (r.u8_()) { n.motionAngle = r.f32(); n.motionSpeed = r.f32(); }
    return n;
  }

  #nodeCompact(r, nodeId) {
    let type = r.u8_(), x, y, mass, owner = 0, color = 0;
    if (type === 4) { x = r.f32(); y = r.f32(); mass = r.dlb24(); type = 0; } // full-precision player cell
    else { x = r.dlb24s(); y = r.dlb24s(); mass = type === 0 ? r.dlb24() : r.dlb16(); }
    if (type === 0 || type === 3) owner = r.u16();
    if (type === 1) color = r.u24();
    const n = { nodeId, type, x, y, mass, owner, color };
    if (r.u8_()) { n.motionAngle = r.f32(); n.motionSpeed = r.f32(); }
    return n;
  }
}

export function decodeClient(buf) {
  const r = new Reader(buf);
  const op = r.u8_();
  const out = { op, name: nameOf(ClientOp, op) };
  switch (op) {
    case 252: out.protocol = r.strEx(); out.envSig = r.strEx(); out.fingerprint = r.strEx(); break;
    case 16: out.x = r.i32(); out.y = r.i32(); break;
    // Field order on the wire differs from the call order: name, team, skin1, code, skin2.
    case 30: out.name = r.strEx(); out.team = r.strEx(); out.skin1 = r.strEx(); out.code = r.strEx(); out.skin2 = r.strEx(); break;
    case 25: out.action = r.u8_(); out.actionName = nameOf(PlayerAction, out.action); out.arg = r.u8_(); break;
    case 128: out.clientId = r.u16(); r.strEx(); out.text = r.strEx(); break;
    case 27: out.targetPlayerId = r.i32(); break;
    case 124: out.channel = r.u8_(); out.text = r.strUtf8(); if (out.channel === 3) out.peerId = r.u16be(); break;
    case 125: case 127: case 223: out.text = r.strUtf8(); break;
    case 126: out.availability = r.u8_(); break; // 0 off; 1 on (Swal server); 2 on (UniChat server)
    case 31: case 1: case 130: case 51: case 52: case 53: case 244: case 245: break;
    default: out.unknown = true;
  }
  out.trailingBytes = r.remaining;
  return out;
}
