export const Balance = {
  // Game loop
  tickDurationMs: 100,

  // Pspsps target track — stationary target on the right, moving "pspsps"
  // elements spawn at the left and slide right toward it. Tap to "catch"
  // them when they overlap the target.
  pspspsMaxElements: 3, // at most 3 on screen at once
  pspspsTargetXFraction: 0.95, // target sits near the right edge of the bar
  pspspsSpawnXFraction: 0, // elements appear right at the bar's left edge
  pspspsBaseSpeedFractionPerSecond: 0.2, // ~5 seconds to traverse the bar
  pspspsSpeedVariationPerSecond: 0.05, // ±0.05 = 0.15–0.25 per second
  pspspsBaseSpawnDelayTicks: 30, // spawn a new element every ~3s at 100ms/tick
  pspspsSpawnDelayVariation: 0.2, // ±20% variation in spawn timing
  pspspsPerfectMarginFraction: 0.05, // within 5% of bar width = perfect
  pspspsPartialMarginFraction: 0.2, // within 20% of bar width = partial
  pspspsPerfectPoints: 200,
  pspspsPartialPoints: 100,
  // pspsps speed scales linearly with meow-bar progress: 1x base speed at
  // an empty meter, this multiplier at a full meter. Tunable difficulty
  // curve without adding any new mechanic.
  pspspsSpeedMultiplierAtFullMeow: 2,

  // Combo multiplier. Consecutive successful taps build a streak; a tap
  // that earns no points resets it to 0. Listed in descending order so
  // we can early-out on the first matching tier.
  comboTiers: [
    { atLeast: 30, multiplier: 5 },
    { atLeast: 15, multiplier: 3 },
    { atLeast: 5, multiplier: 2 },
  ] as const,

  // Meow bar
  meowBarMax: 100,
  pointsPerMeowBarUnit: 10, // TEST: 10 score pts = 1% bar (100 pts = 10%) so we can fill the meter fast while debugging the petting interaction. revert to 100 before shipping.
  meowBarDrainPerTick: 1,
  meowBarSpeedPerExtraCat: 0.1,

  // Cats
  baseCatsOnScreen: 3,
  catAnimationFrameRate: 7, // dropped from 12 — cats were feeling jittery at the higher rate

  // Petting timing-bar mini-game. Each action gets its own green-zone
  // width (a fraction of the bar centered on 0.5), with smaller zones
  // paying out more coins to balance the difficulty.
  interactionZones: {
    pet: 0.7, // easy: any tap in the central 70% of the bar
    chinScratch: 0.3,
    bellyRub: 0.15, // hard: must hit the central 15%
  },
  interactionRewards: {
    pet: 10,
    chinScratch: 25,
    bellyRub: 60,
  },
  // Round timing
  interactionRoundDurationMs: 15_000, // full round budget
  interactionMissPenaltyMs: 1_000, // a miss eats a second off the clock
  // Marker oscillates back and forth across the bar. This is the time it
  // takes to traverse from one edge to the other (a full ping-pong cycle
  // is twice this).
  interactionMarkerTraversalMs: 1_400,
} as const;
