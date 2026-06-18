import type { CatModel } from '@/types/game';

export class CatSelectionSystem {
  constructor(private readonly rng: () => number = Math.random) {}

  pickActive(pool: CatModel[]): CatModel {
    if (pool.length === 0) {
      throw new Error('CatSelectionSystem.pickActive: empty pool');
    }
    const index = Math.floor(this.rng() * pool.length);
    return pool[Math.min(index, pool.length - 1)]!;
  }
}
