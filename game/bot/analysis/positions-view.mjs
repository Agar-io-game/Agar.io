// positions.html: each start position as stored (course = right), cells numbered in split order
import { readFileSync, writeFileSync } from 'node:fs';
const S = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let html = '<html><body style="background:#111;color:#ddd;font:12px sans-serif">';
for (const s of S) {
  let m = 0, x = 0, y = 0; for (const c of s.cells) { m += c.mass; x += c.x * c.mass; y += c.y * c.mass; } x /= m; y /= m;
  const W = 9000, H = 7000;
  let o = `<div style="display:inline-block;margin:4px"><svg viewBox="${-W / 2} ${-H / 2} ${W} ${H}" width="420" height="327"><rect x="${-W / 2}" y="${-H / 2}" width="${W}" height="${H}" fill="#1e2333"/>`;
  o += `<line x1="0" y1="0" x2="1500" y2="0" stroke="#fff" stroke-width="30" marker-end="url(#a)"/>`;
  const order = [0, 1].map((u) => s.cells.filter((c) => c.unit === u).map((c) => c.id));
  for (const c of [...s.cells].sort((a, b) => b.mass - a.mass)) {
    const r = Math.sqrt(100 * c.mass), col = c.unit === 0 ? '#3b82f6' : '#f59e0b';
    o += `<circle cx="${(c.x - x).toFixed(0)}" cy="${(c.y - y).toFixed(0)}" r="${r.toFixed(0)}" fill="${col}" fill-opacity=".5" stroke="${col}" stroke-width="14"/>`;
    o += `<text x="${(c.x - x).toFixed(0)}" y="${(c.y - y + 60).toFixed(0)}" font-size="${Math.max(110, Math.min(260, r / 2.5))}" fill="#fff" text-anchor="middle">${Math.round(c.mass)}·${order[c.unit].indexOf(c.id) + 1}</text>`;
  }
  for (const u of [0, 1]) { const a = s.aim[u]; o += `<circle cx="${(a.x - x).toFixed(0)}" cy="${(a.y - y).toFixed(0)}" r="70" fill="${u ? '#f59e0b' : '#3b82f6'}"/>`; }
  html += o + `</svg><br>${s.source.file} · active ${s.active ? 'orange' : 'blue'} · course ${Math.round(s.source.course * 180 / Math.PI)}° turned to the right</div>`;
}
writeFileSync(process.argv[3], html + '</body></html>');
