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
 *   intro (play-tutorial-intro)  — sparse taps on lane 1
 *   0 chords                      — 5 chord events (2- and 3-note)
 *   1 holds                       — 2 single-lane + 2 double-lane
 *   2 slides-1                    — 0→1, 2→1 (adjacent)
 *   3 slides-2                    — 0→2, 2→0 (cross)
 *   4 double-slides               — slide-returns adjacent
 *   5 insane                      — dense mixed, exits on 5s timer
 *   6 outro                       — no chart (orchestrator handles)
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

/** play-tutorial-intro — 5 sparse taps spread across all 3 lanes per Tim
 *  image 5: "make it drop on other lanes too not just down the center
 *  and add a little bit more spacing between one falling note and the
 *  next on the same lane." 24 steps, ~5-step gap between consecutive
 *  notes (was 3), 15-step gap between revisits of the same lane. */
export const TUTORIAL_CHART_INTRO: Chart = {
  ...base('Tutorial — Taps', 24),
  steps: [
    tap(0), emptyStep(), emptyStep(), emptyStep(), emptyStep(), // 0 → lane 0
    tap(2), emptyStep(), emptyStep(), emptyStep(), emptyStep(), // 5 → lane 2
    tap(1), emptyStep(), emptyStep(), emptyStep(), emptyStep(), // 10 → lane 1
    tap(0), emptyStep(), emptyStep(), emptyStep(), emptyStep(), // 15 → lane 0 (15-step gap)
    tap(2), emptyStep(), emptyStep(), emptyStep(),              // 20 → lane 2 (15-step gap)
  ],
  holds: [], slides: [], slideReturns: [],
};

/** play-tutorial phase 0 — 5 chord events (2-note + 3-note). hitsToAdvance:10
 *  catches notes-not-chords (2+3+2+2+3=12 notes total; floor below 10 lets
 *  player finish without nailing every note but still requires most chords). */
export const TUTORIAL_CHART_CHORDS: Chart = {
  ...base('Tutorial — Chords', 16),
  steps: [
    chord(0, 1), emptyStep(), emptyStep(),       // 2-note chord
    chord(0, 1, 2), emptyStep(), emptyStep(),    // 3-note chord
    chord(1, 2), emptyStep(), emptyStep(),       // 2-note chord
    chord(0, 2), emptyStep(), emptyStep(),       // 2-note chord (outer)
    chord(0, 1, 2), emptyStep(), emptyStep(),    // 3-note chord
    emptyStep(),
  ],
  holds: [], slides: [], slideReturns: [],
};

/** play-tutorial phase 1 — 2 single-lane holds + 2 double-lane holds.
 *  Per Tim image 5: holds are now 4 steps long (was 2) and consecutive
 *  events don't stack on the same lane. Singles alternate lane 0 → lane
 *  2; doubles are lanes 0+1 then lanes 1+2 so the same lane never
 *  appears in adjacent SINGLE events. Lane 1 still spans both doubles
 *  (unavoidable with 3 lanes + 2 distinct double-hold pairings), but a
 *  4-step gap between hold-ends gives the finger time to reposition.
 *
 *  hitsToAdvance:6 = 1+1+2+2 (each lane scores at hold-end). The 6th
 *  hit only lands when the player completes the final double, so the
 *  advance gate naturally requires a clean double-hold. */
export const TUTORIAL_CHART_HOLDS: Chart = {
  ...base('Tutorial — Holds', 32),
  steps: Array.from({ length: 32 }, emptyStep),
  holds: [
    // single-lane hold on lane 0
    { lane: 0, startStep: 0, endStep: 4 },
    // single-lane hold on lane 2 (different lane from prior single)
    { lane: 2, startStep: 8, endStep: 12 },
    // double-lane hold: lanes 0 + 1
    { lane: 0, startStep: 16, endStep: 20 },
    { lane: 1, startStep: 16, endStep: 20 },
    // double-lane hold: lanes 1 + 2 (different pairing from prior)
    { lane: 1, startStep: 24, endStep: 28 },
    { lane: 2, startStep: 24, endStep: 28 },
  ],
  slides: [], slideReturns: [],
};

/** play-tutorial phase 2 — adjacent 1-lane slides (0→1 and 2→1). Per
 *  Tim image 5: original 2-step spacing was overwhelming — 4 slides
 *  arriving back-to-back. Now 3 slides at 8-step gaps. matches
 *  slideCompletionsToAdvance:3. */
