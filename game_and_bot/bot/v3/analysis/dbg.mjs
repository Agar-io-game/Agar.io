import { Brain } from '../brain.mjs';
import { playGame, line } from '../env.mjs';
import { Net } from '../net.mjs';
const net = Net.load(process.argv[2]);
console.log('net', net.sizes, net.scale, net.shift);
const brain = new Brain({}, 0, net);
const r = playGame(brain, { start: 0, seconds: 10 });
console.log(line(r), brain.stats);
