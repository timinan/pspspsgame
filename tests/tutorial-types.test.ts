import { describe, expect, it } from 'vitest';
import {
  nextTutorialStep,
  TUTORIAL_STEP_ORDER,
  STARTER_STAGES,
  STARTER_CATS,
  type TutorialStepId,
} from '../src/shared/tutorial-types';

describe('nextTutorialStep', () => {
  it('intro → pick-stage', () => {
    expect(nextTutorialStep('intro')).toBe('pick-stage');
  });

  it('pick-stage → pick-cat', () => {
    expect(nextTutorialStep('pick-stage')).toBe('pick-cat');
  });

  it('pick-cat → merch-intro', () => {
    expect(nextTutorialStep('pick-cat')).toBe('merch-intro');
  });

  it('box-effect → dressing-walkthrough', () => {
    expect(nextTutorialStep('box-effect')).toBe('dressing-walkthrough');
  });

  it('route-a-outro → complete', () => {
    expect(nextTutorialStep('route-a-outro')).toBe('complete');
  });

  it('route-b-outro → complete', () => {
    expect(nextTutorialStep('route-b-outro')).toBe('complete');
  });

  it('unknown step → complete (defensive)', () => {
    expect(nextTutorialStep('not-a-step' as TutorialStepId)).toBe('complete');
  });
});

describe('TUTORIAL_STEP_ORDER', () => {
  it('contains exactly 14 steps', () => {
    expect(TUTORIAL_STEP_ORDER.length).toBe(14);
  });

  it('starts with intro', () => {
    expect(TUTORIAL_STEP_ORDER[0]).toBe('intro');
  });

  it('ends with route-b-outro (linear order; orchestrator branches at editor-tour)', () => {
    expect(TUTORIAL_STEP_ORDER[TUTORIAL_STEP_ORDER.length - 1]).toBe('route-b-outro');
  });

  it('has no duplicates', () => {
    const set = new Set(TUTORIAL_STEP_ORDER);
    expect(set.size).toBe(TUTORIAL_STEP_ORDER.length);
  });
});

describe('STARTER_STAGES + STARTER_CATS', () => {
  it('exactly 3 starter stages', () => {
    expect(STARTER_STAGES.length).toBe(3);
  });

  it('exactly 3 starter cats', () => {
    expect(STARTER_CATS.length).toBe(3);
  });

  it('cat starters use common-rarity ids', () => {
    // cat1, cat2, cat3 are the common-rarity starters in
    // cats-catalog.generated.ts (Mochi, Biscuit, Pebble).
    expect(STARTER_CATS).toEqual(['cat1', 'cat2', 'cat3']);
  });
});
