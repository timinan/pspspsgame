import { Balance } from '@/constants/balance';
import type { InteractionType, InteractionOutcome } from '@/types/game';

export interface InteractionResult {
  outcome: InteractionOutcome;
  coinsAwarded: number;
}

export class InteractionSystem {
  constructor(private readonly rng: () => number = Math.random) {}

  static chanceFor(type: InteractionType): number {
    return Balance.interactionChances[type];
  }

  resolve(type: InteractionType): InteractionResult {
    const chance = InteractionSystem.chanceFor(type);
    const success = this.rng() < chance;
    return {
      outcome: success ? 'success' : 'fail',
      coinsAwarded: success ? Balance.successCoinReward : Balance.failCoinReward,
    };
  }
}
