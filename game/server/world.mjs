// World simulation for the recreation server. One instance, stepped at config.tickMs.
// Rules follow the measurements in PROTOCOL.md §14; anything marked GUESS was not
// observable from the client and is a sensible Ogar-style default.

export const Type = { PLAYER: 0, PELLET: 1, VIRUS: 2, EJECTED: 3 };
export const radiusOf = (mass) => Math.sqrt(100 * mass);

const rand = (a, b) => a + Math.random() * (b - a);
const brightColor = () => {
  const c = [255, Math.floor(Math.random() * 100), Math.floor(Math.random() * 256)].sort(() => Math.random() - 0.5);
  return (c[0] << 16) | (c[1] << 8) | c[2];
};

class Cell {
  constructor(id, type, x, y, mass) {
    this.id = id; this.type = type; this.x = x; this.y = y; this.mass = mass;
    this.owner = 0;      // playerId (clientId | unit) for player cells and ejected mass
    this.color = 0;      // pellets only (player colours travel in opcode 39)
    this.boost = 0;      // player cells: split boost, reported as motionSpeed
    this.angle = 0;
    this.step = 0;       // ejected mass / shot viruses: per-tick travel
    this.born = 0;
    this.feeds = 0;      // viruses
    this.dead = false;
  }
  get r() { return radiusOf(this.mass); }
}

export class Unit {
  constructor(player, index) {
    this.player = player; this.index = index;
    this.cells = [];
    this.aim = { x: 0, y: 0 };
    this.splitQueue = 0;            // split passes still to do, one per tick
    this.ejectQueue = 0;            // single feeds waiting for the next tick
    this.color = brightColor();
  }
  get playerId() { return this.player.clientId | this.index; }
  get mass() { return this.cells.reduce((s, c) => s + c.mass, 0); }
}

export class Player {
  constructor(clientId) {
    this.clientId = clientId; this.isBot = false;
    this.name = ''; this.team = ''; this.skin1 = ''; this.skin2 = ''; this.code = '';
    this.units = [new Unit(this, 0), new Unit(this, 1)];
    this.activeUnit = 0;
    this.playing = false;
    this.pointer = { x: 0, y: 0 };  // last aim cursor, also the spectator camera
    this.specTarget = -1;           // -1 free camera, 0 server's choice, else a playerId
    this.feedHold = false;
    this.frozen = false;            // Stop Motion (S): stops both units, as on Caffe
    this.noDecay = false;           // Mass Decay switched off by this player (setting or /decay off)
    this.diedAt = 0;
  }
  get alive() { return this.units.some((u) => u.cells.length > 0); }
  get mass() { return this.units[0].mass + this.units[1].mass; }
  get active() { return this.units[this.activeUnit]; }
  center() {
    let x = 0, y = 0, m = 0;
    for (const u of this.units) for (const c of u.cells) { x += c.x * c.mass; y += c.y * c.mass; m += c.mass; }
    return m ? { x: x / m, y: y / m } : null;
  }
}

export class World {
  constructor(config) {
    this.cfg = config;
    this.cells = new Map();
    this.players = new Map();     // clientId -> Player
    this.nextId = 1;
    this.tickCount = 0;
    this.now = 0;
    this.pelletCount = 0;
    this.virusCount = 0;
    this.ghosts = [];             // cells eaten this tick, still sent once (see remove)
  }

