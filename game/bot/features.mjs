// Position features shared by the learned value model (learn-value.mjs) and the bot.
// They describe a split-run position independent of where it is on the map: the two units
// are ordered heavier first, and directions are taken relative to the heading.
//
// cells: [{ unit, x, y, mass, boost, angle }], heading: unit vector of travel.
const speedOf = (mass) => 82.5 * Math.pow(Math.sqrt(100 * mass), -0.432);

export const FEATURE_NAMES = [
  'bias', 'nHeavy/16', 'nLight/16', 'lightShare', 'bigHeavy/M', 'bigLight/M',
  'lightEdibleByHeavy', 'heavyEdibleByLight', 'spread/1000', 'sep/1000', 'heavyAhead/1000',
  'baseSpeed', 'boostAhead', 'freeSlots/32', 'smallShare', 'frontShare',
];

export function features(cells, heading) {
  const u = [[], []];
  for (const c of cells) u[c.unit].push(c);
  const mass = (a) => a.reduce((s, c) => s + c.mass, 0);
  let H = u[0], L = u[1];
  if (mass(L) > mass(H)) [H, L] = [L, H];
  const M = mass(H) + mass(L) || 1, mL = mass(L);
  const big = (a) => a.reduce((m, c) => Math.max(m, c.mass), 0);
  const bigH = big(H), bigL = big(L);
  let ex = 0, ey = 0;
  for (const c of cells) { ex += c.x * c.mass; ey += c.y * c.mass; }
  ex /= M; ey /= M;
  const centre = (a) => { const m = mass(a) || 1; let x = 0, y = 0; for (const c of a) { x += c.x * c.mass; y += c.y * c.mass; } return { x: x / m, y: y / m }; };
  const cH = centre(H), cL = centre(L);
  let spread = 0, spd = 0, boost = 0, small = 0, front = 0;
  for (const c of cells) {
    const dx = c.x - ex, dy = c.y - ey;
    spread += c.mass * (dx * dx + dy * dy);
    spd += c.mass * speedOf(c.mass);
    if (c.boost > 0) boost += c.mass * c.boost * 3.9 * Math.max(0, Math.cos(c.angle) * heading.x + Math.sin(c.angle) * heading.y);
    if (c.mass < M / 64) small += c.mass;
    if (dx * heading.x + dy * heading.y > 0) front += c.mass;
  }
  let edL = 0, edH = 0;
  for (const c of L) if (bigH >= 1.3 * c.mass) edL += c.mass;
  for (const c of H) if (L.length && bigL >= 1.3 * c.mass) edH += c.mass;
  return [
    1, H.length / 16, L.length / 16, mL / M, bigH / M, bigL / M,
    edL / M, edH / M, Math.sqrt(spread / M) / 1000, Math.hypot(cH.x - cL.x, cH.y - cL.y) / 1000,
    ((cH.x - cL.x) * heading.x + (cH.y - cL.y) * heading.y) / 1000,
    spd / M, boost / M / 100, (32 - H.length - L.length) / 32, small / M, front / M,
  ];
}
