// Plays one game with the bot from the training start state and reports its speed, the same
// way benchmark-human.mjs measures yours. Optionally writes a recording for viewer.html.
//   node bot/run.mjs [seconds=60] [--goal <degrees>] [--params bot/data/params.json] [--out bot/data/bot-game.jsonl.gz]
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Game, TRAIN_CONFIG } from './sim.mjs';
import { Brain } from './brain.mjs';
import { saveRecording } from './recording.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export const loadStart = () => JSON.parse(readFileSync(here('./data/start-state.json'), 'utf8'));
export const loadParams = (file = here('./data/params.json')) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).params : {});

// Plays `seconds` of game. Returns stats; with record = true also the frames and events.
export function play({ params = {}, seconds = 60, record = false, goalAngle = 0, start = loadStart(), onSecond } = {}) {
  const g = new Game(start);
  const brain = new Brain(params, goalAngle);
  const frames = [], events = [];
  const c0 = g.centre(), G = { x: Math.cos(goalAngle), y: Math.sin(goalAngle) };
  const ticks = Math.round(seconds * 25);
  const tickBase = start.source?.tick ?? 0;
  const along = () => { const c = g.centre(); return (c.x - c0.x) * G.x + (c.y - c0.y) * G.y; };
  const perSecond = [];
  let lastAim = null;
  for (let t = 0; t < ticks; t++) {
    if (record) {
      // wrap the inputs so they are logged as events, like /rec does
      const s0 = g.splits, t0 = g.tabs, act = g.active;
      brain.act(g, t);
      const pid = 2 | act;
      if (g.tabs > t0) events.push({ tick: tickBase + t, ev: 'tab', pid });
      if (g.splits > s0) events.push({ tick: tickBase + t, ev: 'split', pid: 2 | g.active, n: g.player.active.splitQueue });
      const a = g.player.active.aim;
      if (!lastAim || a.x !== lastAim.x || a.y !== lastAim.y) { events.push({ tick: tickBase + t, ev: 'aim', pid: 2 | g.active, x: Math.round(a.x), y: Math.round(a.y) }); lastAim = { ...a }; }
    } else brain.act(g, t);
    g.step();
    // A lost unit is never played on: straight back to the start position, where the mass
    // centre is now, facing the course (counted in `resets`).
    if (!g.cells(0).length || !g.cells(1).length) {
      g.reset(start, goalAngle); brain.restart();
      if (record) events.push({ tick: tickBase + t, ev: 'reset' });
    }
    if (record) frames.push(g.frame(tickBase));
    if ((t + 1) % 25 === 0) { perSecond.push(along()); onSecond?.(perSecond.length, g, along()); }
  }
  const c1 = g.centre();
  const lateral = Math.abs((c1.x - c0.x) * -G.y + (c1.y - c0.y) * G.x);
  return {
    seconds, speed: along() / seconds, lateral, mass: g.mass(),
    cells: [g.cells(0).length, g.cells(1).length], splitsPerSec: g.splits / seconds, tabsPerSec: g.tabs / seconds,
    resets: g.resets ?? 0, lostUnit: (g.resets ?? 0) > 0, perSecond, frames, events,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
  const seconds = Number(args.find((a) => /^\d/.test(a)) ?? 60);
  const params = loadParams(opt('--params') ? opt('--params') : undefined);
  const out = opt('--out', here('./data/bot-game.jsonl.gz'));
  const t0 = performance.now();
  const goalAngle = (Number(opt('--goal', 0)) * Math.PI) / 180;
  const r = play({ params, seconds, goalAngle, record: true, onSecond: (s, g, d) => { if (s % 10 === 0) console.log(`  ${s}s  ${(d / s).toFixed(0)} u/s so far  cells ${g.cells(0).length}/${g.cells(1).length}`); } });
  console.log(`speed ${r.speed.toFixed(0)} u/s  sideways drift ${r.lateral.toFixed(0)}  mass ${r.mass.toFixed(0)}  cells ${r.cells}  splits ${r.splitsPerSec.toFixed(2)}/s  tabs ${r.tabsPerSec.toFixed(2)}/s  units lost ${r.resets}  (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
  const start = loadStart();
  saveRecording(out, {
    recording: 1, version: 2, startedAt: new Date().toISOString(), note: 'bot', tickMs: 40, config: TRAIN_CONFIG,
    players: [{ clientId: 2, name: 'bot', isBot: true, active: 2 | start.active }],
    generated: { from: { file: start.source.file, tick: start.source.tick }, quality: { speed: Math.round(r.speed), splitsPerSec: +r.splitsPerSec.toFixed(2), eatsPerSec: 0 } },
  }, r.frames, r.events);
  console.log(`recording: ${out}`);
}