  // ---- ids and spawning ---------------------------------------------------------------
  allocId() { const id = this.nextId; this.nextId = this.nextId >= 0xfffffff0 ? 1 : this.nextId + 1; return id; }
  add(type, x, y, mass) {
    const c = new Cell(this.allocId(), type, x, y, mass); c.born = this.now;
    this.cells.set(c.id, c);
    if (type === Type.PELLET) this.pelletCount++;
    if (type === Type.VIRUS) this.virusCount++;
    return c;
  }
  // eaten = true: Caffe still sends an eaten cell in the next update, at its last position,
  // and removes it one tick later (the eater has already grown around it). That is the
  // "swallow" you see. Eaten cells wait in this.ghosts for that one update.
  remove(c, eaten = false) {
    if (c.dead) return; c.dead = true; this.cells.delete(c.id);
    if (eaten && this.cfg.eatenLinger !== false) this.ghosts.push(c);
    if (c.type === Type.PELLET) this.pelletCount--;
    if (c.type === Type.VIRUS) this.virusCount--;
    if (c.type === Type.PLAYER && c.unit) {
      const arr = c.unit.cells, i = arr.indexOf(c); if (i >= 0) arr.splice(i, 1);
      const p = c.unit.player;
      // the unit you control died: control goes to your other unit
      if (!arr.length && p.active === c.unit && p.units[p.activeUnit ^ 1].cells.length) p.activeUnit ^= 1;
      if (!p.alive && p.playing) { p.playing = false; p.diedAt = this.now; }
    }
  }
  // With an infinite field, "random" positions are drawn from the spawn area around the origin.
  randomPos(margin = 200, area = this.cfg.spawnArea) {
    if (this.cfg.infiniteField) return { x: rand(-area, area), y: rand(-area, area) };
    const f = this.cfg.field;
    return { x: rand(f.minX + margin, f.maxX - margin), y: rand(f.minY + margin, f.maxY - margin) };
  }
  // Measured on Caffe: a player cell's centre is kept wallMargin * r (half its radius) inside
  // the wall, and only when it moves. Pushes between its own cells can shove it further out;
  // it is pulled back on its next move. Other cells stop at the wall itself.
  clamp(c) {
    if (this.cfg.infiniteField) return;
    const f = this.cfg.field, m = c.type === Type.PLAYER ? (this.cfg.wallMargin ?? 0.5) * c.r : 0;
    c.x = Math.max(f.minX + m, Math.min(f.maxX - m, c.x)); c.y = Math.max(f.minY + m, Math.min(f.maxY - m, c.y));
  }

  // Ogar rule: a cell may recombine only after base + factor * mass seconds have passed
  // since it last split. Both halves of a split get a fresh timer.
  stampMergeTimer(c) {
    c.mergeAt = this.now + (this.cfg.recombineBaseSec + this.cfg.recombineMassFactor * c.mass) * 1000;
  }

  // `at` is where to put the cell; without it, a random spot in the spawn area.
  spawnUnit(unit, at = null) {
    if (unit.cells.length) return;
    const pos = at ?? this.randomPos(1000);
    const c = this.add(Type.PLAYER, pos.x, pos.y, this.cfg.spawnMass);
    c.owner = unit.playerId; c.unit = unit; c.mergeAt = 0; unit.splitQueue = 0; unit.ejectQueue = 0;
    this.clamp(c);
    unit.cells.push(c);
    unit.aim = { x: c.x, y: c.y };
    if (!at) unit.player.pointer = { x: c.x, y: c.y };
    unit.player.playing = true;
  }

  // Second unit (Tab): appears at the cursor, but never further than secondUnitMaxDist
  // from the edge of the player's existing cells.
  spawnSecondUnit(player, unit) {
    const center = player.center();
    if (!center) return this.spawnUnit(unit);
    let reach = 0;
    for (const u of player.units) for (const c of u.cells) reach = Math.max(reach, Math.hypot(c.x - center.x, c.y - center.y) + c.r);
    const max = reach + this.cfg.secondUnitMaxDist;
    const dx = player.pointer.x - center.x, dy = player.pointer.y - center.y, d = Math.hypot(dx, dy);
    const k = d > max ? max / d : 1;
    // Never on top of a cell that could eat it: draw the random spot again (up to 50 times);
    // if every try lands on one, move it out just clear of that cell.
    const cfg = this.cfg, r = Math.sqrt(100 * cfg.spawnMass);
    const eater = (x, y) => {
      for (const c of this.cells.values()) {
        if (c.type !== Type.PLAYER || c.mass < cfg.spawnMass * cfg.eatRatio) continue;
        if (Math.hypot(c.x - x, c.y - y) < c.r + r) return c;
      }
      return null;
    };
    let pos;
    for (let i = 0; i < 50; i++) {
      const a = Math.random() * Math.PI * 2, s = cfg.secondUnitScatter * Math.sqrt(Math.random());
      pos = { x: center.x + dx * k + Math.cos(a) * s, y: center.y + dy * k + Math.sin(a) * s };
      if (!eater(pos.x, pos.y)) break;
    }
    for (let c = eater(pos.x, pos.y), n = 0; c && n < 16; c = eater(pos.x, pos.y), n++) {
      const ddx = pos.x - c.x, ddy = pos.y - c.y, dd = Math.hypot(ddx, ddy) || 1;
      const out = c.r + r + 1;
      pos = { x: c.x + (ddx / dd) * out, y: c.y + (ddy / dd) * out };
    }
    this.spawnUnit(unit, pos);
    unit.aim = { ...player.pointer };
  }

