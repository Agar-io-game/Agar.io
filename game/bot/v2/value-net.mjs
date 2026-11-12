// The self-play value network (trained by value-selfplay.mjs): from a position, how far the
// mass centre gets along the course in the next AHEAD seconds. brain.mjs adds it to its score.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encode, INPUTS, MLP } from './policy.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export const AHEAD = 10;        // seconds of future progress predicted
export const VALUE_SIZES = [INPUTS, 64, 32, 1];
export const SCALE = 1000;             // target in thousands of units

// The network's input for a position: the policy's encoding, in the course's frame.
export function valueInput(g, heading, out = new Float32Array(INPUTS)) {
  const cells = [];
  for (let u = 0; u < 2; u++) for (const c of g.cells(u)) cells.push({ unit: u, x: c.x, y: c.y, mass: c.mass, boost: c.boost, angle: c.angle });
  return encode(cells, g.active, heading, { aim: g.player.units[g.active ^ 1].aim, sinceKey: 50, sinceTab: 75, lastKey: null }, out);
}

let NET;
export function valueNet() {
  if (NET === undefined) {
    const f = here('./data/selfplay-value.json');
    NET = existsSync(f) ? new MLP(VALUE_SIZES, JSON.parse(readFileSync(f, 'utf8'))) : null;
  }
  return NET;
}
// Predicted progress over the next AHEAD seconds, in units.
export const predictValue = (net, g, heading, buf) => net.forward(valueInput(g, heading, buf))[0] * SCALE;

