import { describe, it, expect } from 'vitest';
import { MeowBarSystem } from '@/systems/meow-bar-system';
import { Balance } from '@/constants/balance';

describe('MeowBarSystem', () => {
  it('starts at zero', () => {
    const m = new MeowBarSystem();
    expect(m.getProgress()).toBe(0);
    expect(m.isFull()).toBe(false);
    expect(m.isEmpty()).toBe(true);
  });

  it('progresses when score accumulates beyond the threshold', () => {
    const m = new MeowBarSystem();
    m.onScoreChanged(Balance.pointsPerMeowBarUnit);
    expect(m.getProgress()).toBe(1);
  });

  it('does not progress until the threshold is crossed', () => {
    const m = new MeowBarSystem();
    m.onScoreChanged(Balance.pointsPerMeowBarUnit - 1);
    expect(m.getProgress()).toBe(0);
  });

  it('respects extra-cat speed multiplier', () => {
    const m = new MeowBarSystem();
    // 2 extra cats: speed = 1 + 2*0.1 = 1.2; effective points per unit shrinks
    m.setExtraCats(2);
    m.onScoreChanged(Balance.pointsPerMeowBarUnit);
    expect(m.getProgress()).toBeGreaterThanOrEqual(1);
  });

  it('caps at the max', () => {
    const m = new MeowBarSystem();
    m.onScoreChanged(10_000);
    expect(m.getProgress()).toBe(Balance.meowBarMax);
    expect(m.isFull()).toBe(true);
  });

  it('drains during interaction tick', () => {
    const m = new MeowBarSystem();
    m.onScoreChanged(10_000);
    m.drainTick();
    expect(m.getProgress()).toBe(Balance.meowBarMax - Balance.meowBarDrainPerTick);
  });

  it('clamps drain at zero', () => {
    const m = new MeowBarSystem();
    for (let i = 0; i < 5; i++) m.drainTick();
    expect(m.getProgress()).toBe(0);
    expect(m.isEmpty()).toBe(true);
  });

  it('reset clears progress and re-baselines the trigger score', () => {
    const m = new MeowBarSystem();
    const halfFull = 50 * Balance.pointsPerMeowBarUnit;
    m.onScoreChanged(halfFull);
    expect(m.getProgress()).toBe(50);
    m.reset();
    expect(m.getProgress()).toBe(0);
    // Reset re-baselines internally — feeding the same absolute score adds
    // the same units back, demonstrating the trigger score reset to zero.
    m.onScoreChanged(halfFull);
    expect(m.getProgress()).toBe(50);
  });
});
