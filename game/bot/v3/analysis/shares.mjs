// Short form of trace.mjs output: per press, each unit's cell count, share and biggest cell.
//   node bot/v3/analysis/trace.mjs 0 60 | node bot/v3/analysis/shares.mjs
let text = '';
process.stdin.on('data', (d) => (text += d)).on('end', () => {
  for (const l of text.split('\n')) {
    const m = l.match(/^(t=\S+) x=(\S+) (U\d) (split\d) aim (\S+)\s+\| U0\[(\d+)\] (.*) \| U1\[(\d+)\] (.*)$/);
    if (!m) { if (l.startsWith('along')) console.log(l.slice(0, 330)); continue; }
    const ms = (s) => s.split(' ').map((x) => +x.split('@')[0]);
    const a = ms(m[7]), b = ms(m[9]), sa = a.reduce((x, y) => x + y, 0), sb = b.reduce((x, y) => x + y, 0);
    console.log(m[1].padEnd(8), ('x=' + m[2]).padEnd(8), m[3], m[4], m[5].padEnd(14), 'U0', String(m[6]).padStart(2), (sa / (sa + sb) * 100).toFixed(0).padStart(3) + '%', 'big', String(Math.max(...a)).padStart(5), '| U1', String(m[8]).padStart(2), 'big', Math.max(...b));
  }
});
