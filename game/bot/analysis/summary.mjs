import { gamesDir } from './paths.mjs';
import { readFileSync, existsSync } from 'node:fs';
for (const d of process.argv.slice(2)) {
  const f = gamesDir(d) + '/speeds.json'; if (!existsSync(f)) { console.log(d, 'not done'); continue; }
  const res = JSON.parse(readFileSync(f, 'utf8')), sp = res.map((r) => r.sustained).sort((a, b) => a - b), avg = (g, R = res) => R.reduce((a, r) => a + g(r), 0) / R.length;
  const byPos = [0, 1, 2, 3, 4].map((p) => res.filter((r) => r.first === p)).map((R) => R.length ? `${avg((r) => r.sustained, R).toFixed(0)}/${R.reduce((a, r) => a + r.lost, 0)}` : '-').join(' ');
  console.log(`${d.padEnd(10)} n ${res.length}  mean ${avg((r) => r.sustained).toFixed(1)} median ${sp[sp.length >> 1].toFixed(1)} worst ${sp[0].toFixed(1)}  <150: ${sp.filter((v) => v < 150).length}  lost ${res.reduce((a, r) => a + r.lost, 0)}  splits ${avg((r) => r.splits).toFixed(2)}/s tabs ${avg((r) => r.tabs).toFixed(2)}/s  look ${avg((r) => r.look).toFixed(2)} press ${avg((r) => r.press).toFixed(2)}  by position (u/s/lost): ${byPos}`);
}
