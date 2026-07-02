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

  it('the legendary cats are Jade and Purps (2026-07-01 roster: rainbow deleted)', () => {
    const legendaries = CAT_CATALOG.filter((c) => c.rarity === 'legendary');
    expect(legendaries.map((c) => c.id).sort()).toEqual(['cat10', 'cat9']);
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

  it('catBox cannot drop legendary cats', () => {
    expect(BOX_CATALOG.catBox.rates.legendary).toBe(0);
  });

  it('cosmeticBox cannot drop legendary cosmetics', () => {
    expect(BOX_CATALOG.cosmeticBox.rates.legendary).toBe(0);
  });

  it('backgroundBox costs more than cosmeticBox', () => {
    expect(BOX_CATALOG.backgroundBox.price).toBeGreaterThan(BOX_CATALOG.cosmeticBox.price);
  });

  it('every cat / cosmetic id is unique within its catalog', () => {
    expect(new Set(CAT_CATALOG.map((c) => c.id)).size).toBe(CAT_CATALOG.length);
    expect(new Set(COSMETIC_CATALOG.map((c) => c.id)).size).toBe(COSMETIC_CATALOG.length);
  });

  it('for each rarity, cat/cosmetic boxes are internally consistent with their catalogs', () => {
    // If a box's rate > 0 for a given rarity, the corresponding catalog
    // must have at least one entry of that rarity — otherwise the pull
    // logic would have nothing to pick from.
    // Background boxes pull from BACKGROUND_CATALOG which has no rarity-based filtering,
    // so we skip that check for background boxes.
    for (const box of Object.values(BOX_CATALOG)) {
      if (box.rewardKind === 'background') continue;
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
