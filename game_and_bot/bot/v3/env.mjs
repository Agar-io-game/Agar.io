// One training / test game: the bot plays `seconds` of game time in the fast sim, from one of
// the four start positions, along a course. Mass decay OFF, map walls OFF, 35,000 total mass.
// If it loses a unit, the next start position (1, 2, 3, 4, 1, ...) is loaded on the next tick,
// where the bot is, and the game goes on. Everything you asked the bot to keep to is measured
// here, the same way analysis/human.mjs measures your recordings.
import { Sim, CAP } from './sim.mjs';
import { place, STARTS } from './starts.mjs';
import { saveRecording } from './recording.mjs';

const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// brain: { act(sim, tick) -> [['aim', x, y] | ['tab'] | ['split', n], ...], reset() }
// opts: { start: 0-3, angle: course in radians, seconds, record: file | null, warmup: seconds left out of the numbers }
export function playGame(brain, { start = 0, angle = 0, seconds = 60, record = null, warmup = 0, onTick = null, seed = 0, stall = 0 } = {}) {
  const first = place(start, { angle });
  if (seed) { // the same position, each cell moved by a few units: a different game from the same start
    let z = seed >>> 0; const rnd = () => ((z = (z * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (const q of first.cells) { q.x += (rnd() - 0.5) * 40; q.y += (rnd() - 0.5) * 40; }
  }
  const sim = new Sim().load(first);
  const G = { x: Math.cos(angle), y: Math.sin(angle) };
  const ticks = Math.round(seconds * 25), warm = Math.round(warmup * 25);
  const frames = [], events = [];
  const c = {}, cents = [];
  let presses = 0, effective = 0, fulls = 0, doubles = 0, tabs = 0, lost = 0, posIndex = start, fullTicks = [0, 0];
  const lastSplit = [null, null], gaps = [], allGaps = []; let lastAny = null;
  const idle = [0, 0]; let idleMax = 0;       // ticks since each unit's last split that split something
  let minShare = 1, lowShare = 0, stalls = 0;
  const lostAt = [];
  for (let t = 0; t < ticks; t++) {
    const cmds = brain.act(sim, t);
    for (const cmd of cmds) {
      if (cmd[0] === 'aim') { sim.aim(cmd[1], cmd[2]); if (record) events.push({ tick: t, ev: 'aim', pid: 2 + sim.active, x: Math.round(cmd[1]), y: Math.round(cmd[2]) }); }
      else if (cmd[0] === 'tab') { if (record) events.push({ tick: t, ev: 'tab', pid: 2 + sim.active }); sim.tab(); if (t >= warm) tabs++; }
      else if (cmd[0] === 'split') {
        const u = sim.active, works = sim.canSplit(u);
        if (record) events.push({ tick: t, ev: 'split', pid: 2 + u, n: cmd[1] });
        sim.split(cmd[1]);
        if (t >= warm) {
          presses++;
          if (works) {
            effective++; if (cmd[1] === 4) fulls++; if (cmd[1] === 2) doubles++;
            if (lastSplit[u] != null) gaps.push(t - lastSplit[u]);
            if (lastAny != null) allGaps.push(t - lastAny);
          }
        }
        if (works) { lastSplit[u] = t; lastAny = t; idle[u] = 0; }
      } else throw new Error('not a key: ' + cmd[0]); // W, E, freeze: never
    }
    sim.tick();
    if (onTick) onTick(sim, t);
    if (record) frames.push(sim.frame(t + 1));
    sim.centre(c); cents.push({ x: c.x, y: c.y });
    if (t >= warm) {
      for (let u = 0; u < 2; u++) { if (sim.n(u) >= CAP) fullTicks[u]++; idle[u]++; if (idle[u] > idleMax) idleMax = idle[u]; }
      const share = Math.min(sim.unitMass(0), sim.unitMass(1)) / c.m; if (share < minShare) minShare = share; if (share < 0.1) lowShare++;
    }
    // Training only (stall > 0): a unit that has not split for `stall` ticks ends the attempt
    // like a lost unit does, so that self-play does not spend its time in a jam.
    const stalled = stall > 0 && !sim.lost && (idle[0] > stall || idle[1] > stall);
    if (stalled) stalls++;
    if (sim.lost || stalled) { // never wanted: the next start position, here, on the next tick
      if (sim.lost) { lost++; lostAt.push(+(t / 25).toFixed(1)); }
      posIndex = (posIndex + 1) % STARTS.length;
      sim.reload(place(posIndex, { at: { x: c.x, y: c.y }, angle, now: sim.now, idBase: sim.state().nextId }));
      brain.reset?.(stalled ? 'stall' : 'lost'); idle[0] = idle[1] = 0;
    }
  }
  if (record) saveRecording(record, { recording: 1, version: 2, generated: 'bot v3', tickMs: 40, note: `bot v3, start position ${start + 1}`, players: [{ clientId: 2, name: 'v3', isBot: true, active: 2 }] }, frames, events);
  const cs = cents.slice(warm), secs = cs.length / 25;
  const win = (n) => { const out = []; for (let i = 0; i + n < cs.length; i += n) out.push(Math.hypot(cs[i + n].x - cs[i].x, cs[i + n].y - cs[i].y) / (n / 25)); return out; };
  const a = cs[0], b = cs[cs.length - 1];
  return {
    start: start + 1, seconds: secs, lost, lostAt, stalls,
    along: ((b.x - a.x) * G.x + (b.y - a.y) * G.y) / secs,             // u/s made good along the course
    speed1: mean(win(25)), net10: mean(win(250)), net10min: Math.min(...win(250)),
    splits: effective / secs, presses: presses / secs, fulls: fulls / secs, doubles: doubles / secs, tabs: tabs / secs,
    gapUnitP50: pct(gaps, 0.5), gapUnitP90: pct(gaps, 0.9), gapUnitMax: Math.max(0, ...gaps), idleMax,
    gapP10: pct(allGaps, 0.1), gapP50: pct(allGaps, 0.5),
    full16: (fullTicks[0] + fullTicks[1]) / (2 * cs.length), minShare, lowShare: lowShare / cs.length,
    autoSplits: sim.autoSplits, merges: sim.merges, eats: sim.eats / (ticks / 25), mass: sim.mass(),
  };
}

export function summarize(results) {
  const m = (k) => mean(results.map((r) => r[k]));
  return {
    games: results.length, seconds: results.reduce((s, r) => s + r.seconds, 0),
    lost: results.reduce((s, r) => s + r.lost, 0), stalls: results.reduce((s, r) => s + (r.stalls || 0), 0), autoSplits: results.reduce((s, r) => s + r.autoSplits, 0), merges: results.reduce((s, r) => s + r.merges, 0),
    along: m('along'), alongMin: Math.min(...results.map((r) => r.along)), speed1: m('speed1'), net10: m('net10'), net10min: Math.min(...results.map((r) => r.net10min)),
    splits: m('splits'), splitsMax: Math.max(...results.map((r) => r.splits)), fulls: m('fulls'), doubles: m('doubles'), tabs: m('tabs'),
    gapUnitP50: m('gapUnitP50'), gapUnitP90: m('gapUnitP90'), gapUnitMax: Math.max(...results.map((r) => r.gapUnitMax)), idleMax: Math.max(...results.map((r) => r.idleMax)),
    full16: m('full16'), minShare: Math.min(...results.map((r) => r.minShare)), lowShare: m('lowShare'), eats: m('eats'),
  };
}
export const line = (s) => `along ${s.along.toFixed(0)} u/s (worst ${(s.alongMin ?? s.along).toFixed(0)})  1s-speed ${s.speed1.toFixed(0)}  10s-net ${s.net10.toFixed(0)}  splits ${s.splits.toFixed(2)}/s (full ${s.fulls.toFixed(2)}, double ${s.doubles.toFixed(2)})  tabs ${s.tabs.toFixed(2)}/s  unit gap p50 ${s.gapUnitP50.toFixed(0)} p90 ${s.gapUnitP90.toFixed(0)} max ${s.gapUnitMax} idle max ${s.idleMax}  at16 ${(100 * s.full16).toFixed(0)}%  min share ${(100 * s.minShare).toFixed(0)}%  eats ${s.eats.toFixed(1)}/s  LOST ${s.lost}${s.stalls ? `  stalls ${s.stalls}` : ''}  auto ${s.autoSplits}  merges ${s.merges}`;
