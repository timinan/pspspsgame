export const Balance = {
  // Game loop
  tickDurationMs: 100,

  // Pspsps target track — stationary target on the right, moving "pspsps"
  // elements spawn at the left and slide right toward it. Tap to "catch"
  // them when they overlap the target.
  pspspsMaxElements: 3, // at most 3 on screen at once
  pspspsTargetXFraction: 0.85, // target sits at 85% of bar width
  pspspsSpawnXFraction: -0.05, // elements appear just off the left edge
  pspspsBaseSpeedFractionPerSecond: 0.2, // ~5 seconds to traverse the bar
  pspspsSpeedVariationPerSecond: 0.05, // ±0.05 = 0.15–0.25 per second
  pspspsBaseSpawnDelayTicks: 30, // spawn a new element every ~3s at 100ms/tick
  pspspsSpawnDelayVariation: 0.2, // ±20% variation in spawn timing
  pspspsPerfectMarginFraction: 0.05, // within 5% of bar width = perfect
  pspspsPartialMarginFraction: 0.2, // within 20% of bar width = partial
  pspspsPerfectPoints: 200,
  pspspsPartialPoints: 100,

  // Meow bar
  meowBarMax: 100,
  pointsPerMeowBarUnit: 5,
  meowBarDrainPerTick: 1,
  meowBarSpeedPerExtraCat: 0.1,

  // Cats
  baseCatsOnScreen: 3,
  catAnimationFrameRate: 8,

  // Interaction
  interactionChances: {
    pet: 0.7,
    chinScratch: 0.3,
    bellyRub: 0.15,
  },
  successCoinReward: 25,
  failCoinReward: 0,
} as const;
