export const Balance = {
  // Game loop
  tickDurationMs: 100,

  // Pspsps target track — stationary target on the right, moving "pspsps"
  // elements spawn at the left and slide right toward it. Tap to "catch"
  // them when they overlap the target.
  pspspsMaxElements: 10,
  pspspsTargetXFraction: 0.85, // target sits at 85% of bar width
  pspspsSpawnXFraction: -0.05, // elements appear just off the left edge
  pspspsBaseSpeedFractionPerTick: 0.01, // 1% of bar width per tick
  pspspsSpeedVariation: 0.005, // ±0.5% per tick variation
  pspspsBaseSpawnDelayTicks: 18, // spawn a new element every ~1.8s at 100ms/tick
  pspspsSpawnDelayVariation: 0.2, // ±20% variation in spawn timing
  pspspsPerfectMarginFraction: 0.05, // within 5% of target width = perfect
  pspspsPartialMarginFraction: 0.2, // within 20% of target width = partial
  pspspsPerfectPoints: 200,
  pspspsPartialPoints: 100,
  pspspsTargetHitAnimationMs: 350,

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
