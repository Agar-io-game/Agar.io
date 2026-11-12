// Plays a set of test games on all CPU threads and keeps them: one recording per game plus
// speeds.json (speed from 25 s on, units lost, splits and Tabs a second, how often its
// positions and its splits pass for yours).
//   node bot/analysis/games.mjs <name> [seconds=120] [games=10] [overrideJSON] [--bot dev|v1|v2] [--params file]
// -> bot/analysis/games/<name>/. Game i starts at start position i % 5 and heads along
// 0, 15, -15, 45, -45, 90, -90, 180 degrees in turn (jittered by up to 5 degrees after the
// first 8). --bot picks the code and data: dev = bot/ (default), v1 = bot/v1, ... The
// override JSON is merged into that bot's weights, e.g. '{"wPress":0}'. "Pass for yours"
// always uses the look network and split critic of bot/data (the ones being worked on).
// Example (the v2 test set): node bot/analysis/games.mjs v2-5pos-45 120 45 '{}' --bot v2
// A frozen v1 plays only from its own start position (it has no start-positions.json).
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { GAMES } from './paths.mjs';

const botUrl = (v) => new URL(v === 'dev' ? '../' : `../${v}/`, import.meta.url).href;

if (!isMainThread) {
  const { bot, deg, first, seconds, over, out, paramsFile } = workerData;
  const BOT = botUrl(bot);
  const run = await import(BOT + 'run.mjs');
  const { saveRecording } = await import(BOT + 'recording.mjs');
  const { TRAIN_CONFIG } = await import(BOT + 'sim.mjs');
  const params = { ...(paramsFile ? JSON.parse(readFileSync(paramsFile, 'utf8')).params : run.loadParams()), ...over };
  const r = run.play({ params, seconds, goalAngle: (deg * Math.PI) / 180, first, record: true });
  const warm = 25, sustained = (r.perSecond[seconds - 1] - r.perSecond[warm - 1]) / (seconds - warm);
  const start = run.loadStarts ? run.loadStarts()[first] : run.loadStart();
  saveRecording(out, { recording: 1, version: 2, note: `bot ${bot}`, tickMs: 40, config: TRAIN_CONFIG, players: [{ clientId: 2, name: 'bot', isBot: true, active: 2 | start.active }] }, r.frames, r.events);
  const { lookNet, recordingSamples } = await import('../look.mjs');
  const { pressNet, recordingPresses } = await import('../press.mjs');
  const net = lookNet(), X = recordingSamples({ frames: r.frames, events: [] });
  const look = X.reduce((a, x) => a + 1 / (1 + Math.exp(-net.forward(x)[0])), 0) / X.length;
  const pn = pressNet(), P = recordingPresses({ frames: r.frames, events: r.events }, 625);
  const press = P.reduce((a, x) => a + 1 / (1 + Math.exp(-pn.forward(x)[0])), 0) / Math.max(1, P.length);
  parentPort.postMessage({ deg, first, sustained, lost: r.resets, splits: r.splitsPerSec, tabs: r.tabsPerSec, look, press, escapes: r.escapes });
} else {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const bot = opt('--bot') ?? 'dev', paramsFile = opt('--params');
  const [name, sec = 120, games = 10, over = '{}'] = args;
  if (!name) { console.log('usage: node bot/analysis/games.mjs <name> [seconds=120] [games=10] [overrideJSON] [--bot dev|v1|v2] [--params file]'); process.exit(1); }
  const dir = GAMES + name;
  mkdirSync(dir, { recursive: true });
  const heads = [0, 15, -15, 45, -45, 90, -90, 180];
  const jobs = Array.from({ length: +games }, (_, i) => ({ deg: heads[i % 8] + (i >= 8 ? ((i * 37) % 11) - 5 : 0), first: i % 5, i }));
  const res = []; const t0 = performance.now();
  await Promise.all(Array.from({ length: 15 }, async () => {
    while (jobs.length) {
      const j = jobs.shift();
      const w = new Worker(new URL(import.meta.url), { workerData: { bot, deg: j.deg, first: j.first, seconds: +sec, over: JSON.parse(over), paramsFile, out: `${dir}/g${j.i}_p${j.first + 1}_${j.deg}.jsonl.gz` } });
      res.push(await new Promise((ok, bad) => { w.once('message', ok); w.once('error', bad); }));
    }
  }));
  writeFileSync(dir + '/speeds.json', JSON.stringify(res));
  const sp = res.map((r) => r.sustained).sort((a, b) => a - b), avg = (f) => res.reduce((a, r) => a + f(r), 0) / res.length;
  console.log(`${name}: mean ${avg((r) => r.sustained).toFixed(1)} median ${sp[sp.length >> 1].toFixed(1)} u/s  worst ${sp[0].toFixed(1)}  under 150: ${sp.filter((v) => v < 150).length}  units lost ${res.reduce((a, r) => a + r.lost, 0)} in ${res.length} games  splits ${avg((r) => r.splits).toFixed(2)}/s  tabs ${avg((r) => r.tabs).toFixed(2)}/s  positions pass for yours ${avg((r) => r.look).toFixed(2)}  splits pass for yours ${avg((r) => r.press).toFixed(2)}  escapes ${(100 * avg((r) => r.escapes ?? 0)).toFixed(1)}% of decisions  (${((performance.now() - t0) / 1000).toFixed(0)} s)  bot ${bot} ${over}`);
}
