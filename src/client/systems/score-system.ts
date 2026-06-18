export class ScoreSystem {
  private score = 0;

  add(points: number): void {
    this.score += Math.floor(points);
  }

  reset(): void {
    this.score = 0;
  }

  get(): number {
    return this.score;
  }
}
