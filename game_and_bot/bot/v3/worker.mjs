// Plays games on worker threads (one game per message), for evaluate.mjs and train.mjs.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import os from 'node:os';
import { Brain, returnsOf } from './brain.mjs';
import { playGame } from './env.mjs';
import { Net } from './net.mjs';
import { INPUTS } from './features.mjs';

export const THREADS = Math.max(1, os.cpus().length - 2);

// specs: [{ start, angle, seconds, seed, record?, collect? }]. netFile: the value network to
// play with (null = the hand-made player). Resolves to the results in game order; with
// collect, each has samples { X: Float32Array, y: Float32Array, n }.
export function runGames(params, netFile, specs, { threads = THREADS, onDone = null } = {}) {
  return new Promise((resolve, reject) => {
    const results = new Array(specs.length); let next = 0, done = 0;
    const n = Math.min(threads, specs.length); if (!n) return resolve(results);
    for (let w = 0; w < n; w++) {
      const worker = new Worker(new URL(import.meta.url), { workerData: { params, netFile } });
      const give = () => { if (next < specs.length) { const i = next++; worker.postMessage({ i, spec: specs[i] }); } else { worker.finished = true; worker.terminate(); } };
      worker.on('message', ({ i, result }) => { results[i] = result; done++; onDone?.(done, specs.length); if (done === specs.length) resolve(results); give(); });
      worker.on('error', reject);
      worker.on('exit', (code) => { if (code !== 0 && done < specs.length && !worker.finished) reject(new Error(`a game worker stopped with code ${code}`)); });
      give();
    }
  });
}

if (!isMainThread) {
  const net = workerData.netFile ? Net.load(workerData.netFile) : null;
  parentPort.on('message', ({ i, spec }) => {
    const brain = new Brain({ ...workerData.params, ...(spec.params ?? {}) }, spec.angle, net);
    if (spec.collect) brain.trace = [];
    const result = playGame(brain, spec);
    result.msPerPress = brain.stats.ms / Math.max(1, brain.stats.decisions); result.noSafe = brain.stats.noSafe;
    const transfer = [];
    if (spec.collect) {
      const { X, y, n } = returnsOf(brain.trace, brain.p);
      const fx = new Float32Array(n * INPUTS), fy = new Float32Array(n);
      for (let k = 0; k < n; k++) { fx.set(X[k], k * INPUTS); fy[k] = y[k]; }
      result.samples = { X: fx, y: fy, n }; transfer.push(fx.buffer, fy.buffer);
    }
    parentPort.postMessage({ i, result }, transfer);
  });
}
