import { gamesDir } from './paths.mjs';
import { readdirSync } from 'node:fs';
import { loadRecording } from '../recording.mjs';
import { lookNet, recordingSamples } from '../look.mjs';
const net = lookNet();
for (const d of process.argv.slice(2)) {
  let s = 0, n = 0;
  for (const f of readdirSync(gamesDir(d)).filter((x) => x.endsWith('.gz'))) { const X = recordingSamples(loadRecording(gamesDir(d) + '/' + f), 625); for (const x of X) { s += 1 / (1 + Math.exp(-net.forward(x)[0])); n++; } }
  console.log(d, 'passes for your shape (new look network):', (s / n).toFixed(2));
}