  // ---- player actions -----------------------------------------------------------------
  // Split order (Ogar's splitCells, and what Senpai's own client predicts with its split
  // order marker): walk the unit's cells in CREATION order, oldest first. Each cell at or
  // above minSplitMass splits until the unit has maxCellsPerUnit cells. New halves are
  // appended at the end (they are the newest), and eaten or merged cells drop out without
  // reordering the rest. split(unit, n) does n passes at once; players go through
  // requestSplit, which spreads the passes over ticks like Caffe.
  // Returns how many new cells were made.
  split(unit, times = 1) {
    const cfg = this.cfg;
    let made = 0;
    for (let k = 0; k < times; k++) {
      const len = unit.cells.length; // only cells that existed before this pass split in it
      for (let i = 0; i < len; i++) {
        const c = unit.cells[i];
        if (unit.cells.length >= cfg.maxCellsPerUnit) return made;
        if (c.mass < cfg.minSplitMass) continue;
        const half = c.mass / 2;
        let angle = Math.atan2(unit.aim.y - c.y, unit.aim.x - c.x);
        if (!Number.isFinite(angle)) angle = Math.random() * Math.PI * 2;
        c.mass = half; c.born = this.now; this.stampMergeTimer(c);
        const n = this.add(Type.PLAYER, c.x, c.y, half);
        n.owner = unit.playerId; n.unit = unit;
        n.boost = this.splitBoostFor(n); n.angle = angle;
        this.stampMergeTimer(n);
        unit.cells.push(n);
        made++;
      }
    }
    return made;
  }

  // Measured on Caffe from 3162 split pieces (mass 16 to 9000) in a live log: the starting
  // motionSpeed is a + b*ln(r) + c*ln(r)^2 (195.3 at mass 32, 192.9 at 1000, 190.7 at 8000),
  // within 0.01 RMS. Smaller pieces are thrown slightly faster.
  splitBoostFor(cell) {
    const [a, b, c] = this.cfg.splitBoostLn, L = Math.log(cell.r);
    return a + b * L + c * L * L;
  }

  // A double, triple or full split (SPLIT n) on Caffe is n single splits on consecutive
  // ticks: one piece becomes 2, then 4, 8 and 16 pieces 40 ms apart, each pass starting
  // from where the previous pieces have flown to. Doing all passes in one tick stacks
  // every piece of a cell on the same spot, flying along the same line.
  // Passes run in the tick after cells have moved, so a new piece is sent at the spot it was
  // born and starts flying on the next tick (as on Caffe, where a piece first shows up on its
  // parent's centre).
  requestSplit(unit, n) { unit.splitQueue = (unit.splitQueue || 0) + n; }
  // Measured on Caffe (73 full splits in a live log): a full split is exactly 4 passes on 4
  // consecutive ticks, and a pass that cannot split anything (16 cells already) does NOT
  // cancel the rest. If cells get eaten meanwhile, the remaining passes refill the free
  // slots, which is what spamming the full split key relies on.
  runSplitQueue(unit) {
    if (!(unit.splitQueue > 0)) return;
    unit.splitQueue--;
    this.split(unit, 1);
  }
  requestEject(unit) { unit.ejectQueue = (unit.ejectQueue || 0) + 1; }

