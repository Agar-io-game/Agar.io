// Your split-run speed in the recordings, measured the same way as the bot's:
// net distance the mass centre covers in a window / window length, for 10 s, 30 s and 60 s
// windows (the net speed over a window rewards holding a heading; over 10 s it is close to
// the raw running speed). Skips the first 48 s of each recording (the opening).
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadRecording, massCentre } from './recording.mjs';

const dir = fileURLToPath(new URL('../../recordings/', import.meta.url));
export function windowSpeeds(centres, secs) {
  const n = Math.round(secs * 25), out = [];
  for (let i = 0; i + n < centres.length; i += n) {
    const a = centres[i], b = centres[i + n];
    if (a && b) out.push(Math.hypot(b.x - a.x, b.y - a.y) / secs);
  }
  return out;
}
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const all = { 10: [], 30: [], 60: [] };
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl.gz')).sort()) {
    const rec = loadRecording(dir + f);
    const centres = rec.frames.filter((fr) => fr.tick >= rec.t0 + 1205).map((fr) => massCentre(fr.cells));
    const mass = mean(centres.filter(Boolean).map((c) => c.m));
    const line = [10, 30, 60].map((s) => { const w = windowSpeeds(centres, s); all[s].push(...w); return `${s}s ${mean(w).toFixed(0)}`; });
    console.log(`${f}  ${(centres.length / 25 / 60).toFixed(1)} min  mass ~${mass.toFixed(0)}  net speed: ${line.join('  ')}`);
  }
  for (const s of [10, 30, 60]) console.log(`all  ${s}s windows: mean ${mean(all[s]).toFixed(0)}  median ${pct(all[s], 0.5).toFixed(0)}  p90 ${pct(all[s], 0.9).toFixed(0)} u/s`);
}
