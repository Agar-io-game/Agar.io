// Gameplay constants. Values marked "measured" come from the live capture of the Caffe
// server (PROTOCOL.md §14); the rest are reasonable defaults you can tune.
export default {
  port: Number(process.env.PORT) || 2525,

  tickMs: 40,                 // measured: 25 Hz

  // Infinite field: no walls, nothing clamps positions. Players spawn within ±spawnArea of
  // the origin. The client's "Map Walls" setting (or /walls on in chat) switches to Caffe's
  // measured 32000 x 32000 box with its walls, centred on the origin.
  infiniteField: true,
  wallMargin: 0.5,            // measured: a player cell's centre stops half its radius inside the wall
  spawnArea: 3000,
  pelletArea: 16000,          // pellets/viruses (if enabled) are scattered within ±pelletArea
  field: { minX: -16000, minY: -16000, maxX: 16000, maxY: 16000 }, // measured size (Caffe's runs 0..32000)

  spawnMass: 399,             // measured
  pelletMass: 10,             // measured (displayed mass and mass gained)
  pelletCount: 0,             // off; the measured server had pellets (try 3000)
  virusMass: 100,             // measured
  virusCount: 0,              // off; try 40 to bring viruses back
  virusFeedsToShoot: 7,
  virusFeedMass: 16,          // from the original client's virus split hint

  maxCellsPerUnit: 16,        // measured
  minSplitMass: 44,           // from the client's split-prediction code
  // Measured motionSpeed of a new split piece: a + b*ln(r) + c*ln(r)^2, fitted to 3162
  // pieces of a live Caffe log (195.3 at mass 32, 192.9 at 1000, 190.7 at 8000).
  splitBoostLn: [195.0664, 1.062004, -0.2515050],
  splitBoostDecay: 0.8866,    // measured, per tick (applied before the move)
  splitBoostStop: 2.5,        // measured: the boost drops to 0 once it falls under ~2.5
  // Measured: a boosted cell travels motionSpeed / 2 per tick on top of its normal move.
  boostTravelFactor: 0.5,

  ejectMass: 15,              // measured
  ejectCost: 15.5,            // measured: 399 -> 384 -> 368 -> 353 -> 337
  ejectMinMass: 32,
  ejectFirstStep: 103.1,      // measured first-tick travel of ejected mass
  ejectDecay: 0.825,          // measured, per tick
  // Measured on Caffe: while E is held, every cell ejects on every tick (25 per second);
  // the gap between ejects was exactly 1 tick in all 14 holds. (Ogar's vanilla is 100 ms.)
  ejectHoldIntervalTicks: 1,

  // Measured with identical probes on Caffe (median per-tick move, cursor far away):
  // mass 384 -> 8.41, 200 -> 9.75, 100 -> 11.29, 51 -> 13.08, 25 -> 15.16, which is
  // 82.5 * r^-0.432 within 0.5 %. (88 * r^-0.439, from earlier spectating, was 3-7 % fast.)
  speedCoefficient: 82.5,
  speedExponent: -0.432,

  eatRatio: 1.3,              // from the client's eat markers
  eatOverlap: 0.425,          // measured on Caffe: eaten once the centre is within big.r - k*small.r, k in (0.411, 0.44]
  ownUnitsCanEatEachOther: true, // your two units can eat each other (split running)
  // Measured on Caffe: an eaten cell is still sent for one more tick inside the grown eater,
  // then removed (the "swallow"). false removes it at once, like versions before Oct 18.
  eatenLinger: true,

  // Recombining (Ogar rule; the real server, TsOgarRx, is an Ogar derivative):
  // after a split, each half may merge again only after
  //   recombineBaseSec + recombineMassFactor * mass   seconds,
  // and two cells merge only when BOTH timers have run out. Splitting again restarts the
  // timer on both halves. 400 mass -> 38 s, 2000 mass -> 70 s.
  recombineBaseSec: 30,
  recombineMassFactor: 0.02,
  // Measured on Caffe: a split piece and the cell it came from pass through the other cells
  // of their unit for 15 ticks, and are pushed out on the 15th tick after the split.
  splitNoCollideMs: 600,
  // Measured on Caffe: overlapping cells of one unit are pushed apart by only HALF of their
  // overlap per tick (shared by mass, the lighter cell moving more), pair by pair in cell age
  // order. A packed group therefore keeps spreading out over many ticks instead of snapping
  // apart in one, and cells pressed together keep overlapping by about one tick of movement
  // of both. Fitted to a 2 splits > 120 ms > split at 5018 mass (8 pieces, 30 ticks): 0.19
  // units RMS error per cell per tick. 1 would resolve the whole overlap at once.
  ownPushFraction: 0.5,

  // Auto split: a cell above this mass splits in half in a random direction; with 16 cells
  // already, it is capped at this mass instead. 22500 is Ogar's playerMaxMass, and the
  // Senpai client's Auto Split Alert starts at 17325 = 0.77 x 22500. Not measured on the
  // live server. Set 0 to turn auto split off.
  autoSplitMass: 22500,

  // Tab: the second unit spawns at the cursor, at most this far beyond your cells' edge.
  // On Caffe a second unit appeared at the cursor about 3000 beyond a 399 cell's edge, so
  // the cap only stops far-off spawns when you are zoomed far out.
  secondUnitMaxDist: 4000,
  // Measured on Caffe (13 trials): the second unit appears at a random spot within about
  // 2300 of the cursor (780-2150 seen), not exactly on it.
  secondUnitScatter: 2300,

  // Sandbox keys (Increase/Decrease Mass): the client repeats these every 16 ms while held.
  minCellMass: 10,
  maxCellMass: 65000,         // the wire format carries mass as u16

  // Mass decay, measured on Caffe (PROTOCOL.md §14): every tick each cell loses
  //   (decayBase + decayPerMass * mass) per second of its mass, so bigger cells lose a
  //   larger share. A unit only decays while its total mass is above decayMinTotal (the
  //   spawn mass), so small split-up players keep their mass. Set both rates to 0 for none.
  decayBase: 0.001427,
  decayPerMass: 2.33e-8,
  decayMinTotal: 399,

  spectateView: { w: 7920, h: 5940 }, // measured while spectating
  baseView: { w: 6040, h: 4530 },     // measured at spawn while playing (4:3)
  // The client zooms freely (like the original, starting at 0.08 px/unit), so send a wider
  // area than the measured view. Cheap with no pellets on the field.
  viewRangeMultiplier: 3,

  // Simulated ping for every player, in ms (each player can also type /ping 180 in chat).
  // The original's servers are in Japan, so from far away it plays with ~180 ms of delay.
  simulatedPingMs: 0,

  serverName: 'Recreation',
};
