/**
 * Handcrafted tutorial mini-charts — one per `playTutorialPhase`.
 * Loaded by Game scene when `init.tutorialPhase` is set; played through
 * the real ChartPlayer pipeline so the player experiences the same
 * note rendering, hit-target flash, perfect/great grading, lane mask
 * clipping, and cat reactions they'll meet in actual shows.
 *
 * Tutorial mode tweaks (vs the real game):
 *   - Slower noteFallMs (passed via init.noteFallMs override) so the
 *     player has time to learn the gesture.
 *   - Game scene suppresses leaderboard / score-saving / summary modal
 *     / pass-fail gate when tutorialPhase is set.
 *   - Early exit fires after `hitsTarget` lands; `insane` phase exits
 *     on a wall-clock timer instead of hits.
 *
 * Sequence (mirrors TUTORIAL_DIALOGUE['play-tutorial']):
 *   intro (play-tutorial-intro)  — taps on lane 1
 *   0 chords                      — 2- AND 3-note chords
 *   1 lane-styling                — no chart (orchestrator handles)
 *   2 holds                       — hold lane 1
 *   3 slides-1                    — 0→1, 2→1 (adjacent)
 *   4 slides-2                    — 0→2, 2→0 (cross)
 *   5 double-slides               — slide-returns adjacent
 *   6 insane                      — dense mixed, exits on 5s timer
 *   7 outro                       — no chart (orchestrator handles)
 */

import type { Chart, ChartStep, LaneId } from './state';

const BPM = 70;        // slow tempo for learning
const STEPS = 8;       // one CHART_PAGE_SIZE — required positive multiple of 8

const emptyStep = (): ChartStep => ({ lanes: [] });
const tap = (lane: LaneId): ChartStep => ({ lanes: [lane] });
const chord = (...lanes: LaneId[]): ChartStep => ({ lanes });

const base = (title: string, stepCount = STEPS, bpm = BPM): Pick<
  Chart,
  'authorId' | 'title' | 'stepCount' | 'bpm' | 'updatedAt'
> => ({
  authorId: '_tutorial',
  title,
  stepCount,
  bpm,
  updatedAt: 0,
});

/** play-tutorial-intro — 4 taps on the center lane (player cat). */
export const TUTORIAL_CHART_INTRO: Chart = {
  ...base('Tutorial — Taps'),
  steps: [
    tap(1), emptyStep(),
    tap(1), emptyStep(),
    tap(1), emptyStep(),
    tap(1), emptyStep(),
  ],
  holds: [], slides: [], slideReturns: [],
};

/** play-tutorial phase 0 — taps + 2-note AND 3-note chords (Tim's spec). */
export const TUTORIAL_CHART_CHORDS: Chart = {
  ...base('Tutorial — Chords'),
  steps: [
    chord(0, 1), emptyStep(),       // 2-note chord
    chord(0, 1, 2), emptyStep(),    // 3-note chord
    chord(1, 2), emptyStep(),       // 2-note chord
    chord(0, 2), emptyStep(),       // 2-note chord (outer)
  ],
  holds: [], slides: [], slideReturns: [],
};

/** play-tutorial phase 2 — holds on the center lane. */
export const TUTORIAL_CHART_HOLDS: Chart = {
  ...base('Tutorial — Holds'),
  steps: Array.from({ length: STEPS }, emptyStep),
  holds: [
    { lane: 1, startStep: 0, endStep: 2 },
    { lane: 1, startStep: 4, endStep: 6 },
  ],
  slides: [], slideReturns: [],
};

/** play-tutorial phase 3 — adjacent 1-lane slides (0→1 and 2→1). */
export const TUTORIAL_CHART_SLIDES_1: Chart = {
  ...base('Tutorial — 1-Lane Slides'),
  steps: Array.from({ length: STEPS }, emptyStep),
  holds: [],
  slides: [
    { startStep: 0, sourceLane: 0, targetLane: 1 },
    { startStep: 2, sourceLane: 2, targetLane: 1 },
    { startStep: 4, sourceLane: 0, targetLane: 1 },
    { startStep: 6, sourceLane: 2, targetLane: 1 },
  ],
  slideReturns: [],
};

