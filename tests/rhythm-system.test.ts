import { describe, it, expect } from 'vitest';
import { RhythmSystem } from '@/systems/rhythm-system';
import { Balance } from '@/constants/balance';

describe('RhythmSystem', () => {
  it('classifies a tap exactly on a beat as perfect', () => {
    const r = new RhythmSystem(0);
    const result = r.tap(0);
    expect(result.kind).toBe('perfect');
    expect(result.pointsAwarded).toBe(Balance.rhythmPerfectPoints);
  });

  it('classifies a tap within hit window as hit', () => {
    const r = new RhythmSystem(0);
    const result = r.tap(Balance.rhythmPerfectWindowMs + 10);
    expect(result.kind).toBe('hit');
    expect(result.pointsAwarded).toBe(Balance.rhythmHitPoints);
  });

  it('classifies a far-off tap as miss', () => {
    const r = new RhythmSystem(0);
    const result = r.tap(Balance.rhythmTapWindowMs + 100);
    expect(result.kind).toBe('miss');
    expect(result.pointsAwarded).toBe(0);
  });

  it('snaps to the nearest beat across multiple beats', () => {
    const r = new RhythmSystem(0);
    // Beat 2 lands at 2000ms when rhythmIntervalMs = 1000
    const result = r.tap(2 * Balance.rhythmIntervalMs);
    expect(result.kind).toBe('perfect');
  });

  it('reports current beat index', () => {
    const r = new RhythmSystem(0);
    expect(r.beatIndexAt(0)).toBe(0);
    expect(r.beatIndexAt(Balance.rhythmIntervalMs)).toBe(1);
    expect(r.beatIndexAt(Balance.rhythmIntervalMs * 2.4)).toBe(2);
  });

  it('reports beat progress in [0, 1)', () => {
    const r = new RhythmSystem(0);
    expect(r.beatProgressAt(0)).toBe(0);
    expect(r.beatProgressAt(Balance.rhythmIntervalMs / 2)).toBeCloseTo(0.5);
    expect(r.beatProgressAt(Balance.rhythmIntervalMs)).toBe(0);
  });
});
