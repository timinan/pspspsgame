import { Balance } from '@/constants/balance';

export type HitGrade = 'perfect' | 'great' | 'miss';

export class ScoreSystem {
  private score = 0;
  private combo = 0;
  private maxCombo = 0;
  private hits = { perfect: 0, great: 0, miss: 0 };

  add(points: number): void {
    this.score += Math.floor(points);
  }

  /** Register a rhythm hit. Updates score, combo, maxCombo, and hit counters. */
  registerHit(grade: HitGrade): void {
    if (grade === 'perfect') {
      this.score += Balance.pointsPerfect;
      this.combo++;
      this.hits.perfect++;
    } else if (grade === 'great') {
      this.score += Balance.pointsGreat;
      this.combo++;
      this.hits.great++;
    } else {
      // miss — reset combo, no points
      this.combo = 0;
      this.hits.miss++;
    }
    if (this.combo > this.maxCombo) this.maxCombo = this.combo;
  }

  reset(): void {
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.hits = { perfect: 0, great: 0, miss: 0 };
  }

  get(): number {
    return this.score;
  }

  getCombo(): number {
    return this.combo;
  }

  getMaxCombo(): number {
    return this.maxCombo;
  }

  /** Returns accuracy 0–100. Returns 0 if no notes were judged. */
  getAccuracy(): number {
    const judged = this.hits.perfect + this.hits.great + this.hits.miss;
    if (judged === 0) return 0;
    return ((this.hits.perfect + this.hits.great) / judged) * 100;
  }

  getMisses(): number {
    return this.hits.miss;
  }
}
