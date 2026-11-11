// Plays test games with the bot and prints its numbers next to yours.
//   node bot/v3/evaluate.mjs [--games 16] [--seconds 60] [--net file|none] [--params file.json]
//                            [--set key=value,...] [--record] [--threads n] [--seed n]
// Games take the four start positions in turn. Mass decay OFF, map walls OFF, 35,000 mass.
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { summarize, line } from './env.mjs';
import { runGames, THREADS } from './worker.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export const PARAMS_FILE = here('./data/params.json'), NET_FILE = here('./data/value.json');
export const loadParams = (file = PARAMS_FILE) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
// Your numbers (analysis/human.mjs over the four recordings, from 35K on).
export const HUMAN = { splits: 1.379, tabs: 1.038, speed1: 226.9, net10: 168.2, gapUnitP50: 34, gapUnitP90: 60, gapUnitMax: 226, lost: 4, seconds: 6762 };

// Game i of a set: start positions 1-4 in turn; seed moves each cell a few units so that no
// two games are the same (the first four of seed base 0 are the positions exactly as saved).
export const gameSpec = (i, seconds, seedBase = 0) => ({ start: i % 4, angle: ((i * 137.5) % 360) * Math.PI / 180, seconds, seed: i < 4 && !seedBase ? 0 : 1000 * seedBase + i + 1 });

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
  const games = Number(opt('--games', 16)), seconds = Number(opt('--seconds', 60));
  const params = loadParams(opt('--params', PARAMS_FILE));
  for (const kv of String(opt('--set', '')).split(',').filter(Boolean)) { const [k, v] = kv.split('='); params[k] = JSON.parse(v); }
  let netFile = opt('--net', NET_FILE); if (netFile === 'none' || !existsSync(netFile)) netFile = null;
  const specs = Array.from({ length: games }, (_, i) => gameSpec(i, seconds, Number(opt('--seed', 0))));
  if (args.includes('--record')) {
    mkdirSync(here('./games/'), { recursive: true });
    specs.forEach((s, i) => { s.record = here(`./games/v3-pos${s.start + 1}-${i + 1}.jsonl.gz`); });
  }
  const t0 = performance.now();
  const results = await runGames(params, netFile, specs, { threads: Number(opt('--threads', THREADS)) });
  if (!args.includes('--quiet')) for (const r of results) console.log(`pos ${r.start}: ${line(r)}${r.lost ? '  lost at ' + r.lostAt.join(', ') + ' s' : ''}`);
  const s = summarize(results);
  console.log(`\nBOT  ${games} games x ${seconds} s (${netFile ? 'value network' : 'no network'}): ${line(s)}`);
  console.log(`YOU  ${(HUMAN.seconds / 60).toFixed(0)} min: 1s-speed ${HUMAN.speed1}  10s-net ${HUMAN.net10}  splits ${HUMAN.splits}/s  tabs ${HUMAN.tabs}/s  unit gap p50 ${HUMAN.gapUnitP50} p90 ${HUMAN.gapUnitP90} max ${HUMAN.gapUnitMax}  LOST ${HUMAN.lost}`);
  console.log(`thinking: ${(results.reduce((a, r) => a + r.msPerPress, 0) / results.length).toFixed(1)} ms per press; presses with no safe option: ${results.reduce((a, r) => a + r.noSafe, 0)}; took ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  if (specs[0].record) console.log('recordings in bot/v3/games/ (drop one on recordings/viewer.html)');
}
