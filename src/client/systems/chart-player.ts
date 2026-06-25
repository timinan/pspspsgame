import type { Chart, LaneId } from '../../shared/state';

export interface ChartPlayerOpts {
  loopCount: number;
  noteFallMs: number;
}

export class ChartPlayer {
  private elapsedMs = 0;
  private nextEmitStep = 0;
  private listeners: Array<(lane: LaneId, hitAt: number) => void> = [];
  private holdListeners: Array<(lane: LaneId, hitAt: number, releaseAt: number) => void> = [];
  private slideListeners: Array<(sourceLane: LaneId, targetLane: LaneId, hitAt: number) => void> = [];
  private msPerStep: number;
  private totalMs: number;

  constructor(
    private chart: Chart,
    private opts: ChartPlayerOpts,
  ) {
    // 8 steps per bar => msPerStep = (60000 / bpm) / 2 (assumes 8 eighth-notes per bar)
    this.msPerStep = 60000 / (chart.bpm * 2);
    this.totalMs = this.msPerStep * chart.stepCount * opts.loopCount;
  }

  onSpawn(fn: (lane: LaneId, hitAt: number) => void): void {
    this.listeners.push(fn);
  }

  /** Fires when a hold note should be spawned. `hitAt` is the head's
   *  target-line crossing time; `releaseAt` is the trailing edge's
   *  target-line crossing time. Game.ts wires this to spawnHoldNote. */
  onHoldSpawn(fn: (lane: LaneId, hitAt: number, releaseAt: number) => void): void {
    this.holdListeners.push(fn);
  }

  /** Fires when a slide note should be spawned. The player must tap in
   *  `sourceLane` at `hitAt` and drag to `targetLane`. */
  onSlideSpawn(fn: (sourceLane: LaneId, targetLane: LaneId, hitAt: number) => void): void {
    this.slideListeners.push(fn);
  }

  advance(dtMs: number): void {
    const prevMs = this.elapsedMs;
    this.elapsedMs += dtMs;
    const startSpawnAt = prevMs;
    const stopSpawnAt = Math.min(this.elapsedMs, this.totalMs);
    const holds = this.chart.holds ?? [];
    const slides = this.chart.slides ?? [];
    while (this.nextEmitStep * this.msPerStep <= stopSpawnAt) {
      const t = this.nextEmitStep * this.msPerStep;
      if (t < startSpawnAt && this.nextEmitStep > 0) {
        this.nextEmitStep += 1;
        continue;
      }
      const stepIdx = this.nextEmitStep % this.chart.stepCount;
      const step = this.chart.steps[stepIdx]!;
      const hitAt = t + this.opts.noteFallMs;
      for (const lane of step.lanes) {
        for (const fn of this.listeners) fn(lane, hitAt);
      }
      // Holds emit once per loop iteration when the loop's modulo step
      // equals the hold's startStep — same modulo treatment as taps so a
      // hold authored at step 4 fires on every loop pass at step 4.
      for (const hold of holds) {
        if (hold.startStep !== stepIdx) continue;
        const releaseAt = hitAt + (hold.endStep - hold.startStep) * this.msPerStep;
        for (const fn of this.holdListeners) fn(hold.lane, hitAt, releaseAt);
      }
      // Slides — same modulo loop treatment as taps + holds.
      for (const slide of slides) {
        if (slide.startStep !== stepIdx) continue;
        for (const fn of this.slideListeners) fn(slide.sourceLane, slide.targetLane, hitAt);
      }
      this.nextEmitStep += 1;
    }
  }

  isFinished(): boolean {
    // all spawned notes have fallen: chart end + full fall window
    return this.elapsedMs >= this.totalMs + this.opts.noteFallMs;
  }
}
