import { describe, it, expect } from 'vitest';
import { SCENE_SEATS } from '@/constants/scene-slots';

describe('SCENE_SEATS', () => {
  it('defines exactly 3 seats', () => {
    expect(SCENE_SEATS.length).toBe(3);
  });

  it('all seat ids are unique', () => {
    const ids = SCENE_SEATS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('seat ids include left, center, right', () => {
    const ids = SCENE_SEATS.map((s) => s.id);
    expect(ids).toContain('seat-left');
    expect(ids).toContain('seat-center');
    expect(ids).toContain('seat-right');
  });

  it('every seat has x, y, anchor', () => {
    for (const seat of SCENE_SEATS) {
      expect(typeof seat.x).toBe('number');
      expect(typeof seat.y).toBe('number');
      expect(seat.anchor).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
    }
  });
});
