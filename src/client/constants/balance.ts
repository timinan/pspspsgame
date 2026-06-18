export const Balance = {
  // Game loop
  tickDurationMs: 100,

  // Rhythm bar
  rhythmIntervalMs: 1000,
  rhythmTapWindowMs: 250,
  rhythmPerfectWindowMs: 80,
  rhythmHitPoints: 10,
  rhythmPerfectPoints: 20,

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
