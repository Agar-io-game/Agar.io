// node gallery.mjs -> gallery.html: random moments, human vs bot, rotated so the run goes right
import { writeFileSync } from 'node:fs';
import { sources, heading } from './splits.mjs';
const N = +(process.argv[2] ?? 15), seed = +(process.argv[3] ?? 1);
let s = seed; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
const cen = (cs) => { let m = 0, x = 0, y = 0; for (const c of cs) { m += c.mass; x += c.x * c.mass; y += c.y * c.mass; } return { x: x / m, y: y / m, m }; };
function svg(rec, T) {
  const f = rec.byTick.get(T), H = heading(rec, T); if (!f || !H) return null;
  if (![0, 1].every((u) => f.some((c) => c.u === u))) return null;
  const C = cen(f), k = Math.sqrt(C.m / 35000);
  const al = (c) => ((c.x - C.x) * H.x + (c.y - C.y) * H.y) / k, la = (c) => ((c.x - C.x) * -H.y + (c.y - C.y) * H.x) / k;
  const front = al(cen(f.filter((c) => c.u === 0))) > al(cen(f.filter((c) => c.u === 1))) ? 0 : 1;
  const W = 8000, Hh = 5400;
  let out = `<svg viewBox="${-W / 2} ${-Hh / 2} ${W} ${Hh}" width="300" height="205"><rect x="${-W / 2}" y="${-Hh / 2}" width="${W}" height="${Hh}" fill="#1e2333"/>`;
  out += `<line x1="0" y1="${-Hh / 2}" x2="0" y2="${Hh / 2}" stroke="#444" stroke-width="8"/>`;
  for (const c of [...f].sort((a, b) => b.mass - a.mass)) {
    const r = Math.sqrt(100 * c.mass / (k * k));
    const col = c.u === front ? '#3b82f6' : '#f59e0b';
    out += `<circle cx="${al(c).toFixed(0)}" cy="${la(c).toFixed(0)}" r="${r.toFixed(0)}" fill="${col}" fill-opacity=".55" stroke="${c.boost > 0 ? '#fff' : col}" stroke-width="${c.boost > 0 ? 30 : 12}"/>`;
    if (r > 160) out += `<text x="${al(c).toFixed(0)}" y="${(la(c) + 50).toFixed(0)}" font-size="${Math.min(260, r / 2)}" fill="#fff" text-anchor="middle">${Math.round(c.mass / (k * k))}</text>`;
  }
  return out + '</svg>';
}
let html = `<html><body style="background:#111;color:#ddd;font:12px sans-serif;margin:8px"><p>Run goes right. Blue = front unit, orange = back unit. White ring = flying piece. Scaled to 35K. Grey line = mass centre.</p>`;
for (const kind of (process.argv[4] ?? 'human,bot').split(',')) {
  const recs = sources(kind); const items = []; if (kind !== 'human') for (const r of recs) r.start += 625;
  while (items.length < N) {
    const r = recs[Math.floor(rnd() * recs.length)], T = r.start + 100 + Math.floor(rnd() * (r.end - r.start - 200));
    if (r.bad.has(T)) continue; const v = svg(r, T); if (v) items.push(`<div style="display:inline-block;margin:3px">${v}<br>${r.file.split('/').pop().slice(0, 15)} t${T}</div>`);
  }
  html += `<h3>${({ human: 'you', 'v1-5pos-30': 'v1', 'v2-5pos-45': 'v2' })[kind] ?? kind}</h3>` + items.join('');
}
writeFileSync(process.argv[5] ?? 'gallery.html', html + '</body></html>');
