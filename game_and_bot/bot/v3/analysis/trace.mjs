// Prints a game press by press: node bot/v3/analysis/trace.mjs [start 0-3] [seconds] [key=value,...]
import { Brain } from '../brain.mjs';
import { playGame, line } from '../env.mjs';
import { loadParams } from '../evaluate.mjs';
const start = Number(process.argv[2] ?? 0), seconds = Number(process.argv[3] ?? 20);
const params = loadParams();
for (const kv of String(process.argv[4] ?? '').split(',').filter(Boolean)) { const [k, v] = kv.split('='); params[k] = JSON.parse(v); }
const brain = new Brain(params, 0);
const act = brain.act.bind(brain);
let c0 = null;
brain.act = (sim, t) => {
  const out = act(sim, t);
  const sp = out.find((c) => c[0] === 'split');
  if (sp) {
    const tab = out.some((c) => c[0] === 'tab'), u = tab ? sim.active ^ 1 : sim.active, aim = out.filter((c) => c[0] === 'aim').pop();
    const cu = sim.unitCentre(u), c = sim.centre(); c0 ??= c.x;
    const fmt = (k) => sim.cells(k).map((q) => `${Math.round(q.mass)}@${Math.round(q.x - c.x)}`).join(' ');
    const ang = Math.round(Math.atan2(aim[2] - cu.y, aim[1] - cu.x) * 180 / Math.PI), dist = Math.round(Math.hypot(aim[2] - cu.y, aim[1] - cu.x));
    console.log(`t=${(t / 25).toFixed(2)} x=${Math.round(c.x - c0)} U${u} split${sp[1]} aim ${ang}deg/${dist}  | U0[${sim.n(0)}] ${fmt(0)} | U1[${sim.n(1)}] ${fmt(1)}`);
  }
  return out;
};
const r = playGame(brain, { start, seconds, seed: Number(process.env.SEED ?? 0) });
console.log(line(r));
