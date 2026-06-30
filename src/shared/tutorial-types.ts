/**
 * Tutorial state machine — shared between client (TutorialOrchestrator
 * scene) and server (PlayerState.tutorialStep field). The order in
 * TUTORIAL_STEP_ORDER is the canonical advance sequence.
 *
 * Resume on tab-reopen: the server stores `playerState.tutorialStep`;
 * Preloader reads it and routes back into TutorialOrchestrator with
 * `resumeAt: <step>`. The orchestrator starts at that step.
 *
 * Skip after pickers: covered by the orchestrator itself, not by this
 * state machine — skipping flips `onboardingDone: true` + clears the
 * step pointer + routes per `originalPostId`.
 */

import type { BackgroundId, CatBreed } from './state';

export type TutorialStepId =
  | 'intro'
  | 'pick-stage'
  | 'pick-cat'
  | 'merch-intro'
  | 'box-cosmetic'
  | 'box-effect'
  | 'merch-reveal'
  | 'stage-set-confirm'
  | 'rehearsal-intro'
  | 'play-tutorial-intro'
  | 'play-tutorial'
  | 'editor-tour-intro'
  | 'editor-tour'
  | 'visit-pointer'
  | 'route-a-outro'
  | 'route-b-outro';

export const TUTORIAL_STEP_ORDER: readonly TutorialStepId[] = [
  'intro',
  'pick-stage',
  'pick-cat',
  'merch-intro',
  'box-cosmetic',
  'box-effect',
  'merch-reveal',
  'stage-set-confirm',
  'rehearsal-intro',
  'play-tutorial-intro',
  'play-tutorial',
  'editor-tour-intro',
  'editor-tour',
  'visit-pointer',
  'route-a-outro',
  'route-b-outro',
] as const;

/** Steps that terminate the tutorial — they're the only valid exits
 *  for completeTutorial(). Both route outros sit here because the
 *  orchestrator branches at editor-tour on `originalPostId`:
 *  - Route A (no originalPostId): editor-tour → visit-pointer → route-a-outro → exit
 *  - Route B (originalPostId set): editor-tour → route-b-outro → exit
 *  The linear nextTutorialStep returns 'complete' for both so the
 *  orchestrator's advance handler knows to call completeTutorial. */
const TERMINAL_STEPS = new Set<TutorialStepId>(['route-a-outro', 'route-b-outro']);

/** Pure: returns the next step in the canonical order, or 'complete'
 *  when the tutorial has finished. The orchestrator OVERRIDES this at
 *  the editor-tour branch — instead of calling nextTutorialStep, it
 *  routes to 'visit-pointer' (Route A) or 'route-b-outro' (Route B)
 *  based on originalPostId. nextTutorialStep handles every other step
 *  linearly. */
export function nextTutorialStep(current: TutorialStepId): TutorialStepId | 'complete' {
  if (TERMINAL_STEPS.has(current)) return 'complete';
  const idx = TUTORIAL_STEP_ORDER.indexOf(current);
  if (idx < 0 || idx === TUTORIAL_STEP_ORDER.length - 1) return 'complete';
  return TUTORIAL_STEP_ORDER[idx + 1]!;
}

/** Curated starter picks shown by the orchestrator's pickers. Other
 *  bgs/cats are not "lost" — they're earned later via Background Box
 *  or future cat-hire flows. */
export const STARTER_STAGES: BackgroundId[] = [
  'stage',
  'cozy-meowcert-stage',
  'c4a2f861-9ba9-4733-8e6d-a1c9b17',
];
export const STARTER_CATS: CatBreed[] = [
  'cat1',
  'cat2',
  'cat3',
];
