import {
  CHART_PAGE_SIZE,
  type Chart,
  type ChartStep,
  type Hold,
  type LaneId,
  type Slide,
  type SlideReturn,
  type BackingVibe,
} from './state';

export type GenDifficulty = 'easy' | 'medium' | 'spicy' | 'hard' | 'insane';

/**
 * Per-difficulty knobs for the procedural chart generator. Tuned by feel
 * against the 130bpm catalog — playable in test mode without dragging in
 * a real designer-curated template library yet.
 *
 *   density       — fraction of steps that fire at least one note
 *   chord2Chance  — given a firing step, fraction that fire on 2 lanes
 *   chord3Chance  — given a firing step, fraction that fire on all 3
 *   minGapSteps   — minimum empty steps between any two firing steps
 *                   (prevents accidental triplet bursts on easy)
 *   holdChance    — given a generated tap, fraction promoted to a hold
 *   holdMinSteps  — minimum hold duration in steps (inclusive)
 *   holdMaxSteps  — maximum hold duration in steps (inclusive)
 */
const PROFILES: Record<GenDifficulty, {
  density: number;
  chord2Chance: number;
  chord3Chance: number;
  minGapSteps: number;
  holdChance: number;
  holdMinSteps: number;
  holdMaxSteps: number;
  /** Per-tap chance of promotion to a slide (tap → drag to adjacent lane).
   *  Slides strip the underlying tap on commit. Easy gets a tiny dose so
   *  beginners are exposed to the gesture without overwhelming them. */
  slideChance: number;
  /** When promoting to a slide from lane 0 or 2, chance the target is
   *  the OPPOSITE outer lane (2-lane jump) rather than the middle.
   *  Higher = more long-distance slides. Lane 1 always targets 0 or 2
   *  randomly (no 2-lane option from the middle). */
  slide2LaneChance: number;
  /** Per-remaining-tap chance of promotion to a slide-and-return
   *  (drag to adjacent lane and back). Adjacent-only by design. Every
   *  difficulty gets some so every player is exposed to the gesture
   *  (Tim's rule). */
  slideReturnChance: number;
  /** Steps after a slide-and-return where notes are stripped from BOTH
   *  the source AND target lanes — the gesture is the hardest move in
   *  the game, so the player gets a breath. Larger gap on easier
   *  difficulties; never zero so even insane provides some recovery.
   *  Fractional values are supported via a per-slide-return rng roll —
   *  e.g., 1.5 = 50% chance of 1-step cooldown, 50% chance of 2-step. */
  slideReturnCooldownSteps: number;
  /** When true, the slide-promotion pass is allowed to fire on CHORD
   *  steps (>1 lane firing) — the slide takes its source lane, the
   *  other lanes keep their taps, producing the "slide + tap on
   *  another lane" 2-finger combo. Off by default; only insane sets
   *  it because the gesture is genuinely hard. */
  slideOnChords?: boolean;
}> = {
  easy:   { density: 0.30, chord2Chance: 0.00, chord3Chance: 0.00, minGapSteps: 2, holdChance: 0.04, holdMinSteps: 2, holdMaxSteps: 3, slideChance: 0.04, slide2LaneChance: 0.00, slideReturnChance: 0.02, slideReturnCooldownSteps: 4 },
  medium: { density: 0.45, chord2Chance: 0.18, chord3Chance: 0.00, minGapSteps: 1, holdChance: 0.12, holdMinSteps: 2, holdMaxSteps: 4, slideChance: 0.10, slide2LaneChance: 0.30, slideReturnChance: 0.07, slideReturnCooldownSteps: 3 },
  // Spicy sits between medium and hard — meaningful step-up without
  // jumping straight to the chord-heavy hard profile.
  spicy:  { density: 0.55, chord2Chance: 0.25, chord3Chance: 0.03, minGapSteps: 1, holdChance: 0.15, holdMinSteps: 2, holdMaxSteps: 5, slideChance: 0.14, slide2LaneChance: 0.40, slideReturnChance: 0.10, slideReturnCooldownSteps: 2 },
  hard:   { density: 0.65, chord2Chance: 0.32, chord3Chance: 0.06, minGapSteps: 0, holdChance: 0.18, holdMinSteps: 2, holdMaxSteps: 6, slideChance: 0.18, slide2LaneChance: 0.50, slideReturnChance: 0.12, slideReturnCooldownSteps: 2 },
  // Insane — top tier. Sliders feature heavily, taps dense + chord-
  // rich, holds longer, AND slides can land on chord steps (slide-
  // with-tap combos) for genuine 2-finger work. Cooldown 1.5 = half
  // the slide-returns get 1 step recovery, half get 2 — averages to
  // "tight but possible to clear at 100% with practice".
  // 2026-06-25 bump per Tim: density 0.82→0.88 fills the quieter
  // gaps (the chart still has brief rests but they're snappier), and
  // slideChance 0.34→0.42 leans harder into the slider-heavy feel
  // that defines the tier. Tim's rule: people work for 75%, but
  // 100% is still achievable.
  insane: { density: 0.88, chord2Chance: 0.48, chord3Chance: 0.18, minGapSteps: 0, holdChance: 0.24, holdMinSteps: 3, holdMaxSteps: 7, slideChance: 0.42, slide2LaneChance: 0.70, slideReturnChance: 0.22, slideReturnCooldownSteps: 1.5, slideOnChords: true },
};

