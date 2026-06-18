import { Balance } from '@/constants/balance';
import type { RhythmTapResult } from '@/types/game';

export class RhythmSystem {
  constructor(private readonly startTimeMs: number) {}

  tap(currentTimeMs: number): RhythmTapResult {
    const elapsed = currentTimeMs - this.startTimeMs;
    const nearestBeat =
      Math.round(elapsed / Balance.rhythmIntervalMs) * Balance.rhythmIntervalMs;
    const offset = Math.abs(elapsed - nearestBeat);

    if (offset <= Balance.rhythmPerfectWindowMs) {
      return { kind: 'perfect', pointsAwarded: Balance.rhythmPerfectPoints };
    }
    if (offset <= Balance.rhythmTapWindowMs) {
      return { kind: 'hit', pointsAwarded: Balance.rhythmHitPoints };
    }
    return { kind: 'miss', pointsAwarded: 0 };
  }

  beatIndexAt(currentTimeMs: number): number {
    const elapsed = currentTimeMs - this.startTimeMs;
    return Math.floor(elapsed / Balance.rhythmIntervalMs);
  }

  beatProgressAt(currentTimeMs: number): number {
    const elapsed = currentTimeMs - this.startTimeMs;
    return (elapsed % Balance.rhythmIntervalMs) / Balance.rhythmIntervalMs;
  }
}
