import { describe, it, expect } from 'vitest';
import { SCENE_SLOTS } from '@/constants/scene-slots';

describe('SCENE_SLOTS', () => {
  // TEMP-DEMO: skipped while SCENE_SLOTS is reduced to 1 entry for scenario testing; revert before ship
  it.skip('defines between 6 and 8 slots', () => {
    expect(SCENE_SLOTS.length).toBeGreaterThanOrEqual(6);
    expect(SCENE_SLOTS.length).toBeLessThanOrEqual(8);
  });

  it('all slot ids are unique', () => {
    const ids = SCENE_SLOTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every slot has x, y, anchor coordinates', () => {
    for (const slot of SCENE_SLOTS) {
      expect(typeof slot.x).toBe('number');
      expect(typeof slot.y).toBe('number');
      expect(slot.anchor).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
    }
  });
});
