import { Balance } from '@/constants/balance';

export class MeowBarSystem {
  private progress = 0;
  private lastTriggerScore = 0;
  private extraCats = 0;

  setExtraCats(count: number): void {
    this.extraCats = Math.max(0, count);
  }

  onScoreChanged(currentScore: number): void {
    if (this.progress >= Balance.meowBarMax) return;
    const speedMultiplier = 1 + this.extraCats * Balance.meowBarSpeedPerExtraCat;
    const effectivePointsPerUnit = Balance.pointsPerMeowBarUnit / speedMultiplier;
    const deltaScore = currentScore - this.lastTriggerScore;
    const unitsToAdd = Math.floor(deltaScore / effectivePointsPerUnit);

    if (unitsToAdd > 0) {
      this.lastTriggerScore += unitsToAdd * effectivePointsPerUnit;
      this.progress = Math.min(Balance.meowBarMax, this.progress + unitsToAdd);
    }
  }

  drainTick(): void {
    this.progress = Math.max(0, this.progress - Balance.meowBarDrainPerTick);
  }

  getProgress(): number {
    return this.progress;
  }

  isFull(): boolean {
    return this.progress >= Balance.meowBarMax;
  }

  isEmpty(): boolean {
    return this.progress <= 0;
  }

  reset(): void {
    this.progress = 0;
    this.lastTriggerScore = 0;
  }
}
