import {
  BOX_CATALOG,
  CAT_CATALOG,
  COSMETIC_CATALOG,
  DECORATION_CATALOG,
  THEME_CATALOG,
  DUPLICATE_REFUND,
  type BoxId,
  type CatBreed,
  type CosmeticId,
  type DecorationId,
  type ThemeId,
  type PlayerState,
  type Rarity,
} from '../../shared/state';

export interface PullResult {
  kind: 'cat' | 'cosmetic' | 'decoration' | 'theme';
  itemId: CatBreed | CosmeticId | DecorationId | ThemeId;
  rarity: Rarity;
  /** True if the player already owned this item — refundCoins will be > 0. */
  duplicate: boolean;
  refundCoins: number;
}

const RARITIES = ['common', 'uncommon', 'rare', 'legendary'] as const;

function rollRarity(
  rates: Record<Rarity, number>,
  rng: () => number,
): Rarity {
  // Drop weights are integers in percent. Multiply by 100 to keep the
  // math whole; pick the first bucket whose cumulative weight covers the
  // roll.
  const roll = rng() * 100;
  let cumulative = 0;
  for (const r of RARITIES) {
    cumulative += rates[r];
    if (roll < cumulative) return r;
  }
  // Floating-point tail — fall back to the last non-zero rarity.
  for (let i = RARITIES.length - 1; i >= 0; i--) {
    if (rates[RARITIES[i]!] > 0) return RARITIES[i]!;
  }
  return 'common';
}

/**
 * Server-side box pull. Picks a rarity from the box's drop table, then
 * uniformly picks an item of that rarity from the relevant catalog. Marks
 * the result as a duplicate (with a refund) if the player already owns it.
 *
 * NOTE: this function does NOT mutate `state` or deduct the box cost —
 * the caller decides whether to apply the result via `applyPullToState`.
 */
export function pullBox(
  boxId: BoxId,
  state: PlayerState,
  rng: () => number = Math.random,
): PullResult {
  const box = BOX_CATALOG[boxId];
  const rarity = rollRarity(box.rates, rng);
  if (box.rewardKind === 'cat') {
    const pool = CAT_CATALOG.filter((c) => c.rarity === rarity);
    const pick = pool[Math.floor(rng() * pool.length)]!;
    const duplicate = state.ownedCats.includes(pick.id);
    return {
      kind: 'cat',
      itemId: pick.id,
      rarity,
      duplicate,
      refundCoins: duplicate ? DUPLICATE_REFUND : 0,
    };
  }
  if (box.rewardKind === 'cosmetic') {
    const pool = COSMETIC_CATALOG.filter((c) => c.rarity === rarity);
    const pick = pool[Math.floor(rng() * pool.length)]!;
    const duplicate = state.ownedCosmetics.includes(pick.id);
    return {
      kind: 'cosmetic',
      itemId: pick.id,
      rarity,
      duplicate,
      refundCoins: duplicate ? DUPLICATE_REFUND : 0,
    };
  }
  if (box.rewardKind === 'decoration') {
    const ownedDecorations = new Set(state.house.ownedDecorations);
    let decorPool = DECORATION_CATALOG.filter(
      (d) => d.rarity === rarity && !ownedDecorations.has(d.id),
    );
    if (decorPool.length === 0) {
      decorPool = DECORATION_CATALOG.filter((d) => !ownedDecorations.has(d.id));
    }
    if (decorPool.length === 0) {
      // Player owns the entire catalog — legitimate duplicate-refund.
      const fallbackPick = DECORATION_CATALOG[Math.floor(rng() * DECORATION_CATALOG.length)]!;
      return {
        kind: 'decoration',
        itemId: fallbackPick.id,
        rarity: fallbackPick.rarity,
        duplicate: true,
        refundCoins: DUPLICATE_REFUND,
      };
    }
    const decorPick = decorPool[Math.floor(rng() * decorPool.length)]!;
    return {
      kind: 'decoration',
      itemId: decorPick.id,
      rarity: decorPick.rarity,
      duplicate: false,
      refundCoins: 0,
    };
  }
  // theme
  const ownedThemes = new Set(state.house.ownedThemes);
  let themePool = THEME_CATALOG.filter(
    (t) => t.rarity === rarity && !ownedThemes.has(t.id),
  );
  if (themePool.length === 0) {
    themePool = THEME_CATALOG.filter((t) => !ownedThemes.has(t.id));
  }
  if (themePool.length === 0) {
    // Player owns the entire catalog — legitimate duplicate-refund.
    const fallbackPick = THEME_CATALOG[Math.floor(rng() * THEME_CATALOG.length)]!;
    return {
      kind: 'theme',
      itemId: fallbackPick.id,
      rarity: fallbackPick.rarity,
      duplicate: true,
      refundCoins: DUPLICATE_REFUND,
    };
  }
  const themePick = themePool[Math.floor(rng() * themePool.length)]!;
  return {
    kind: 'theme',
    itemId: themePick.id,
    rarity: themePick.rarity,
    duplicate: false,
    refundCoins: 0,
  };
}

/**
 * Apply a pull result to the player's state. New items go into the owned
 * list; duplicates instead credit `refundCoins` back to the wallet.
 */
export function applyPullToState(state: PlayerState, pull: PullResult): void {
  if (pull.duplicate) {
    state.coins += pull.refundCoins;
    return;
  }
  if (pull.kind === 'cat') {
    state.ownedCats.push(pull.itemId as CatBreed);
  } else if (pull.kind === 'cosmetic') {
    state.ownedCosmetics.push(pull.itemId as CosmeticId);
  } else if (pull.kind === 'decoration') {
    state.house.ownedDecorations.push(pull.itemId as DecorationId);
  } else {
    state.house.ownedThemes.push(pull.itemId as ThemeId);
  }
}
