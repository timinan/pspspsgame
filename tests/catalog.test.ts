import { describe, it, expect } from 'vitest';
import {
  BOX_CATALOG,
  CAT_CATALOG,
  COSMETIC_CATALOG,
} from '@/../shared/state';
import type { Rarity } from '@/../shared/state';

describe('shared catalog', () => {
  it('every box drop-rate row sums to 100', () => {
    for (const box of Object.values(BOX_CATALOG)) {
      const sum =
        box.rates.common +
        box.rates.uncommon +
        box.rates.rare +
        box.rates.legendary;
      expect(sum, `${box.id} rates`).toBe(100);
    }
  });

  it('exactly one legendary cat exists and it is rainbow', () => {
    const legendaries = CAT_CATALOG.filter((c) => c.rarity === 'legendary');
    expect(legendaries).toHaveLength(1);
    expect(legendaries[0]!.id).toBe('rainbow');
  });

  it('every cat rarity above legendary has at least one entry', () => {
    for (const r of ['common', 'uncommon', 'rare'] as const) {
      expect(CAT_CATALOG.filter((c) => c.rarity === r).length).toBeGreaterThan(0);
    }
  });

  it('cosmetic catalog ids are unique', () => {
    const ids = COSMETIC_CATALOG.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every cosmetic rarity has at least one entry', () => {
    for (const r of ['common', 'uncommon', 'rare', 'legendary'] as const) {
      expect(COSMETIC_CATALOG.filter((c) => c.rarity === r).length).toBeGreaterThan(0);
    }
  });

  it('Cat Crate cannot drop legendary; Premium Cat Crate can', () => {
    expect(BOX_CATALOG.catCrate.rates.legendary).toBe(0);
    expect(BOX_CATALOG.premiumCatCrate.rates.legendary).toBeGreaterThan(0);
  });

  it('Style Pack cannot drop legendary; Premium Style Pack can', () => {
    expect(BOX_CATALOG.stylePack.rates.legendary).toBe(0);
    expect(BOX_CATALOG.premiumStylePack.rates.legendary).toBeGreaterThan(0);
  });

  it('premium boxes cost strictly more than their basic counterparts', () => {
    expect(BOX_CATALOG.premiumCatCrate.cost).toBeGreaterThan(BOX_CATALOG.catCrate.cost);
    expect(BOX_CATALOG.premiumStylePack.cost).toBeGreaterThan(BOX_CATALOG.stylePack.cost);
  });

  it('every cat / cosmetic id is unique within its catalog', () => {
    expect(new Set(CAT_CATALOG.map((c) => c.id)).size).toBe(CAT_CATALOG.length);
    expect(new Set(COSMETIC_CATALOG.map((c) => c.id)).size).toBe(COSMETIC_CATALOG.length);
  });

  it('for each rarity, all four boxes plus the catalogs are internally consistent', () => {
    // If a box's rate > 0 for a given rarity, the corresponding catalog
    // must have at least one entry of that rarity — otherwise the pull
    // logic would have nothing to pick from.
    for (const box of Object.values(BOX_CATALOG)) {
      const catalog = box.rewardKind === 'cat' ? CAT_CATALOG : COSMETIC_CATALOG;
      for (const r of ['common', 'uncommon', 'rare', 'legendary'] as Rarity[]) {
        if (box.rates[r] > 0) {
          expect(
            catalog.some((e) => e.rarity === r),
            `${box.id} drops ${r} but the ${box.rewardKind} catalog has no ${r} entries`,
          ).toBe(true);
        }
      }
    }
  });
});
