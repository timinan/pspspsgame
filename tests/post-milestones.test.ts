// tests/post-milestones.test.ts
import { describe, expect, it } from 'vitest';
import { milestonesEarned } from '../src/shared/post-milestones';

describe('milestonesEarned', () => {
  it('crossing 1 play earns firstPlay coins and label', () => {
    const result = milestonesEarned(0, 1, false);
    expect(result.coins).toBe(50);
    expect(result.labels).toContain('first play');
  });

  it('firstPass=true earns firstPass coins and label', () => {
    const result = milestonesEarned(5, 6, true);
    expect(result.coins).toBe(100);
    expect(result.labels).toContain('first pass');
  });

  it('crossing 10 plays earns 100 coins and "10 plays" label', () => {
    const result = milestonesEarned(9, 10, false);
    expect(result.coins).toBe(100);
    expect(result.labels).toContain('10 plays');
  });

  it('crossing 50 plays earns 250 coins and "50 plays" label', () => {
    const result = milestonesEarned(49, 50, false);
    expect(result.coins).toBe(250);
    expect(result.labels).toContain('50 plays');
  });

  it('crossing 100 plays earns 500 coins and "100 plays" label', () => {
    const result = milestonesEarned(99, 100, false);
    expect(result.coins).toBe(500);
    expect(result.labels).toContain('100 plays');
  });

  it('multi-threshold: prev=9, new=10, firstPass=true → 200 coins, no firstPlay', () => {
    const result = milestonesEarned(9, 10, true);
    expect(result.coins).toBe(200); // 100 (10-plays) + 100 (first pass)
    expect(result.labels).not.toContain('first play');
    expect(result.labels).toContain('10 plays');
    expect(result.labels).toContain('first pass');
  });

  it('no double-pay: prevPlays >= threshold does not earn coins again', () => {
    const result = milestonesEarned(10, 11, false);
    expect(result.coins).toBe(0);
    expect(result.labels).not.toContain('10 plays');
  });

  it('zero case: no thresholds crossed, no firstPass → { coins: 0, labels: [] }', () => {
    const result = milestonesEarned(5, 6, false);
    expect(result.coins).toBe(0);
    expect(result.labels).toHaveLength(0);
  });
});