/** Round a target step count UP to the nearest multiple of CHART_PAGE_SIZE.
 *  validateChart insists on this, and the editor pages over CHART_PAGE_SIZE
 *  chunks, so any leftover steps would break both. */
function roundUpToPage(steps: number): number {
  return Math.ceil(steps / CHART_PAGE_SIZE) * CHART_PAGE_SIZE;
}

/** Step count needed for the chart to span at least `targetMs` at `bpm`.
 *  Matches the formula in ChartPlayer (msPerStep = 60000 / (bpm * 2),
 *  i.e. 8 eighth-notes per bar). Rounded up to a clean page boundary. */
export function stepsForDuration(bpm: number, targetMs: number): number {
  const msPerStep = 60_000 / (bpm * 2);
  return roundUpToPage(Math.ceil(targetMs / msPerStep));
}

/** Tiny PRNG so two calls with the same inputs produce different feel
 *  while still being deterministic within one call. Plenty random for a
 *  rhythm generator; never use for security. */
function makeRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

/**
 * Generate a playable chart that fills at least `targetDurationMs` at
 * the selected BPM. The chart is fully populated — no empty pages — so
 * the round never silently starves the player of notes.
 *
 * The algorithm walks one step at a time, deciding whether to fire based
 * on the difficulty profile, then picks lanes for each firing step. Lane
 * pick avoids same-lane repetition on consecutive firings so the player
 * isn't pinned to one column for long stretches.
 */
