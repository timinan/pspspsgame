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

/** play-tutorial phase 2 — adjacent 1-lane slides. Per Tim's script
 *  edit: previous 8-step gaps felt like the slides were coming down too
 *  slow. Tightened to 5-step gaps (3 slides at 0/5/10 in a 16-step
 *  chart). */
export const TUTORIAL_CHART_SLIDES_1: Chart = {
  ...base('Tutorial — 1-Lane Slides', 16),
  steps: Array.from({ length: 16 }, emptyStep),
  holds: [],
  slides: [
    { startStep: 0,  sourceLane: 0, targetLane: 1 },
    { startStep: 5,  sourceLane: 2, targetLane: 1 },
    { startStep: 10, sourceLane: 0, targetLane: 1 },
  ],
  slideReturns: [],
};

/** play-tutorial phase 3 — cross 2-lane slides. 5-step gaps (was 8). */
export const TUTORIAL_CHART_SLIDES_2: Chart = {
  ...base('Tutorial — 2-Lane Slides', 16),
  steps: Array.from({ length: 16 }, emptyStep),
  holds: [],
  slides: [
    { startStep: 0,  sourceLane: 0, targetLane: 2 },
    { startStep: 5,  sourceLane: 2, targetLane: 0 },
    { startStep: 10, sourceLane: 0, targetLane: 2 },
  ],
  slideReturns: [],
};

/** play-tutorial phase 4 — slide-returns (adjacent ◀▶). 5-step gaps. */
export const TUTORIAL_CHART_DOUBLES: Chart = {
  ...base('Tutorial — Double Slides', 16),
  steps: Array.from({ length: 16 }, emptyStep),
  holds: [], slides: [],
  slideReturns: [
    { startStep: 0,  sourceLane: 0, targetLane: 1 },
    { startStep: 5,  sourceLane: 2, targetLane: 1 },
    { startStep: 10, sourceLane: 0, targetLane: 1 },
  ],
};

/** play-tutorial phase 5 — insane chart at canonical fall speed.
 *  Per Tim's followup: 'speed up the drops and dont have it as dense
 *  maybe do a harder hard level instead of what we have because that
 *  is literally unplayable.' 24 steps at 2× BPM (was 16 × 3×) — less
 *  overlapping density, mostly taps with a handful of chords and one
 *  slide. Player can pass on 10 hits, or fall back to the 15s cap. */
export const TUTORIAL_CHART_INSANE: Chart = {
  ...base('Tutorial — Insane', 24, BPM * 2),
  steps: [
    tap(1),       emptyStep(),
    tap(0),       emptyStep(),
    tap(2),       chord(0, 1),
    emptyStep(),  tap(1),
    chord(1, 2),  emptyStep(),
    tap(0),       emptyStep(),
    tap(2),       chord(0, 2),
    emptyStep(),  tap(1),
    tap(0),       chord(0, 1),
    emptyStep(),  tap(2),
    tap(1),       emptyStep(),
    tap(0),       tap(2),
  ],
  holds: [
    { lane: 1, startStep: 16, endStep: 19 },
  ],
  slides: [
    { startStep: 9, sourceLane: 0, targetLane: 2 },
  ],
  slideReturns: [],
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
   *  When BOTH hitsToAdvance and durationMs are set, the phase exits on
   *  whichever fires FIRST — the player can pass early by hitting the
   *  target, OR the wall-clock cap moves them on if they can't. */
  hitsToAdvance?: number;
  /** Slide-phase counter. Counts SLIDE COMPLETIONS specifically (not the
   *  engage tap, not any other hits) so the 3-slide gate doesn't trip
   *  after 1 slide + a stray tap. Use instead of hitsToAdvance on slide
   *  phases; takes precedence when set. */
  slideCompletionsToAdvance?: number;
  /** Wall-clock cap. The phase exits after this many ms (insane phase).
   *  Pairs with hitsToAdvance — whichever fires first wins. */
  durationMs?: number;
  /** When true the Game scene shows the dialogue bubble + a Yes-only
   *  button BEFORE starting chart playback — used on the insane-run
   *  pre-roll so 'ready for a real chart?' sits on top of the actual
   *  lane view instead of bouncing back to a separate orchestrator
   *  screen. Chart starts when the player taps Yes. */
  preRollGate?: boolean;
  /** Override TUTORIAL_NOTE_FALL_MS for this phase. Used on the insane
   *  phase to drop notes at canonical Balance.noteFallMs (2400) instead
   *  of the slowed tutorial pace — Tim: "BPM should fall faster but on
   *  a hard chart basically the normal speed we have for our regular
   *  songs." */
  noteFallMsOverride?: number;
}

/** play-tutorial-intro is a separate TutorialStepId; it uses its own
 *  phase index = -1 in the orchestrator's lookup to distinguish from
 *  the play-tutorial array. */
export const TUTORIAL_INTRO_PHASE_CONFIG: TutorialPhaseConfig = {
  chart: TUTORIAL_CHART_INTRO,
  hitsToAdvance: 5,
};

/** Maps `playTutorialPhase` (0-6) to its Game-mode config, or null
 *  when the phase is handled entirely by TutorialOrchestrator. */
export const TUTORIAL_PHASE_CONFIGS: ReadonlyArray<TutorialPhaseConfig | null> = [
  { chart: TUTORIAL_CHART_CHORDS,   hitsToAdvance: 10 }, // 0 chords (5 chord events, 12 notes)
  { chart: TUTORIAL_CHART_HOLDS,    hitsToAdvance: 6 },  // 1 holds (2 singles + 2 doubles; final double required)
  { chart: TUTORIAL_CHART_SLIDES_1, slideCompletionsToAdvance: 3 }, // 2 slides-1
  { chart: TUTORIAL_CHART_SLIDES_2, slideCompletionsToAdvance: 3 }, // 3 slides-2
  { chart: TUTORIAL_CHART_DOUBLES,  slideCompletionsToAdvance: 3 }, // 4 double-slides
  // 5 — insane. Pass on 10 hits OR 15s cap, whichever fires first.
  // noteFallMsOverride = 2400 drops notes at canonical chart speed.
  { chart: TUTORIAL_CHART_INSANE, hitsToAdvance: 10, durationMs: 15000, preRollGate: true, noteFallMsOverride: 2400 },
  null,                                                                     // 6 outro (orchestrator handles)
];
