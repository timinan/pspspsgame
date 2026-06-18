import { describe, it, expect } from 'vitest';
import { CatSelectionSystem } from '@/systems/cat-selection-system';
import type { CatModel } from '@/types/game';

const cat = (id: string): CatModel => ({
  id,
  breed: 'cat1',
  animation: 'idle',
  x: 0,
  y: 0,
});

describe('CatSelectionSystem', () => {
  it('picks one of the provided cats', () => {
    const sel = new CatSelectionSystem(() => 0);
    const cats = [cat('a'), cat('b'), cat('c')];
    const picked = sel.pickActive(cats);
    expect(['a', 'b', 'c']).toContain(picked.id);
  });

  it('uses the rng to determine index', () => {
    const sel = new CatSelectionSystem(() => 0.5);
    const cats = [cat('a'), cat('b'), cat('c'), cat('d')];
    // floor(0.5 * 4) = 2 -> 'c'
    expect(sel.pickActive(cats).id).toBe('c');
  });

  it('clamps to last when rng returns 1', () => {
    // (Math.random() never returns 1, but defensive: floor(1 * 3) = 3, clamp to 2)
    const sel = new CatSelectionSystem(() => 0.9999999);
    const cats = [cat('a'), cat('b'), cat('c')];
    expect(sel.pickActive(cats).id).toBe('c');
  });

  it('throws if pool is empty', () => {
    const sel = new CatSelectionSystem(() => 0);
    expect(() => sel.pickActive([])).toThrow();
  });
});
