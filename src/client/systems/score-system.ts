import { Balance } from '@/constants/balance';

export type HitGrade = 'perfect' | 'great' | 'miss';

export class ScoreSystem {
  private score = 0;
  private combo = 0;

  add(points: number): void {
    this.score += Math.floor(points);
  }

  /** Register a rhythm hit. Updates score and combo. */
  registerHit(grade: HitGrade): void {
    if (grade === 'perfect') {
      this.score += Balance.pointsPerfect;
      this.combo++;
    } else if (grade === 'great') {
      this.score += Balance.pointsGreat;
      this.combo++;
    } else {
      // miss — reset combo, no points
      this.combo = 0;
    }
  }

  reset(): void {
    this.score = 0;
    this.combo = 0;
  }

  get(): number {
    return this.score;
  }

  getCombo(): number {
    return this.combo;
  }
}
