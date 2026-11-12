// Split analysis: for every split (human recordings or bot recordings), the position before,
// which cells split, where the pieces and parents went, and the shape by cell size.
//   node splits.mjs human|bot
import { readdirSync } from 'node:fs';
import { loadRecording } from '../recording.mjs';

import { ROOT } from './paths.mjs';
import { GAMES as SCR } from './paths.mjs';
const R = (m) => Math.sqrt(100 * m);
const cen = (cs) => { let m = 0, x = 0, y = 0; for (const c of cs) { m += c.mass; x += c.x * c.mass; y += c.y * c.mass; } return m ? { x: x / m, y: y / m, m } : null; };

export function load(file, skip) {
  const r = loadRecording(file);
  const byTick = new Map(r.frames.map((f) => [f.tick, f.cells.map(([id, pid, x, y, mass, boost, angle]) => ({ id, u: pid & 1, x, y, mass, boost, angle }))]));
  const bad = new Set(); let on = null;
  for (const e of r.events) if (e.ev === 'feedHold') {
    if (e.on) on = e.tick; else if (on != null) { for (let t = on - 25; t <= e.tick + 75; t++) bad.add(t); on = null; }
  }
  return { file, r, byTick, bad, start: r.t0 + skip, end: r.frames.at(-1).tick };
}

export function heading(rec, T) {
  const f = rec.byTick.get(T), fb = rec.byTick.get(T - 50);
  if (!f || !fb) return null;
  const c = cen(f), cb = cen(fb), dx = c.x - cb.x, dy = c.y - cb.y, d = Math.hypot(dx, dy);
  return d > 50 ? { x: dx / d, y: dy / d } : null;
}

// every split event (first pass only), with what happened next
export function splitEvents(rec) {
  const out = [];
  const aims = {}; let lastSplit = -99;
  for (const e of rec.r.events) {
    if (e.ev === 'aim') { aims[e.pid & 1] = { x: e.x, y: e.y }; continue; }
    if (e.ev !== 'split') continue;
    const T = e.tick, prev = lastSplit; lastSplit = T;
    if (T < rec.start || rec.bad.has(T) || T - prev < 6) continue;
    const f0 = rec.byTick.get(T), H = heading(rec, T);
    if (!f0 || !H) continue;
    const u = e.pid & 1;
    const mine = f0.filter((c) => c.u === u).sort((a, b) => a.id - b.id), other = f0.filter((c) => c.u !== u);
    if (!mine.length || !other.length) continue;
    const ids0 = new Set(f0.map((c) => c.id));
    // first frame with new pieces of unit u
    let F = null, Ft = 0;
    for (let t = T + 1; t <= T + 3; t++) { const f = rec.byTick.get(t); if (f && f.some((c) => c.u === u && !ids0.has(c.id))) { F = f; Ft = t; break; } }
    const C = cen(f0), total = C.m, s = Math.sqrt(total / 35000);
    const al = (c) => ((c.x - C.x) * H.x + (c.y - C.y) * H.y) / s, la = (c) => ((c.x - C.x) * -H.y + (c.y - C.y) * H.x) / s;
    const byMass = [...mine].sort((a, b) => b.mass - a.mass), max = byMass[0].mass;
    const Cu = cen(mine), Co = cen(other);
    const role = al(Cu) < al(Co) ? 'back' : 'front';
    const split = new Map(); // parent id -> piece id
    if (F) {
      const Fm = new Map(F.map((c) => [c.id, c]));
      for (const p of F.filter((c) => c.u === u && !ids0.has(c.id))) {
        let best = null, bd = 1e9;
        for (const q of mine) {
          const q1 = Fm.get(q.id); if (!q1) continue;
          const d = Math.hypot(q1.x - p.x, q1.y - p.y);
          if (d < bd && Math.abs(q1.mass - p.mass) < 0.05 * p.mass + 2) { bd = d; best = q; }
        }
        if (best && bd < 40) split.set(best.id, p.id);
      }
    }
    // creation-order prediction for pass 1
    const slots = 16 - mine.length, elig = mine.filter((c) => c.mass >= 44);
    const predicted = new Set(elig.slice(0, Math.max(0, slots)).map((c) => c.id));
    const aim = aims[u];
    const aimAng = aim ? Math.atan2((aim.x - C.x) * -H.y + (aim.y - C.y) * H.x, (aim.x - C.x) * H.x + (aim.y - C.y) * H.y) : null;
    const cells = mine.map((c, order) => ({
      id: c.id, order, mass: c.mass, rank: byMass.indexOf(c), frac: c.mass / max, al: al(c), la: la(c), split: split.has(c.id), piece: split.get(c.id),
    }));
    // fate of each piece and parent over the next 50 ticks
    for (const c of cells) if (c.split) {
      c.pieceFate = fate(rec, c.piece, u, Ft, 50, H, s);
      c.parentFate = fate(rec, c.id, u, Ft, 50, H, s);
      // what lies ahead of the parent along its throw line: nearest other-unit cell
      const q = mine.find((m) => m.id === c.id), dir = aim ? norm(aim.x - q.x, aim.y - q.y) : H;
      let tgt = null, td = 1e9;
      for (const o of other) {
        const dx = o.x - q.x, dy = o.y - q.y, along = dx * dir.x + dy * dir.y, lat = Math.abs(dx * -dir.y + dy * dir.x);
        if (along > 0 && lat < R(o.mass) + R(q.mass / 2) && along < td) { td = along; tgt = o; }
      }
      c.target = tgt ? { mass: tgt.mass, ratio: (q.mass / 2) / tgt.mass, dist: td } : null;
    }
    out.push({
      file: rec.file, T, n: e.n, u, role, nMine: mine.length, nOther: other.length, total, slots, nElig: elig.length,
      nSplit: split.size, found: !!F, orderOk: F ? [...split.keys()].every((id) => predicted.has(id)) && split.size === predicted.size : null,
      aimAng, cells, uMass: Cu.m, oMass: Co.m, alU: al(Cu), alO: al(Co),
    });
  }
  return out;
}
const norm = (x, y) => { const d = Math.hypot(x, y) || 1; return { x: x / d, y: y / d }; };