export const TUTORIAL_CHART_SLIDES_1: Chart = {
  ...base('Tutorial — 1-Lane Slides', 24),
  steps: Array.from({ length: 24 }, emptyStep),
  holds: [],
  slides: [
    { startStep: 0,  sourceLane: 0, targetLane: 1 },
    { startStep: 8,  sourceLane: 2, targetLane: 1 },
    { startStep: 16, sourceLane: 0, targetLane: 1 },
  ],
  slideReturns: [],
};

/** play-tutorial phase 3 — cross 2-lane slides (0→2 and 2→0). 3 slides
 *  at 8-step gaps (was 4 slides at 2-step gaps). */
export const TUTORIAL_CHART_SLIDES_2: Chart = {
  ...base('Tutorial — 2-Lane Slides', 24),
  steps: Array.from({ length: 24 }, emptyStep),
  holds: [],
  slides: [
    { startStep: 0,  sourceLane: 0, targetLane: 2 },
    { startStep: 8,  sourceLane: 2, targetLane: 0 },
    { startStep: 16, sourceLane: 0, targetLane: 2 },
  ],
  slideReturns: [],
};

/** play-tutorial phase 4 — slide-returns (adjacent ◀▶). 3 slide-returns
 *  at 8-step gaps (was 4 at 2-step gaps). */
export const TUTORIAL_CHART_DOUBLES: Chart = {
  ...base('Tutorial — Double Slides', 24),
  steps: Array.from({ length: 24 }, emptyStep),
  holds: [], slides: [],
  slideReturns: [
    { startStep: 0,  sourceLane: 0, targetLane: 1 },
    { startStep: 8,  sourceLane: 2, targetLane: 1 },
    { startStep: 16, sourceLane: 0, targetLane: 1 },
  ],
};

/** play-tutorial phase 5 — insane density (5s timer in Game scene). */
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
 * Phase 6 (outro) is NULL — it doesn't use Game scene at all;
 * TutorialOrchestrator handles it with non-gameplay visuals (menu mock).
 */
export interface TutorialPhaseConfig {
  chart: Chart;
  /** Player must land this many hits before Game returns to orchestrator.
   *  Ignored when `durationMs` is set (insane phase). */
  hitsToAdvance?: number;
  /** Slide-phase counter. Counts SLIDE COMPLETIONS specifically (not the
   *  engage tap, not any other hits) so the 3-slide gate doesn't trip
   *  after 1 slide + a stray tap. Use instead of hitsToAdvance on slide
   *  phases; takes precedence when set. */
  slideCompletionsToAdvance?: number;
  /** Hard wall-clock cap. When set, Game exits after this many ms
   *  regardless of hit count (insane phase). */
  durationMs?: number;
}

/** play-tutorial-intro is a separate TutorialStepId; it uses its own
 *  phase index = -1 in the orchestrator's lookup to distinguish from
 *  the play-tutorial array. */
export const TUTORIAL_INTRO_PHASE_CONFIG: TutorialPhaseConfig = {
  chart: TUTORIAL_CHART_INTRO,
  hitsToAdvance: 5,
};

/** Maps `playTutorialPhase` (0-7) to its Game-mode config, or null
 *  when the phase is handled entirely by TutorialOrchestrator. */
export const TUTORIAL_PHASE_CONFIGS: ReadonlyArray<TutorialPhaseConfig | null> = [
  { chart: TUTORIAL_CHART_CHORDS,   hitsToAdvance: 10 }, // 0 chords (5 chord events, 12 notes)
  { chart: TUTORIAL_CHART_HOLDS,    hitsToAdvance: 6 },  // 1 holds (2 singles + 2 doubles; final double required)
  { chart: TUTORIAL_CHART_SLIDES_1, slideCompletionsToAdvance: 3 }, // 2 slides-1
  { chart: TUTORIAL_CHART_SLIDES_2, slideCompletionsToAdvance: 3 }, // 3 slides-2
  { chart: TUTORIAL_CHART_DOUBLES,  slideCompletionsToAdvance: 3 }, // 4 double-slides
  null,                                                   // 5 "ready for a real chart?" Yes-only beat (orchestrator)
  { chart: TUTORIAL_CHART_INSANE,   durationMs: 5000 },  // 6 insane
  null,                                                   // 7 outro (orchestrator handles)
];
