import { describe, it, expect } from 'vitest';
import { pullBox, applyPullToState } from '../src/server/core/box-pull';
import {
  CAT_CATALOG,
  COSMETIC_CATALOG,
  DUPLICATE_REFUND,
  STARTER_COINS,
  BOX_CATALOG,
  type PlayerState,
} from '../src/shared/state';

function emptyState(): PlayerState {
  return {
    username: 'tester',
    coins: STARTER_COINS,
    ownedCats: [],
    ownedCosmetics: [],
    equippedCosmetics: {},
    bestScore: 0,
    onboardingDone: false,
    updatedAt: 0,
  };
}

/** Deterministic RNG that walks through a list of values then loops. */
function seqRng(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i % values.length]!;
    i++;
    return v;
  };
}

describe('box-pull', () => {
  it('Cat Crate returns a cat ID at one of the configured rarities', () => {
    const result = pullBox('catCrate', emptyState(), seqRng([0.0, 0.0]));
    expect(result.kind).toBe('cat');
    expect(CAT_CATALOG.map((c) => c.id)).toContain(result.itemId);
  });

  it('Style Pack returns a cosmetic ID', () => {
    const result = pullBox('stylePack', emptyState(), seqRng([0.0, 0.0]));
    expect(result.kind).toBe('cosmetic');
    expect(COSMETIC_CATALOG.map((c) => c.id)).toContain(result.itemId);
  });

  it('Cat Crate NEVER drops a legendary cat over many pulls', () => {
    let legendaryCount = 0;
    const rng = Math.random;
    for (let i = 0; i < 5000; i++) {
      const r = pullBox('catCrate', emptyState(), rng);
      if (r.rarity === 'legendary') legendaryCount++;
    }
    expect(legendaryCount).toBe(0);
  });

  it('Premium Cat Crate drops legendary at roughly 10% over many pulls', () => {
    let legendaryCount = 0;
    const N = 5000;
    for (let i = 0; i < N; i++) {
      const r = pullBox('premiumCatCrate', emptyState(), Math.random);
      if (r.rarity === 'legendary') legendaryCount++;
    }
    const rate = legendaryCount / N;
    expect(rate).toBeGreaterThan(0.07);
    expect(rate).toBeLessThan(0.13);
  });

  it('Premium Cat Crate never drops a common cat', () => {
    let commonCount = 0;
    for (let i = 0; i < 2000; i++) {
      const r = pullBox('premiumCatCrate', emptyState(), Math.random);
      if (r.rarity === 'common') commonCount++;
    }
    expect(commonCount).toBe(0);
  });

  it('a duplicate cat pull is flagged with a DUPLICATE_REFUND refund', () => {
    const state = emptyState();
    state.ownedCats = ['cat1', 'cat2', 'cat3'];
    // Force the common-tier branch with rng=0; pick is cat1 (first in pool).
    const result = pullBox('catCrate', state, seqRng([0.0, 0.0]));
    expect(result.duplicate).toBe(true);
    expect(result.refundCoins).toBe(DUPLICATE_REFUND);
  });

  it('a duplicate cosmetic pull is flagged with a refund too', () => {
    const state = emptyState();
    state.ownedCosmetics = ['c1'];
    const result = pullBox('stylePack', state, seqRng([0.0, 0.0]));
    expect(result.duplicate).toBe(true);
    expect(result.refundCoins).toBe(DUPLICATE_REFUND);
  });

  it('a non-duplicate pull has 0 refund', () => {
    const result = pullBox('catCrate', emptyState(), seqRng([0.0, 0.0]));
    expect(result.duplicate).toBe(false);
    expect(result.refundCoins).toBe(0);
  });

  it('applyPullToState adds new cats / cosmetics to the owned list', () => {
    const state = emptyState();
    applyPullToState(state, {
      kind: 'cat',
      itemId: 'cat4',
      rarity: 'uncommon',
      duplicate: false,
      refundCoins: 0,
    });
    expect(state.ownedCats).toContain('cat4');
  });

  it('applyPullToState refunds duplicate coins instead of adding the item', () => {
    const state = emptyState();
    state.ownedCats = ['cat1'];
    const startCoins = state.coins;
    applyPullToState(state, {
      kind: 'cat',
      itemId: 'cat1',
      rarity: 'common',
      duplicate: true,
      refundCoins: DUPLICATE_REFUND,
    });
    expect(state.coins).toBe(startCoins + DUPLICATE_REFUND);
    expect(state.ownedCats).toEqual(['cat1']); // unchanged
  });
});

describe('Phase 3 box catalog', () => {
  it('includes a Decor Crate at 50 coins for decorations', () => {
    const box = BOX_CATALOG.decorCrate;
    expect(box).toBeDefined();
    expect(box.cost).toBe(50);
    expect(box.rewardKind).toBe('decoration');
  });

  it('includes a Theme Pack at 50 coins for themes', () => {
    const box = BOX_CATALOG.themePack;
    expect(box).toBeDefined();
    expect(box.cost).toBe(50);
    expect(box.rewardKind).toBe('theme');
  });

  it('drop weights sum to 100 for new boxes', () => {
    for (const id of ['decorCrate', 'themePack'] as const) {
      const total = Object.values(BOX_CATALOG[id].rates).reduce((a, b) => a + b, 0);
      expect(total).toBe(100);
    }
  });
});