  // Measured on Caffe: the ejected mass appears exactly at the cell's edge as it was before
  // the mass was taken off, and is shown there for one tick before it starts to fly.
  eject(unit) {
    const cfg = this.cfg;
    for (const c of unit.cells) {
      if (c.mass < cfg.ejectMinMass) continue;
      const edge = c.r;
      c.mass -= cfg.ejectCost;
      let angle = Math.atan2(unit.aim.y - c.y, unit.aim.x - c.x);
      if (!Number.isFinite(angle)) angle = Math.random() * Math.PI * 2;
      angle += rand(-0.05, 0.05); // GUESS: slight spread so streams don't stack exactly
      const e = this.add(Type.EJECTED, c.x + Math.cos(angle) * edge, c.y + Math.sin(angle) * edge, cfg.ejectMass);
      e.owner = unit.playerId; e.angle = angle; e.step = cfg.ejectFirstStep;
    }
  }

  // Mass decay, measured on Caffe: every tick each cell loses a fraction of its mass, and the
  // rate grows slowly with the cell's own mass:
  //   per second = decayBase + decayPerMass * mass   (0.145 % at 1K, 0.150 % at 3.4K,
  //   0.160 % at 7.5K, 0.169 % at 11.4K)
  // A unit decays only while its total mass is above decayMinTotal (the spawn mass): a
  // freshly split 399 (two 199s) keeps its mass, while a 155 piece of an 8.4K player decays.
  decayMass() {
    const cfg = this.cfg;
    if (!(cfg.decayBase > 0) && !(cfg.decayPerMass > 0)) return;
    const dt = cfg.tickMs / 1000;
    for (const p of this.players.values()) for (const u of p.units) {
      if (p.noDecay || u.mass <= cfg.decayMinTotal) continue;
      for (const c of u.cells) c.mass *= 1 - (cfg.decayBase + cfg.decayPerMass * c.mass) * dt;
    }
  }

  // Auto split (Ogar PlayerCell.addMass / MultiOgar autoSplit): a cell heavier than
  // autoSplitMass throws half of its mass off in a random direction, with split speed.
  // If its unit already has maxCellsPerUnit cells it cannot split, so its mass is capped
  // at autoSplitMass instead. Checked every tick, so any way of gaining mass (eating,
  // merging, feeding, sandbox keys, /mass) triggers it. A very big cell keeps halving
  // once per tick until every piece is under the limit or the unit is full.
  autoSplit(unit) {
    const cfg = this.cfg, limit = cfg.autoSplitMass;
    if (!(limit > 0)) return;
    const len = unit.cells.length; // halves made this tick are checked next tick
    for (let i = 0; i < len; i++) {
      const c = unit.cells[i];
      if (c.mass <= limit) continue;
      if (unit.cells.length >= cfg.maxCellsPerUnit) { c.mass = limit; continue; }
      const half = c.mass / 2;
      c.mass = half; c.born = this.now; this.stampMergeTimer(c);
      const n = this.add(Type.PLAYER, c.x, c.y, half);
      n.owner = unit.playerId; n.unit = unit;
      n.boost = this.splitBoostFor(n); n.angle = Math.random() * Math.PI * 2;
      this.stampMergeTimer(n);
      unit.cells.push(n);
    }
  }

  popOnVirus(cell) { // GUESS: Ogar-style pop into equal pieces flying in random directions
    const unit = cell.unit, cfg = this.cfg;
    const slots = cfg.maxCellsPerUnit - unit.cells.length;
    const pieces = Math.min(slots, Math.floor(cell.mass / 36) - 1);
    if (pieces <= 0) return;
    const pieceMass = cell.mass / (pieces + 1);
    cell.mass = pieceMass; cell.born = this.now; this.stampMergeTimer(cell);
    for (let i = 0; i < pieces; i++) {
      const n = this.add(Type.PLAYER, cell.x, cell.y, pieceMass);
      n.owner = unit.playerId; n.unit = unit; n.boost = this.splitBoostFor(n) * 0.8; n.angle = Math.random() * Math.PI * 2;
      this.stampMergeTimer(n);
      unit.cells.push(n);
    }
  }

