// Honest score of a set of weights: games from the start state on 8 headings (not just the
// 3 used in training), each `seconds` long, speed measured from `warmup` on, so spending the
// head start of the 48.2 s position does not count. Runs on all CPU threads.
//   node bot/evaluate.mjs [params.json=bot/data/params.json] [--seconds 120] [--warmup 25]
// Compare with node bot/benchmark-human.mjs (your net speed over 60 s windows).
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const HEADINGS = [0, 15, -15, 45, -45, 90, -90, 180];

export async function evaluate(params, { seconds = 120, warmup = 25, headings = HEADINGS, threads = 16 } = {}) {
  const jobs = headings.map((deg) => ({ params, goalAngle: (deg * Math.PI) / 180, deg, seconds, warmup }));
  const results = [];
  await Promise.all(Array.from({ length: Math.min(threads, jobs.length) }, async () => {
    while (jobs.length) {
      const job = jobs.shift();
      const w = new Worker(fileURLToPath(import.meta.url));
      results.push(await new Promise((res, rej) => { w.once('message', res); w.once('error', rej); w.postMessage(job); }));
      w.terminate();
    }
  }));
  results.sort((a, b) => headings.indexOf(a.deg) - headings.indexOf(b.deg));
  return results;
}

if (!isMainThread) {
  const { play } = await import('./run.mjs');
  parentPort.once('message', ({ params, goalAngle, deg, seconds, warmup }) => {
    const r = play({ params, goalAngle, seconds });
    const sustained = (r.perSecond[seconds - 1] - r.perSecond[warmup - 1]) / (seconds - warmup);
    parentPort.postMessage({ deg, sustained, first: r.perSecond[warmup - 1] / warmup, splitsPerSec: r.splitsPerSec, tabsPerSec: r.tabsPerSec, resets: r.resets, mass: r.mass, cells: r.cells });
  });
} else if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : def; };
  const file = args.find((a) => a.endsWith('.json')) ?? here('./data/params.json');
  const params = JSON.parse(readFileSync(file, 'utf8')).params;
  const seconds = opt('--seconds', 120), warmup = opt('--warmup', 25);
  const t0 = performance.now();
  const rs = await evaluate(params, { seconds, warmup });
  for (const r of rs) console.log(`heading ${String(r.deg).padStart(4)} deg: ${r.sustained.toFixed(1)} u/s from ${warmup} s to ${seconds} s (first ${warmup} s: ${r.first.toFixed(0)})  splits ${r.splitsPerSec.toFixed(2)}/s  tabs ${r.tabsPerSec.toFixed(2)}/s  mass ${r.mass.toFixed(0)}${r.resets ? `  LOST A UNIT ${r.resets}x (reset to the start position)` : ''}`);
  const mean = rs.reduce((a, r) => a + r.sustained, 0) / rs.length;
  console.log(`units lost: ${rs.reduce((a, r) => a + r.resets, 0)} in ${rs.length} games`);
  console.log(`mean ${mean.toFixed(1)} u/s, worst ${Math.min(...rs.map((r) => r.sustained)).toFixed(1)}, best ${Math.max(...rs.map((r) => r.sustained)).toFixed(1)}  (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
}
