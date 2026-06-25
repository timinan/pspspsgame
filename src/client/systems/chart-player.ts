import type { Chart, LaneId } from '../../shared/state';

export interface ChartPlayerOpts {
  loopCount: number;
  noteFallMs: number;
  /** Hard cap on totalMs regardless of loopCount × pass duration. Game.ts
   *  uses this to enforce a spawn cutoff so the last note finishes before
   *  the round-end wall-clock. When omitted, totalMs = loopCount × pass. */
  maxTotalMs?: number;
  /** Chart step the player should START at (in CHART steps, not loop
   *  steps). Editor rehearse passes its scrollOffset so the author
   *  lands on the page they were working on. Defaults to 0. */
  startStep?: number;
}

export class ChartPlayer {
  private elapsedMs = 0;
  private nextEmitStep = 0;
  private listeners: Array<(lane: LaneId, hitAt: number) => void> = [];
  private holdListeners: Array<(lane: LaneId, hitAt: number, releaseAt: number) => void> = [];
  private slideListeners: Array<(sourceLane: LaneId, targetLane: LaneId, hitAt: number) => void> = [];
  private slideReturnListeners: Array<(sourceLane: LaneId, targetLane: LaneId, hitAt: number) => void> = [];
  private msPerStep: number;
  private totalMs: number;

  constructor(
    private chart: Chart,
    private opts: ChartPlayerOpts,
  ) {
    // 8 steps per bar => msPerStep = (60000 / bpm) / 2 (assumes 8 eighth-notes per bar)
    this.msPerStep = 60000 / (chart.bpm * 2);
    const naturalTotal = this.msPerStep * chart.stepCount * opts.loopCount;
    this.totalMs = Math.min(naturalTotal, opts.maxTotalMs ?? Number.POSITIVE_INFINITY);
    // Editor rehearse path: skip nextEmitStep ahead to startStep so
    // first emitted notes are from that page. Bound the start to keep
    // it inside [0, chart.stepCount) so we don't blast past the loop.
    const startStep = opts.startStep ?? 0;
    if (startStep > 0 && chart.stepCount > 0) {
      this.nextEmitStep = Math.max(0, Math.min(chart.stepCount - 1, Math.floor(startStep)));
      // elapsedMs needs to advance accordingly so the advance() loop's
      // `t < startSpawnAt` skip-past-the-past check still works.
      this.elapsedMs = this.nextEmitStep * this.msPerStep;
    }
  }

  /** Ms offset corresponding to the configured startStep. Game.ts
   *  reads this to seek MusicSystem's backing audio so the music
   *  starts in sync with where the chart picked up. */
  get startOffsetMs(): number {
    const startStep = this.opts.startStep ?? 0;
    return Math.max(0, startStep * this.msPerStep);
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

  /** Fires when a slide-and-return note should be spawned. Same shape
   *  as onSlideSpawn — the player must tap source, drag to target, then
   *  drag back to source. Adjacent lanes only. */
  onSlideReturnSpawn(fn: (sourceLane: LaneId, targetLane: LaneId, hitAt: number) => void): void {
    this.slideReturnListeners.push(fn);
  }

  advance(dtMs: number): void {
    const prevMs = this.elapsedMs;
    this.elapsedMs += dtMs;
    const startSpawnAt = prevMs;
    const stopSpawnAt = Math.min(this.elapsedMs, this.totalMs);
    const holds = this.chart.holds ?? [];
    const slides = this.chart.slides ?? [];
    const slideReturns = this.chart.slideReturns ?? [];
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
      // Slide-and-returns — same modulo loop treatment.
      for (const sr of slideReturns) {
        if (sr.startStep !== stepIdx) continue;
        for (const fn of this.slideReturnListeners) fn(sr.sourceLane, sr.targetLane, hitAt);
      }
      this.nextEmitStep += 1;
    }
  }

  isFinished(): boolean {
    // all spawned notes have fallen: chart end + full fall window
    return this.elapsedMs >= this.totalMs + this.opts.noteFallMs;
  }
}