// where a cell went: eaten (by whom), grew (ate), along-course displacement relative to the centre
function fate(rec, id, u, t0, len, H, s) {
  const f0 = rec.byTick.get(t0), c0 = f0?.find((c) => c.id === id);
  if (!c0) return null;
  const C0 = cen(f0);
  let last = c0, lastF = f0, maxMass = c0.mass, eatenAt = null, eatenBy = null;
  for (let t = t0 + 1; t <= t0 + len; t++) {
    const f = rec.byTick.get(t); if (!f) continue;
    const c = f.find((k) => k.id === id);
    if (!c) {
      // who ate it: the cell (other or own unit) that grew by about its mass and covers it
      let best = null;
      for (const k of f) {
        const p = lastF.find((q) => q.id === k.id); if (!p) continue;
        const gain = k.mass - p.mass;
        if (gain > 0.6 * last.mass && Math.hypot(k.x - last.x, k.y - last.y) < R(k.mass) + 30) { best = k; break; }
      }
      eatenAt = t - t0; eatenBy = best ? (best.u === u ? 'own' : 'other') : '?';
      break;
    }
    last = c; lastF = f; maxMass = Math.max(maxMass, c.mass);
  }
  const C1 = cen(lastF);
  const rel0 = ((c0.x - C0.x) * H.x + (c0.y - C0.y) * H.y) / s, rel1 = ((last.x - C1.x) * H.x + (last.y - C1.y) * H.y) / s;
  return { m0: c0.mass, grew: maxMass / c0.mass, eatenAt, eatenBy, rel0, rel1 };
}

// shape: every 10 ticks, each cell's along/lateral offset from the centre by mass class and unit role
export function shape(rec) {
  const rows = [];
  for (let T = rec.start; T <= rec.end; T += 10) {
    if (rec.bad.has(T)) continue;
    const f = rec.byTick.get(T), H = heading(rec, T); if (!f || !H) continue;
    const C = cen(f), s = Math.sqrt(C.m / 35000);
    const units = [0, 1].map((u) => f.filter((c) => c.u === u)); if (!units[0].length || !units[1].length) continue;
    const al = (c) => ((c.x - C.x) * H.x + (c.y - C.y) * H.y) / s;
    const front = al(cen(units[0])) > al(cen(units[1])) ? 0 : 1;
    for (const u of [0, 1]) {
      const byMass = [...units[u]].sort((a, b) => b.mass - a.mass);
      byMass.forEach((c, rank) => rows.push({ role: u === front ? 'front' : 'back', rank, n: byMass.length, m: c.mass / (C.m / 35000), frac: c.mass / byMass[0].mass, al: al(c), la: ((c.x - C.x) * -H.y + (c.y - C.y) * H.x) / s, boost: c.boost > 0 }));
    }
  }
  return rows;
}

export function sources(kind) {
  if (kind === 'human') return readdirSync(ROOT + 'recordings').filter((f) => f.endsWith('.jsonl.gz')).map((f) => load(ROOT + 'recordings/' + f, 1205));
  const d = kind === 'bot' ? 'botrec' : kind;
  return readdirSync(SCR + d).filter((f) => f.endsWith('.jsonl.gz')).map((f) => load(SCR + d + '/' + f, 0));
}