  // ---- spatial grid -------------------------------------------------------------------
  buildGrid() {
    const size = 512, grid = new Map();
    for (const c of this.cells.values()) {
      const k = (Math.floor(c.x / size) << 16) | (Math.floor(c.y / size) & 0xffff);
      let b = grid.get(k); if (!b) grid.set(k, (b = [])); b.push(c);
    }
    this.grid = grid; this.gridSize = size;
  }
  query(x0, y0, x1, y1, fn) {
    const s = this.gridSize;
    for (let gx = Math.floor(x0 / s); gx <= Math.floor(x1 / s); gx++)
      for (let gy = Math.floor(y0 / s); gy <= Math.floor(y1 / s); gy++) {
        const b = this.grid.get((gx << 16) | (gy & 0xffff)); if (b) for (const c of b) fn(c);
      }
  }

  // ---- the tick -----------------------------------------------------------------------
  tick(now) {
    const cfg = this.cfg; this.now = now; this.tickCount++;
    this.ghosts = []; // last tick's eaten cells have been sent once; now they are gone

    for (const p of this.players.values()) for (const u of p.units) for (const c of u.cells) this.moveCell(c, u);
    for (const c of this.cells.values()) {
      if (c.step > 0) {
        c.x += Math.cos(c.angle) * c.step; c.y += Math.sin(c.angle) * c.step;
        c.step = c.step * (c.type === Type.EJECTED ? cfg.ejectDecay : 0.9);
        if (c.step < 1) c.step = 0;
        this.clamp(c);
      }
    }
    // Actions happen after movement, so new pieces and ejected mass are first sent where
    // they were made (Caffe shows them there for one tick before they move).
    for (const p of this.players.values()) {
      for (const u of p.units) this.runSplitQueue(u); // one pass of a double / full split per tick
      for (const u of p.units) { while (u.ejectQueue > 0) { u.ejectQueue--; this.eject(u); } }
      if (p.feedHold && this.tickCount % cfg.ejectHoldIntervalTicks === 0) this.eject(p.active);
    }

    for (const p of this.players.values()) for (const u of p.units) this.resolveOwnCells(u);
    this.buildGrid();
    this.resolveEating();
    this.resolveVirusFeeding();

    this.decayMass();
    for (const p of this.players.values()) for (const u of p.units) this.autoSplit(u);
    while (this.pelletCount < cfg.pelletCount) {
      const pos = this.randomPos(50, cfg.pelletArea); this.add(Type.PELLET, pos.x, pos.y, cfg.pelletMass).color = brightColor();
    }
    while (this.virusCount < cfg.virusCount) { const pos = this.randomPos(500, cfg.pelletArea); this.add(Type.VIRUS, pos.x, pos.y, cfg.virusMass); }
    this.buildGrid(); // fresh grid for visibility queries, without eaten cells
  }

  moveCell(c, unit) {
    const cfg = this.cfg;
    if (!unit.player.frozen) {
      const dx = unit.aim.x - c.x, dy = unit.aim.y - c.y, d = Math.hypot(dx, dy);
      if (d > 1) {
        const step = Math.min(d, cfg.speedCoefficient * Math.pow(c.r, cfg.speedExponent));
        c.x += (dx / d) * step; c.y += (dy / d) * step;
      }
    }
    // Measured on Caffe: the split speed decays first, then the cell travels half of it on
    // top of its normal move (194.1 at birth, then 172.1 and a 95.7 step, ...). It stops
    // once it falls under about 2.5.
    if (c.boost > 0) {
      c.boost *= cfg.splitBoostDecay;
      if (c.boost < cfg.splitBoostStop) c.boost = 0;
      else {
        c.x += Math.cos(c.angle) * c.boost * cfg.boostTravelFactor;
        c.y += Math.sin(c.angle) * c.boost * cfg.boostTravelFactor;
      }
    }
    this.clamp(c);
  }

