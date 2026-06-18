import { describe, it, expect } from 'vitest';
import { RhythmSystem } from '@/systems/rhythm-system';
import { Balance } from '@/constants/balance';

describe('RhythmSystem (pspsps track)', () => {
  it('starts with no elements on the track', () => {
    const r = new RhythmSystem(() => 0.5);
    expect(r.getElements()).toHaveLength(0);
  });

  it('spawns an element after the spawn delay passes', () => {
    const r = new RhythmSystem(() => 0.5);
    for (let i = 0; i < Balance.pspspsBaseSpawnDelayTicks + 5; i++) {
      r.tick();
    }
    expect(r.getElements().length).toBeGreaterThanOrEqual(1);
  });

  it('moving elements drift to the right', () => {
    const r = new RhythmSystem(() => 0.5);
    // Force a spawn
    for (let i = 0; i <= Balance.pspspsBaseSpawnDelayTicks; i++) r.tick();
    const firstFraction = r.getElements()[0]!.fraction;
    r.tick();
    expect(r.getElements()[0]!.fraction).toBeGreaterThan(firstFraction);
  });

  it('caps the number of elements on the track', () => {
    const r = new RhythmSystem(() => 0.5);
    // Tick many times — enough to spawn more than the cap if uncapped
    for (let i = 0; i < Balance.pspspsBaseSpawnDelayTicks * (Balance.pspspsMaxElements + 5); i++) {
      r.tick();
    }
    expect(r.getElements().length).toBeLessThanOrEqual(Balance.pspspsMaxElements);
  });

  it('wraps elements that pass the right edge back to the left', () => {
    const r = new RhythmSystem(() => 0.5);
    // Spawn one
    for (let i = 0; i <= Balance.pspspsBaseSpawnDelayTicks; i++) r.tick();
    const el = r.getElements()[0]!;
    // Force it past the right edge
    el.fraction = 1.5;
    r.tick();
    expect(r.getElements()[0]!.fraction).toBe(Balance.pspspsSpawnXFraction);
  });

  it('a tap with no elements near the target awards nothing', () => {
    const r = new RhythmSystem(() => 0.5);
    expect(r.tap().pointsAwarded).toBe(0);
  });

  it('a tap on an element inside the perfect margin awards perfect points and consumes it', () => {
    const r = new RhythmSystem(() => 0.5);
    for (let i = 0; i <= Balance.pspspsBaseSpawnDelayTicks; i++) r.tick();
    const el = r.getElements()[0]!;
    el.fraction = r.getTargetFraction(); // exactly on target
    const result = r.tap();
    expect(result.perfectHits).toBe(1);
    expect(result.pointsAwarded).toBe(Balance.pspspsPerfectPoints);
    expect(r.getElements()).toHaveLength(0);
  });

  it('a tap on an element inside the partial margin (but outside perfect) awards partial points', () => {
    const r = new RhythmSystem(() => 0.5);
    for (let i = 0; i <= Balance.pspspsBaseSpawnDelayTicks; i++) r.tick();
    const el = r.getElements()[0]!;
    // Place it just outside the perfect margin but inside the partial margin
    el.fraction =
      r.getTargetFraction() + Balance.pspspsPerfectMarginFraction + 0.01;
    const result = r.tap();
    expect(result.partialHits).toBe(1);
    expect(result.pointsAwarded).toBe(Balance.pspspsPartialPoints);
  });

  it('a tap consumes multiple overlapping elements at once', () => {
    const r = new RhythmSystem(() => 0.5);
    // Tick enough times to guarantee at least 3 spawns
    for (let i = 0; i < Balance.pspspsBaseSpawnDelayTicks * 5; i++) r.tick();
    expect(r.getElements().length).toBeGreaterThanOrEqual(3);

    // Stack three of them on the target
    for (const el of r.getElements().slice(0, 3)) {
      (el as { fraction: number }).fraction = r.getTargetFraction();
    }
    const before = r.getElements().length;
    const result = r.tap();
    expect(result.perfectHits + result.partialHits).toBeGreaterThanOrEqual(3);
    expect(r.getElements().length).toBe(before - (result.perfectHits + result.partialHits));
  });
});
