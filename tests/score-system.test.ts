import { describe, it, expect } from 'vitest';
import { ScoreSystem } from '@/systems/score-system';

describe('ScoreSystem', () => {
  it('starts at zero', () => {
    const s = new ScoreSystem();
    expect(s.get()).toBe(0);
  });

  it('adds points', () => {
    const s = new ScoreSystem();
    s.add(10);
    expect(s.get()).toBe(10);
    s.add(5);
    expect(s.get()).toBe(15);
  });

  it('floors fractional points', () => {
    const s = new ScoreSystem();
    s.add(10.7);
    expect(s.get()).toBe(10);
  });

  it('resets to zero', () => {
    const s = new ScoreSystem();
    s.add(42);
    s.reset();
    expect(s.get()).toBe(0);
  });
});