  // Cells of the same unit push apart until their merge timer has elapsed, then combine.
  resolveOwnCells(unit) {
    const cfg = this.cfg, cells = unit.cells;
    for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i], b = cells[j]; if (a.dead || b.dead) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.001;
      const ra = a.r, rb = b.r;
      const canMerge = this.now >= (a.mergeAt ?? 0) && this.now >= (b.mergeAt ?? 0);
      if (canMerge) {
        const [big, small] = a.mass >= b.mass ? [a, b] : [b, a];
        if (d <= big.r - small.r * cfg.eatOverlap) {
          big.mass += small.mass; this.remove(small, true);
          if (small === a) { i--; break; }
          j--;
        }
      } else if (this.now - a.born >= cfg.splitNoCollideMs && this.now - b.born >= cfg.splitNoCollideMs) {
        // Ogar family: freshly split cells pass through each other briefly, then collide.
        const overlap = ra + rb - d;
        if (overlap > 0) {
          const total = a.mass + b.mass, nx = dx / d, ny = dy / d;
          const push = overlap * cfg.ownPushFraction; // Caffe: half the overlap per tick
          a.x -= nx * push * (b.mass / total); a.y -= ny * push * (b.mass / total);
          b.x += nx * push * (a.mass / total); b.y += ny * push * (a.mass / total);
        }
      }
    }
  }

  resolveEating() {
    const cfg = this.cfg;
    const eaters = [];
    for (const p of this.players.values()) for (const u of p.units) for (const c of u.cells) eaters.push(c);
    eaters.sort((a, b) => b.mass - a.mass);
    for (const a of eaters) {
      if (a.dead) continue;
      const ra = a.r;
      this.query(a.x - ra, a.y - ra, a.x + ra, a.y + ra, (b) => {
        if (b === a || b.dead || a.dead) return;
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        switch (b.type) {
          case Type.PELLET:
            if (d < ra) { a.mass += cfg.pelletMass; this.remove(b, true); }
            break;
          case Type.EJECTED:
            // Measured on Caffe: ejected mass can be eaten on the tick it is made (a piece thrown
            // inside one of your own cells is swallowed at once); a piece thrown from a cell's
            // outer edge is outside every eating range and flies off.
            if (d < ra - b.r * cfg.eatOverlap && a.mass >= b.mass * cfg.eatRatio) { a.mass += b.mass; this.remove(b, true); }
            break;
          case Type.VIRUS:
            if (a.mass >= b.mass * cfg.eatRatio && d <= ra - b.r * cfg.eatOverlap) { a.mass += b.mass; this.remove(b, true); this.popOnVirus(a); }
            break;
          case Type.PLAYER:
            if (!b.unit || b.unit === a.unit) return; // same unit: merge timer rules instead
            // Your two units are separate players to each other: either can eat the other
            // (this is what makes split running work).
            if (b.unit.player === a.unit.player && !cfg.ownUnitsCanEatEachOther) return;
            if (a.mass >= b.mass * cfg.eatRatio && d <= ra - b.r * cfg.eatOverlap) { a.mass += b.mass; this.remove(b, true); }
            break;
        }
      });
    }
  }

  resolveVirusFeeding() {
    const cfg = this.cfg;
    for (const v of [...this.cells.values()]) {
      if (v.type !== Type.VIRUS || v.dead) continue;
      const rv = v.r;
      this.query(v.x - rv, v.y - rv, v.x + rv, v.y + rv, (e) => {
        if (e.type !== Type.EJECTED || e.dead || Math.hypot(e.x - v.x, e.y - v.y) > rv) return;
        this.remove(e);
        // Each feed adds 16 mass; the original client's virus hint counts feeds left as
        // 7 - (mass - 100) / 16, so the virus shoots on the 7th feed.
        v.mass += cfg.virusFeedMass;
        if (v.mass >= cfg.virusMass + cfg.virusFeedsToShoot * cfg.virusFeedMass) {
          v.mass = cfg.virusMass;
          const shot = this.add(Type.VIRUS, v.x, v.y, cfg.virusMass);
          shot.angle = e.angle; shot.step = 120; // GUESS: shot-virus travel
        }
      });
    }
  }
}
