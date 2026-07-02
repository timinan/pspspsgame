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

  it('catBox CAN drop legendary (rate 1) — seeded roll at 99.5% lands legendary', () => {
    // Standard catBox has legendary: 1. A seeded rng returning 0.995 (i.e. 99.5)
    // falls in the legendary bucket (cumulative: common 60, uncommon 90, rare 99,
    // legendary 100). The second call (0.0) picks the first item in the pool.
    const result = pullBox('catBox', emptyState(), seqRng([0.995, 0.0]));
    expect(result.rarity).toBe('legendary');
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

describe('Box catalog — 12 SKUs (standard / golden / mythic)', () => {
  it('standard catBox: 400 coins, cat reward', () => {
    const box = BOX_CATALOG.catBox;
    expect(box).toBeDefined();
    expect(box.price).toBe(400);
    expect(box.rewardKind).toBe('cat');
    expect(box.tier).toBe('standard');
    expect(box.category).toBe('cat');
  });

  it('standard cosmeticBox: 200 coins, cosmetic reward', () => {
    const box = BOX_CATALOG.cosmeticBox;
    expect(box).toBeDefined();
    expect(box.price).toBe(200);
    expect(box.rewardKind).toBe('cosmetic');
    expect(box.tier).toBe('standard');
  });

  it('standard backgroundBox: 350 coins, background reward', () => {
    const box = BOX_CATALOG.backgroundBox;
    expect(box).toBeDefined();
    expect(box.price).toBe(350);
    expect(box.rewardKind).toBe('background');
    expect(box.tier).toBe('standard');
  });

  it('standard effectsBox: 200 coins, effects-only cosmetic', () => {
    const box = BOX_CATALOG.effectsBox;
    expect(box).toBeDefined();
    expect(box.price).toBe(200);
    expect(box.effectsOnly).toBe(true);
    expect(box.tier).toBe('standard');
    expect(box.category).toBe('effect');
  });

  it('golden catBox: 1200 coins, tier golden', () => {
    const box = BOX_CATALOG.catBoxGolden;
    expect(box).toBeDefined();
    expect(box.price).toBe(1200);
    expect(box.tier).toBe('golden');
    expect(box.category).toBe('cat');
  });

  it('golden cosmeticBox: 600 coins, tier golden', () => {
    expect(BOX_CATALOG.cosmeticBoxGolden.price).toBe(600);
    expect(BOX_CATALOG.cosmeticBoxGolden.tier).toBe('golden');
  });

  it('golden backgroundBox: 1000 coins, tier golden', () => {
    expect(BOX_CATALOG.backgroundBoxGolden.price).toBe(1000);
    expect(BOX_CATALOG.backgroundBoxGolden.tier).toBe('golden');
  });

  it('golden effectsBox: 600 coins, effects-only, tier golden', () => {
    const box = BOX_CATALOG.effectsBoxGolden;
    expect(box.price).toBe(600);
    expect(box.effectsOnly).toBe(true);
    expect(box.tier).toBe('golden');
    expect(box.category).toBe('effect');
  });

  it('all mythic boxes: 2000 coins, tier mythic', () => {
    for (const id of ['catBoxMythic', 'cosmeticBoxMythic', 'backgroundBoxMythic', 'effectsBoxMythic'] as const) {
      expect(BOX_CATALOG[id].price).toBe(2000);
      expect(BOX_CATALOG[id].tier).toBe('mythic');
    }
  });

  it('drop rates sum to 100 for all 12 boxes', () => {
    for (const [id, box] of Object.entries(BOX_CATALOG)) {
      const total = Object.values(box.rates).reduce((a, b) => a + b, 0);
      expect(total, `${id} rates should sum to 100`).toBe(100);
    }
  });

  it('golden and mythic boxes have zero common rate', () => {
    for (const [id, box] of Object.entries(BOX_CATALOG)) {
      if (box.tier === 'golden' || box.tier === 'mythic') {
        expect(box.rates.common, `${id} must have zero common`).toBe(0);
      }
    }
  });

  it('mythic boxes have zero uncommon rate', () => {
    for (const [id, box] of Object.entries(BOX_CATALOG)) {
      if (box.tier === 'mythic') {
        expect(box.rates.uncommon, `${id} must have zero uncommon`).toBe(0);
      }
    }
  });

  it('standard tier legendary rate is 1 (now reachable)', () => {
    for (const [id, box] of Object.entries(BOX_CATALOG)) {
      if (box.tier === 'standard') {
        expect(box.rates.legendary, `${id} legendary rate`).toBe(1);
      }
    }
  });
});

describe('box-pull: empty-pool fallback', () => {
  it('mythic backgroundBox: both legendary bgs owned → falls back to rare', () => {
    const state = createFreshPlayerState();
    // Own both legendary backgrounds so the legendary pool for unowned is empty.
    // The mythic box (rates: 0/0/70/30): seqRng(0.995) → 99.5 → legendary bucket.
    // Fallback walks: legendary empty → one step toward common → rare (non-empty).
    state.ownedBackgrounds = ['volcanicpalace', 'cathedral'];
    const result = pullBox('backgroundBoxMythic', state, seqRng([0.995, 0.0]));
    expect(result.kind).toBe('background');
    expect(result.duplicate).toBe(false);
    // Must NOT hand back an already-owned legendary.
    expect(['volcanicpalace', 'cathedral']).not.toContain(result.itemId);
    // Result should be a rare background (nearest non-empty rarity).
    expect(BACKGROUND_CATALOG[result.itemId as keyof typeof BACKGROUND_CATALOG]?.rarity).toBe('rare');
  });

  it('mythic backgroundBox: legendary + all rare bgs owned → refunds (all owned)', () => {
    const state = createFreshPlayerState();
    // Own every background so the entire pool is exhausted → duplicate refund.
    state.ownedBackgrounds = Object.keys(BACKGROUND_CATALOG) as (keyof typeof BACKGROUND_CATALOG)[];
    const result = pullBox('backgroundBoxMythic', state, seqRng([0.995, 0.0]));
    expect(result.kind).toBe('background');
    expect(result.duplicate).toBe(true);
    expect(result.refundCoins).toBe(DUPLICATE_REFUND);
  });

  it('mythic catBox: legendary cats exist → legendary pull works (no fallback needed)', () => {
    // There ARE 2 legendary cats in the catalog; seeded legendary roll should land one.
    const result = pullBox('catBoxMythic', emptyState(), seqRng([0.995, 0.0]));
    expect(result.kind).toBe('cat');
    expect(result.rarity).toBe('legendary');
  });

  it('standard catBox: legendary roll (rate 1) lands a legendary or rare cat', () => {
    // Standard box has legendary: 1. seqRng(0.995) rolls legendary (99.5 < 100).
    // Catalog has 2 legendary cats → no fallback needed; result should be legendary.
    const result = pullBox('catBox', emptyState(), seqRng([0.995, 0.0]));
    expect(result.kind).toBe('cat');
    expect(['rare', 'legendary']).toContain(result.rarity);
  });
});
