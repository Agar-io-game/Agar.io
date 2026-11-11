// Training by self-play. Always mass decay OFF, map walls OFF, 35,000 total mass, from the four
// start positions in turn (a lost unit loads the next one on the next tick).
//
// Each round:
//   1. the current bot plays `--games` games against the clock on all cores, sometimes pressing
//      a random one of its best few tries so that it sees more kinds of positions;
//   2. the value network is fitted to what really followed each position in those games: the
//      distance made over the next seconds, minus the costs (a unit left without a split, a
//      unit drained), and minus a large cost when a unit was lost;
//   3. the new network is tested without random presses; it becomes data/value.json if it is
//      the best so far (no unit lost first, then distance).
// Round 0 starts from the hand-made player (no network).
//   node bot/v3/train.mjs [--rounds 8] [--games 600] [--seconds 90] [--from round]
import { writeFileSync, appendFileSync, existsSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Net, fit } from './net.mjs';
import { INPUTS, mirror } from './features.mjs';
import { summarize, line } from './env.mjs';
import { runGames } from './worker.mjs';
import { gameSpec, loadParams, NET_FILE } from './evaluate.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const ROUNDS = Number(opt('--rounds', 8)), GAMES = Number(opt('--games', 600)), SECONDS = Number(opt('--seconds', 90));
const TEST_GAMES = Number(opt('--test', 32)), KEEP = Number(opt('--keep', 2)), HIDDEN = String(opt('--hidden', '96,48')).split(',').map(Number);
const params = loadParams();
for (const kv of String(opt('--set', '')).split(',').filter(Boolean)) { const [k, v] = kv.split('='); params[k] = JSON.parse(v); }
mkdirSync(here('./data/'), { recursive: true });
const LOG = here('./data/train-log.txt');
const log = (s) => { console.log(s); appendFileSync(LOG, s + '\n'); };
const netOf = (r) => here(`./data/value-round${r}.json`);

// The bot's standing: no lost unit comes first, then the distance it makes, with the rules
// you set as costs (split rhythm under your pace, a unit left hovering).
export const fitness = (s) => s.along - 400 * s.lost / (s.seconds / 60) - 300 * Math.max(0, 1.38 - s.splits) - 2 * Math.max(0, s.gapUnitP90 - 60) - 0.2 * Math.max(0, s.idleMax - 100);

const from = Number(opt('--from', 0));
let bestFit = -Infinity, sets = []; // sets: the samples of the last KEEP rounds
const stateFile = here('./data/train-state.json');
if (from > 0 && existsSync(stateFile)) bestFit = JSON.parse(readFileSync(stateFile, 'utf8')).bestFit ?? -Infinity;
log(`\n=== training ${new Date().toISOString()}: ${ROUNDS} rounds x ${GAMES} games x ${SECONDS} s, network ${[INPUTS, ...HIDDEN, 1].join('-')} ===`);

for (let round = from; round < from + ROUNDS; round++) {
  const t0 = performance.now();
  const netFile = round === 0 ? null : netOf(round - 1);
  if (netFile && !existsSync(netFile)) throw new Error(`no ${netFile}: start with --from 0`);
  // 1. self-play
  const specs = Array.from({ length: GAMES }, (_, i) => ({ ...gameSpec(i, SECONDS, 100 + round), collect: true, stall: 80, params: { explore: i % 3 === 0 ? 0 : 0.15 } }));
  let last = 0;
  const played = await runGames(params, netFile, specs, { onDone: (d, n) => { if (d - last >= n / 4) { last = d; process.stdout.write(`  self-play ${d}/${n}\r`); } } });
  const sp = summarize(played);
  const n = played.reduce((a, r) => a + r.samples.n, 0);
  const X = new Float32Array(2 * n * INPUTS), y = new Float32Array(2 * n), groups = new Int32Array(2 * n);
  let k = 0;
  played.forEach((r, gi) => { for (let j = 0; j < r.samples.n; j++) {
    const x = r.samples.X.subarray(j * INPUTS, (j + 1) * INPUTS);
    X.set(x, k * INPUTS); y[k] = r.samples.y[j]; groups[k] = round * 100000 + gi; k++;
    mirror(x, X.subarray(k * INPUTS, (k + 1) * INPUTS)); y[k] = r.samples.y[j]; groups[k] = round * 100000 + gi; k++;
  } });
  sets.push({ X, y, groups }); if (sets.length > KEEP) sets.shift();
  log(`round ${round} self-play (${netFile ? 'network of round ' + (round - 1) : 'hand-made player'}, ${n} positions, ${((performance.now() - t0) / 1000).toFixed(0)} s): ${line(sp)}`);
  // 2. fit
  const total = sets.reduce((a, s) => a + s.y.length, 0);
  const AX = new Float32Array(total * INPUTS), Ay = new Float32Array(total), Ag = new Int32Array(total);
  let o = 0; for (const s of sets) { AX.set(s.X, o * INPUTS); Ay.set(s.y, o); Ag.set(s.groups, o); o += s.y.length; }
  const net = new Net([INPUTS, ...HIDDEN, 1]);
  const t1 = performance.now();
  const res = fit(net, AX, Ay, { epochs: Number(opt('--epochs', 10)), groups: Ag, log: args.includes('--verbose') ? log : null });
  net.save(netOf(round));
  log(`round ${round} fit: ${total} samples, error on held-out games ${res.rmse.toFixed(0)} (explains ${(100 * res.r2).toFixed(0)}% of what followed), ${((performance.now() - t1) / 1000).toFixed(0)} s`);
  // 3. test
  const test = await runGames(params, netOf(round), Array.from({ length: TEST_GAMES }, (_, i) => gameSpec(i, 60, 7)));
  const ts = summarize(test), f = fitness(ts);
  const better = f > bestFit;
  if (better) { bestFit = f; copyFileSync(netOf(round), NET_FILE); }
  writeFileSync(stateFile, JSON.stringify({ bestFit, round }));
  log(`round ${round} TEST (${TEST_GAMES} x 60 s): ${line(ts)}\n   fitness ${f.toFixed(1)}${better ? '  <- best so far: saved as data/value.json' : `  (best ${bestFit.toFixed(1)})`}   round took ${((performance.now() - t0) / 1000).toFixed(0)} s`);
}
