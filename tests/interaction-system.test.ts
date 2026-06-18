import { describe, it, expect } from 'vitest';
import { InteractionSystem } from '@/systems/interaction-system';

describe('InteractionSystem', () => {
  it('returns success when rng < success chance', () => {
    const i = new InteractionSystem(() => 0.5);
    expect(i.resolve('pet').outcome).toBe('success'); // 0.5 < 0.7
  });

  it('returns fail when rng >= success chance', () => {
    const i = new InteractionSystem(() => 0.8);
    expect(i.resolve('pet').outcome).toBe('fail'); // 0.8 >= 0.7
  });

  it('uses the right chance per interaction type', () => {
    const i = new InteractionSystem(() => 0.2);
    expect(i.resolve('pet').outcome).toBe('success'); // 0.2 < 0.7
    expect(i.resolve('chinScratch').outcome).toBe('success'); // 0.2 < 0.3
    expect(i.resolve('bellyRub').outcome).toBe('fail'); // 0.2 >= 0.15
  });

  it('exposes the displayed chance', () => {
    expect(InteractionSystem.chanceFor('pet')).toBe(0.7);
    expect(InteractionSystem.chanceFor('chinScratch')).toBe(0.3);
    expect(InteractionSystem.chanceFor('bellyRub')).toBe(0.15);
  });

  it('awards coins on success but not on fail', () => {
    const success = new InteractionSystem(() => 0).resolve('pet');
    const fail = new InteractionSystem(() => 0.99).resolve('pet');
    expect(success.coinsAwarded).toBeGreaterThan(0);
    expect(fail.coinsAwarded).toBe(0);
  });
});
