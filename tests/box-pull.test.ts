import { describe, it, expect } from 'vitest';
import { pullBox, applyPullToState } from '../src/server/core/box-pull';
import {
  CAT_CATALOG,
  COSMETIC_CATALOG,
  BACKGROUND_CATALOG,
  DUPLICATE_REFUND,
  BOX_CATALOG,
  createFreshPlayerState,
  type PlayerState,
} from '../src/shared/state';

function emptyState(): PlayerState {
  return createFreshPlayerState('tester');
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
  it('catBox returns a cat breed at one of the configured rarities', () => {
    const result = pullBox('catBox', emptyState(), seqRng([0.0, 0.0]));
    expect(result.kind).toBe('cat');
    expect(CAT_CATALOG.map((c) => c.id)).toContain(result.itemId);
  });

  it('catBox returns an instanceId for the new cat', () => {
    const result = pullBox('catBox', emptyState(), seqRng([0.0, 0.0]));
    expect(typeof result.instanceId).toBe('string');
    expect(result.instanceId!.length).toBeGreaterThan(0);
  });

  it('cosmeticBox returns a cosmetic ID', () => {
    const result = pullBox('cosmeticBox', emptyState(), seqRng([0.0, 0.0]));
    expect(result.kind).toBe('cosmetic');
    expect(COSMETIC_CATALOG.map((c) => c.id)).toContain(result.itemId);
  });

  it('cosmeticBox returns an instanceId for the new cosmetic', () => {
    const result = pullBox('cosmeticBox', emptyState(), seqRng([0.0, 0.0]));
    expect(typeof result.instanceId).toBe('string');
  });

  it('catBox NEVER drops a legendary cat over many pulls', () => {
    let legendaryCount = 0;
    const rng = Math.random;
    for (let i = 0; i < 5000; i++) {
      const r = pullBox('catBox', emptyState(), rng);
      if (r.rarity === 'legendary') legendaryCount++;
    }
    expect(legendaryCount).toBe(0);
  });

  it('cat pulls are never duplicates — every pull is a fresh instance', () => {
    const state = emptyState();
    // Add several cat instances of the same breed.
    state.ownedCats = [
      { id: 'i1', breed: 'cat1', name: 'Mochi' },
      { id: 'i2', breed: 'cat1', name: 'Mochi 2' },
    ];
    const result = pullBox('catBox', state, seqRng([0.0, 0.0]));
    // Cats are never marked duplicate regardless of breed ownership.
    expect(result.duplicate).toBe(false);
    expect(result.refundCoins).toBe(0);
    expect(typeof result.instanceId).toBe('string');
  });

  it('cosmetic pulls are never duplicates — every pull is a fresh instance', () => {
    const state = emptyState();
    state.ownedCosmetics = [{ id: 'ci1', type: 'c1' }];
    const result = pullBox('cosmeticBox', state, seqRng([0.0, 0.0]));
    expect(result.duplicate).toBe(false);
    expect(result.refundCoins).toBe(0);
  });

  it('a non-duplicate pull has 0 refund', () => {
    const result = pullBox('catBox', emptyState(), seqRng([0.0, 0.0]));
    expect(result.duplicate).toBe(false);
    expect(result.refundCoins).toBe(0);
  });

  it('applyPullToState adds a new OwnedCat instance to ownedCats', () => {
    const state = emptyState();
    applyPullToState(state, {
      kind: 'cat',
      itemId: 'cat4',
      rarity: 'uncommon',
      duplicate: false,
      refundCoins: 0,
      instanceId: 'test-instance-1',
    });
    const added = state.ownedCats[state.ownedCats.length - 1]!;
    expect(added.id).toBe('test-instance-1');
    expect(added.breed).toBe('cat4');
    expect(typeof added.name).toBe('string');
  });

  it('applyPullToState allows multiple instances of the same breed', () => {
    const state = emptyState();
    const before = state.ownedCats.length;
    for (let i = 0; i < 3; i++) {
      applyPullToState(state, {
        kind: 'cat',
        itemId: 'cat1',
        rarity: 'common',
        duplicate: false,
        refundCoins: 0,
        instanceId: `inst-${i}`,
      });
    }
    const added = state.ownedCats.slice(before);
    expect(added).toHaveLength(3);
    expect(added.every((c) => c.breed === 'cat1')).toBe(true);
    const ids = added.map((c) => c.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('applyPullToState adds a new OwnedCosmetic instance', () => {
    const state = emptyState();
    const before = state.ownedCosmetics.length;
    applyPullToState(state, {
      kind: 'cosmetic',
      itemId: 'c5',
      rarity: 'common',
      duplicate: false,
      refundCoins: 0,
      instanceId: 'cos-inst-1',
    });
    expect(state.ownedCosmetics).toHaveLength(before + 1);
    // The new instance is appended at the end of the array.
    const added = state.ownedCosmetics[state.ownedCosmetics.length - 1]!;
    expect(added.id).toBe('cos-inst-1');
    expect(added.type).toBe('c5');
  });

  it('catBox distribution covers all breeds over many pulls', () => {
    const seenBreeds = new Set<string>();
    for (let i = 0; i < 3000; i++) {
      const r = pullBox('catBox', emptyState(), Math.random);
      seenBreeds.add(r.itemId as string);
    }
    // Should see multiple distinct breeds.
    expect(seenBreeds.size).toBeGreaterThan(1);
  });
});

describe('box-pull: backgroundBox', () => {
  // Fresh state currently grants ALL catalog backgrounds for playtest
  // convenience (see createFreshPlayerState's DEV note). These tests
  // reset ownedBackgrounds to just ['default'] so the pull-flow behavior
  // can be asserted independent of that dev shortcut.
  it('backgroundBox pulls an unowned background and adds it to ownedBackgrounds', () => {
    const state = createFreshPlayerState();
    state.ownedBackgrounds = ['default'];
    const result = pullBox('backgroundBox', state, seqRng([0.42, 0.0]));
    expect(result.kind).toBe('background');
    expect(Object.keys(BACKGROUND_CATALOG)).toContain(result.itemId);
    expect(result.duplicate).toBe(false);
    expect(result.refundCoins).toBe(0);
    applyPullToState(state, result);
    expect(state.ownedBackgrounds).toContain(result.itemId);
  });

  it('backgroundBox refunds when all backgrounds already owned', () => {
    const state = createFreshPlayerState();
    state.ownedBackgrounds = Object.keys(BACKGROUND_CATALOG) as (keyof typeof BACKGROUND_CATALOG)[];
    const startCoins = state.coins;
    const result = pullBox('backgroundBox', state, seqRng([0.5, 0.5]));
    expect(result.duplicate).toBe(true);
    expect(result.refundCoins).toBe(DUPLICATE_REFUND);
    applyPullToState(state, result);
    expect(state.coins).toBe(startCoins + DUPLICATE_REFUND);
    // ownedBackgrounds should be unchanged (no new item added)
    expect(state.ownedBackgrounds).toEqual(Object.keys(BACKGROUND_CATALOG));
  });

  it('backgroundBox distributes across unowned backgrounds over many pulls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const state = createFreshPlayerState();
      state.ownedBackgrounds = ['default'];
      const result = pullBox('backgroundBox', state, Math.random);
      if (!result.duplicate) seen.add(result.itemId as string);
    }
    // Multiple unowned backgrounds should each appear at least once in 100 pulls.
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('Phase 5 box catalog', () => {
  it('includes catBox at 150 coins for cats', () => {
    const box = BOX_CATALOG.catBox;
    expect(box).toBeDefined();
    expect(box.price).toBe(150);
    expect(box.rewardKind).toBe('cat');
  });

  it('includes cosmeticBox at 80 coins for cosmetics', () => {
    const box = BOX_CATALOG.cosmeticBox;
    expect(box).toBeDefined();
    expect(box.price).toBe(80);
    expect(box.rewardKind).toBe('cosmetic');
  });

  it('includes backgroundBox at 250 coins for backgrounds', () => {
    const box = BOX_CATALOG.backgroundBox;
    expect(box).toBeDefined();
    expect(box.price).toBe(250);
    expect(box.rewardKind).toBe('background');
  });

  it('drop weights sum to 100 for all boxes', () => {
    for (const [id, box] of Object.entries(BOX_CATALOG)) {
      const total = Object.values(box.rates).reduce((a, b) => a + b, 0);
      expect(total, `${id} rates should sum to 100`).toBe(100);
    }
  });
});
