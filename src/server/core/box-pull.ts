import {
  BOX_CATALOG,
  CAT_CATALOG,
  COSMETIC_CATALOG,
  DUPLICATE_REFUND,
  type BoxId,
  type CatBreed,
  type CosmeticId,
  type PlayerState,
  type Rarity,
} from '../../shared/state';

export interface PullResult {
  kind: 'cat' | 'cosmetic';
  itemId: CatBreed | CosmeticId;
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
  } else {
    state.ownedCosmetics.push(pull.itemId as CosmeticId);
  }
}
