import { Balance } from '@/constants/balance';

export type HitGrade = 'perfect' | 'great' | 'miss';

export class ScoreSystem {
  private score = 0;
  private combo = 0;
  private maxCombo = 0;
  private hits = { perfect: 0, great: 0, miss: 0 };
  /** Number of tap streaks of length >= 2 that ended (via miss). Bumped
   *  by registerHit('miss') when the pre-miss combo was >= 2. The
   *  final in-flight streak (if any) is counted by the caller via
   *  finalizeInFlightCombo() at round-end. Feeds the "totalCombos"
   *  quest-friendly stat. */
  private combosCompleted = 0;

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
      // miss — the streak (if any of length >= 2) is finished; log it
      // before resetting the running counter.
      if (this.combo >= 2) this.combosCompleted++;
      this.combo = 0;
      this.hits.miss++;
    }
    if (this.combo > this.maxCombo) this.maxCombo = this.combo;
  }

  /** Round-end finalizer — a streak still in-flight when the chart ends
   *  never triggered the miss-path, so log it here so it counts toward
   *  totalCombos. Idempotent: resets combo to 0 after counting. */
  finalizeInFlightCombo(): void {
    if (this.combo >= 2) this.combosCompleted++;
    this.combo = 0;
  }

  getCombosCompleted(): number {
    return this.combosCompleted;
  }

  reset(): void {
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.hits = { perfect: 0, great: 0, miss: 0 };
    this.combosCompleted = 0;
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

  /** Successful taps so far (perfect + great). */
  getLanded(): number {
    return this.hits.perfect + this.hits.great;
  }

  /** Total judged notes so far (perfect + great + miss). */
  getJudged(): number {
    return this.hits.perfect + this.hits.great + this.hits.miss;
  }

  /** Per-grade breakdown — used by the round-stats emitter so PlayerStats
   *  can track perfects and non-perfect hits separately. */
  getPerfects(): number { return this.hits.perfect; }
  getGreats(): number { return this.hits.great; }
}