/** play-tutorial phase 4 — cross 2-lane slides (0→2 and 2→0). */
export const TUTORIAL_CHART_SLIDES_2: Chart = {
  ...base('Tutorial — 2-Lane Slides'),
  steps: Array.from({ length: STEPS }, emptyStep),
  holds: [],
  slides: [
    { startStep: 0, sourceLane: 0, targetLane: 2 },
    { startStep: 2, sourceLane: 2, targetLane: 0 },
    { startStep: 4, sourceLane: 0, targetLane: 2 },
    { startStep: 6, sourceLane: 2, targetLane: 0 },
  ],
  slideReturns: [],
};

/** play-tutorial phase 5 — slide-returns (adjacent ◀▶). */
export const TUTORIAL_CHART_DOUBLES: Chart = {
  ...base('Tutorial — Double Slides'),
  steps: Array.from({ length: STEPS }, emptyStep),
  holds: [], slides: [],
  slideReturns: [
    { startStep: 0, sourceLane: 0, targetLane: 1 },
    { startStep: 2, sourceLane: 2, targetLane: 1 },
    { startStep: 4, sourceLane: 0, targetLane: 1 },
    { startStep: 6, sourceLane: 2, targetLane: 1 },
  ],
};

/** play-tutorial phase 6 — insane density (5s timer in Game scene). */
export const TUTORIAL_CHART_INSANE: Chart = {
  ...base('Tutorial — Insane', STEPS, BPM * 2),  // 2x BPM = double density
  steps: [
    tap(0), chord(0, 1),
    tap(1), emptyStep(),
    tap(2), chord(0, 2),
    chord(0, 1, 2), tap(1),
  ],
  holds: [{ lane: 1, startStep: 3, endStep: 4 }],
  slides: [{ startStep: 1, sourceLane: 0, targetLane: 2 }],
  slideReturns: [{ startStep: 5, sourceLane: 1, targetLane: 0 }],
};

/**
 * Per-phase Game-mode config: which chart to load, hit threshold to
 * exit, optional wall-clock duration override (insane phase only).
 *
 * Phase 1 (lane styling) + Phase 7 (outro) are NULL — they don't use
 * Game scene at all; TutorialOrchestrator handles them with non-
 * gameplay visuals (lane flash + menu mock).
 */
export interface TutorialPhaseConfig {
  chart: Chart;
  /** Player must land this many hits before Game returns to orchestrator.
   *  Ignored when `durationMs` is set (insane phase). */
  hitsToAdvance?: number;
  /** Hard wall-clock cap. When set, Game exits after this many ms
   *  regardless of hit count (insane phase). */
  durationMs?: number;
}

/** play-tutorial-intro is a separate TutorialStepId; it uses its own
 *  phase index = -1 in the orchestrator's lookup to distinguish from
 *  the play-tutorial array. */
export const TUTORIAL_INTRO_PHASE_CONFIG: TutorialPhaseConfig = {
  chart: TUTORIAL_CHART_INTRO,
  hitsToAdvance: 3,
};

/** Maps `playTutorialPhase` (0-7) to its Game-mode config, or null
 *  when the phase is handled entirely by TutorialOrchestrator. */
export const TUTORIAL_PHASE_CONFIGS: ReadonlyArray<TutorialPhaseConfig | null> = [
  { chart: TUTORIAL_CHART_CHORDS,   hitsToAdvance: 3 },  // 0 chords
  null,                                                   // 1 lane-styling (orchestrator handles)
  { chart: TUTORIAL_CHART_HOLDS,    hitsToAdvance: 3 },  // 2 holds
  { chart: TUTORIAL_CHART_SLIDES_1, hitsToAdvance: 3 },  // 3 slides-1
  { chart: TUTORIAL_CHART_SLIDES_2, hitsToAdvance: 3 },  // 4 slides-2
  { chart: TUTORIAL_CHART_DOUBLES,  hitsToAdvance: 3 },  // 5 double-slides
  { chart: TUTORIAL_CHART_INSANE,   durationMs: 5000 },  // 6 insane
  null,                                                   // 7 outro (orchestrator handles)
];