export function generateChart(args: {
  authorId: string;
  title: string;
  difficulty: GenDifficulty;
  bpm: number;
  vibe: BackingVibe;
  targetDurationMs: number;
}): Chart {
  const { authorId, title, difficulty, bpm, vibe, targetDurationMs } = args;
  const profile = PROFILES[difficulty];
  const stepCount = stepsForDuration(bpm, targetDurationMs);

  const seed =
    (bpm * 31 + difficulty.charCodeAt(0) + vibe.charCodeAt(0) + Date.now()) | 0;
  const rng = makeRng(seed);

  const steps: ChartStep[] = Array.from({ length: stepCount }, () => ({ lanes: [] as LaneId[] }));

  let stepsSinceLastFire = profile.minGapSteps; // allow firing on step 0
  let lastLane: LaneId | null = null;

  for (let i = 0; i < stepCount; i++) {
    const canFire = stepsSinceLastFire >= profile.minGapSteps;
    if (!canFire || rng() >= profile.density) {
      stepsSinceLastFire++;
      continue;
    }

    // Pick lane count for this beat. chord3 implies a 3-lane hit (rare,
    // hard only); chord2 implies a 2-lane hit; default is a single tap.
    const roll = rng();
    let laneCount = 1;
    if (roll < profile.chord3Chance) laneCount = 3;
    else if (roll < profile.chord3Chance + profile.chord2Chance) laneCount = 2;

    const lanes = pickLanes(rng, laneCount, lastLane);
    steps[i]!.lanes = lanes;
    lastLane = lanes[0]!;
    stepsSinceLastFire = 0;
  }

  // Second pass — promote a fraction of generated taps into holds. Done
  // post-hoc so the tap-density profile stays predictable. A hold strips
  // any subsequent taps it would overlap in the same lane (keeps the
  // schema invariant: no tap on a hold's range, no overlapping holds).
  // Easy = 0% chance, so this loop is a no-op there.
  const holds: Hold[] = [];
  if (profile.holdChance > 0) {
    for (let i = 0; i < stepCount; i++) {
      const step = steps[i]!;
      // Snapshot lanes — we may splice during the loop.
      for (const lane of [...step.lanes]) {
        if (rng() >= profile.holdChance) continue;
        const range = profile.holdMaxSteps - profile.holdMinSteps;
        const durationSteps = profile.holdMinSteps + Math.floor(rng() * (range + 1));
        let endStep = i + durationSteps;
        if (endStep >= stepCount) endStep = stepCount - 1;
        if (endStep <= i) continue;
        // Skip if this would overlap an already-committed hold in same lane.
        const overlaps = holds.some(
          (h) => h.lane === lane && !(endStep < h.startStep || i > h.endStep),
        );
        if (overlaps) continue;
        // Strip the tap at startStep + any conflicting taps in range.
        const idx = step.lanes.indexOf(lane);
        if (idx >= 0) step.lanes.splice(idx, 1);
        for (let s = i + 1; s <= endStep; s++) {
          const nextStep = steps[s]!;
          const j = nextStep.lanes.indexOf(lane);
          if (j >= 0) nextStep.lanes.splice(j, 1);
        }
        holds.push({ lane, startStep: i, endStep });
      }
    }
  }

  // Third pass — promote a fraction of remaining taps into slides
  // (tap-and-drag, 1-lane adjacent OR 2-lane jump per difficulty mix).
  // Awkwardness guards (so the generator stays playable):
  //   - chord steps (>1 lane firing) skip slide promotion — would
  //     require multi-finger coordination (tap + drag simultaneously)
  //   - one slide per step max — multiple drag gestures at once is
  //     practically impossible on mobile
  //   - source can't be inside a hold on the same lane
  const slides: Slide[] = [];
  if (profile.slideChance > 0) {
    for (let i = 0; i < stepCount; i++) {
      const step = steps[i]!;
      // Skip chord steps entirely — slide + simultaneous tap on another
      // lane reads as a 2-finger contortion most players can't pull off.
      // EXCEPT on insane (`slideOnChords: true`) where the contortion
      // IS the point: the slide takes its source lane, other lanes
      // keep their taps, producing slide-with-tap combos.
      if (step.lanes.length !== 1 && !profile.slideOnChords) continue;
      if (step.lanes.length === 0) continue;
      // Already a slide at this step from a prior iteration's restart?
      if (slides.some((s) => s.startStep === i)) continue;
      // Pick lane: if the cell has multiple firing lanes, prefer one
      // that exists in the step. For chord steps on insane, pick the
      // first lane that doesn't violate the hold-conflict guard below;
      // single-tap steps just use the only lane present.
      const lane = step.lanes[0]!;
      if (rng() >= profile.slideChance) continue;
      if (holds.some((h) => h.lane === lane && i >= h.startStep && i <= h.endStep)) continue;
      // Target lane: from lane 1 (middle) always adjacent (random 0/2).
      // From an outer lane, slide2LaneChance picks the opposite outer
      // lane (2-lane jump) over the middle (1-lane).
      let target: LaneId;
      if (lane === 1) {
        target = rng() < 0.5 ? 0 : 2;
      } else {
        const opposite: LaneId = lane === 0 ? 2 : 0;
        target = rng() < profile.slide2LaneChance ? opposite : 1;
      }
      // Reject if the slide's path (source + target, + middle for 2-lane
      // jumps) crosses an active hold — the busy finger would block the
      // drag. Validator enforces the same rule; we mirror it here so the
      // generator never produces a chart that would fail validation.
      const touched: LaneId[] = Math.abs(lane - target) === 2 ? [lane, 1, target] : [lane, target];
      if (holds.some((h) => touched.includes(h.lane) && i >= h.startStep && i <= h.endStep)) continue;
      // Strip the source-lane tap from this cell. For 2-lane slides
      // ALSO strip any middle-lane tap (validator forbids middle-lane
      // tap on the same step since the slide finger crosses it).
      const srcIdx = step.lanes.indexOf(lane);
      if (srcIdx >= 0) step.lanes.splice(srcIdx, 1);
      if (Math.abs(lane - target) === 2) {
        const midIdx = step.lanes.indexOf(1);
        if (midIdx >= 0) step.lanes.splice(midIdx, 1);
      }
      slides.push({ startStep: i, sourceLane: lane, targetLane: target });
    }
  }

  // Fourth pass — promote a small fraction of the remaining single-tap
  // steps into slide-and-returns (drag to adjacent lane and back).
  // Adjacent-only by design. Same awkwardness guards as slides:
  //   - chord steps skipped (multi-finger)
  //   - cells already promoted to a slide skipped (one drag per cell)
  //   - source can't be inside a hold on the same OR target lane
  // Every difficulty gets a non-zero chance so every player sees the
  // gesture at least occasionally (Tim's rule: "expose everyone").
  const slideReturns: SlideReturn[] = [];
  if (profile.slideReturnChance > 0) {
    for (let i = 0; i < stepCount; i++) {
      const step = steps[i]!;
      if (step.lanes.length !== 1) continue;
      // Cell already claimed by a slide?
      if (slides.some((s) => s.startStep === i)) continue;
      const lane = step.lanes[0]!;
      if (rng() >= profile.slideReturnChance) continue;
      // Adjacent target: from middle (1) pick 0 or 2 randomly; from an
      // outer lane there's only one adjacent option (lane 1). 2-lane SR
      // variant was tried + reverted — gesture proved nearly impossible.
      const target: LaneId = lane === 1 ? (rng() < 0.5 ? 0 : 2) : 1;
      // Finger-conflict guard: source + target lanes must both be hold-
      // free at this step (mirrors validator + commitSlideReturn).
      if (holds.some(
        (h) => (h.lane === lane || h.lane === target) && i >= h.startStep && i <= h.endStep,
      )) continue;
      step.lanes.splice(0, 1);
      slideReturns.push({ startStep: i, sourceLane: lane, targetLane: target });
    }
  }

  // Cooldown pass — for every slide-and-return, strip taps + holds +
  // slides in BOTH the source and target lanes for the next N steps.
  // Slide-and-return is the hardest move in the game; the player needs
  // a moment to recover. N comes from the difficulty profile (easy 4 →
  // insane 1.5). Fractional values resolve per-slide-return via rng:
  // 1.5 = 50% of slide-returns get 1-step cooldown, 50% get 2-step.
  // Net effect on insane: tight but possible to clear at 100%.
  const cooldownBase = profile.slideReturnCooldownSteps;
  if (cooldownBase > 0 && slideReturns.length > 0) {
    for (const sr of slideReturns) {
      const floorN = Math.floor(cooldownBase);
      const extraChance = cooldownBase - floorN;
      const cooldownN = floorN + (rng() < extraChance ? 1 : 0);
      if (cooldownN <= 0) continue;
      const involvedLanes: LaneId[] = [sr.sourceLane, sr.targetLane];
      const cooldownEnd = Math.min(stepCount - 1, sr.startStep + cooldownN);
      for (let j = sr.startStep + 1; j <= cooldownEnd; j++) {
        const s = steps[j];
        if (s) {
          s.lanes = s.lanes.filter((l) => !involvedLanes.includes(l));
        }
      }
      // Drop any hold whose startStep falls in the cooldown on an involved lane.
      for (let k = holds.length - 1; k >= 0; k--) {
        const h = holds[k]!;
        if (involvedLanes.includes(h.lane) && h.startStep > sr.startStep && h.startStep <= cooldownEnd) {
          holds.splice(k, 1);
        }
      }
      // Drop any slide whose startStep falls in the cooldown on an involved lane.
      for (let k = slides.length - 1; k >= 0; k--) {
        const s = slides[k]!;
        if (involvedLanes.includes(s.sourceLane) && s.startStep > sr.startStep && s.startStep <= cooldownEnd) {
          slides.splice(k, 1);
        }
      }
    }
  }

  return {
    authorId,
    title,
    stepCount,
    bpm,
    vibe,
    steps,
    holds,
    slides,
    slideReturns,
    updatedAt: Date.now(),
  };
}

/** Pick `count` distinct lanes, biased away from the previous single-tap
 *  lane so the player isn't pinned to one column for long runs. For
 *  multi-lane chords we just shuffle and take a slice — the bias only
 *  matters for the single-tap case. */
function pickLanes(rng: () => number, count: number, avoid: LaneId | null): LaneId[] {
  const all: LaneId[] = [0, 1, 2];
  if (count >= 3) return all;
  if (count === 1) {
    const candidates = avoid === null ? all : all.filter((l) => l !== avoid);
    return [candidates[Math.floor(rng() * candidates.length)]!];
  }
  // count === 2: pick first lane biased away from previous, second is
  // any of the remaining two.
  const firstPool = avoid === null ? all : all.filter((l) => l !== avoid);
  const first = firstPool[Math.floor(rng() * firstPool.length)]!;
  const rest = all.filter((l) => l !== first);
  const second = rest[Math.floor(rng() * rest.length)]!;
  return [first, second];
}
