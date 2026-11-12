// Reading the /rec recordings (recordings/*.jsonl.gz) and writing new ones in the same
// format, so recordings/viewer.html can play the bot's games too.
// Line 1 is a header; then frames {tick, cells: [[id, pid, x, y, mass, boost, angle], ...]}
// and events {tick, ev, pid, ...} (aim, split n, tab, feedHold, freeze, autoSwitch).
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

export function loadRecording(file) {
  const lines = gunzipSync(readFileSync(file)).toString().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const header = lines[0], frames = [], events = [];
  for (const o of lines.slice(1)) (o.ev ? events : frames).push(o);
  frames.sort((a, b) => a.tick - b.tick);
  events.sort((a, b) => a.tick - b.tick);
  return { header, frames, events, t0: frames[0].tick };
}

export function saveRecording(file, header, frames, events) {
  const all = [...frames, ...events].sort((a, b) => a.tick - b.tick || (a.ev ? 1 : -1));
  const text = [JSON.stringify(header), ...all.map((o) => JSON.stringify(o))].join('\n') + '\n';
  writeFileSync(file, gzipSync(text));
}

export const massCentre = (cells) => {
  let m = 0, x = 0, y = 0;
  for (const c of cells) { m += c[4]; x += c[2] * c[4]; y += c[3] * c[4]; }
  return m ? { x: x / m, y: y / m, m } : null;
};
