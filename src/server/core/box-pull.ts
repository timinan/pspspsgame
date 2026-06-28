import {
  BOX_CATALOG,
  CAT_CATALOG,
  COSMETIC_CATALOG,
  EFFECT_COSMETIC_CATALOG,
  BACKGROUND_CATALOG,
  DUPLICATE_REFUND,
  makeInstanceId,
  type BoxId,
  type CatBreed,
  type CosmeticId,
  type BackgroundId,
  type PlayerState,
  type Rarity,
} from '../../shared/state';

export interface PullResult {
  kind: 'cat' | 'cosmetic' | 'background';
  /** For cats: the breed id. For cosmetics: the catalog cosmetic id. For backgrounds: the background id. */
  itemId: CatBreed | CosmeticId | BackgroundId;
  rarity: Rarity;
  /** True only for backgrounds when all are already owned. Cats + cosmetics are never duplicates. */
  duplicate: boolean;
  refundCoins: number;
  /** Instance id for the newly created cat or cosmetic — undefined for backgrounds. */
  instanceId?: string;
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
    if (rates[RARITIES[i]!]! > 0) return RARITIES[i]!;
  }
  return 'common';
}

/**
 * Server-side box pull. Picks a rarity from the box's drop table, then
 * uniformly picks an item of that rarity from the relevant catalog.
 *
 * Cats + cosmetics: always creates a new instance — no duplicate checks.
 * Backgrounds: duplicate refund still applies (flag-style ownership).
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
    const instanceId = makeInstanceId();
    return {
      kind: 'cat',
      itemId: pick.id,
      rarity,
      duplicate: false,
      refundCoins: 0,
      instanceId,
    };
  }

  if (box.rewardKind === 'cosmetic') {
    // effectsBox sets `effectsOnly: true` so the cosmetic-pool roll
    // filters to entries in EFFECT_COSMETIC_CATALOG only. Lets the
    // player target effects without polluting the static-cosmetic pool.
    const effectIds = new Set(EFFECT_COSMETIC_CATALOG.map((e) => e.id));
    const sourcePool = box.effectsOnly
      ? COSMETIC_CATALOG.filter((c) => effectIds.has(c.id))
      : COSMETIC_CATALOG;
    let pool = sourcePool.filter((c) => c.rarity === rarity);
    if (pool.length === 0) {
      // Effects-only with no entries at the rolled rarity — fall back
      // to ANY effect rarity so the roll never returns nothing.
      pool = sourcePool;
    }
    const pick = pool[Math.floor(rng() * pool.length)]!;
    const instanceId = makeInstanceId();
    return {
      kind: 'cosmetic',
      itemId: pick.id,
      rarity: pick.rarity,
      duplicate: false,
      refundCoins: 0,
      instanceId,
    };
  }

  // background — flag-style ownership, duplicates still refund
  const allBackgroundIds = Object.keys(BACKGROUND_CATALOG) as BackgroundId[];
  const unowned = allBackgroundIds.filter((id) => !state.ownedBackgrounds.includes(id));

  if (unowned.length === 0) {
    // Player owns every background — refund instead of adding a duplicate.
    const fallbackPick = allBackgroundIds[Math.floor(rng() * allBackgroundIds.length)]!;
    const entry = BACKGROUND_CATALOG[fallbackPick];
    return {
      kind: 'background',
      itemId: fallbackPick,
      rarity: entry.rarity,
      duplicate: true,
      refundCoins: DUPLICATE_REFUND,
    };
  }

  const pick = unowned[Math.floor(rng() * unowned.length)]!;
  const entry = BACKGROUND_CATALOG[pick];
  return {
    kind: 'background',
    itemId: pick,
    rarity: entry.rarity,
    duplicate: false,
    refundCoins: 0,
  };
}

/**
 * Apply a pull result to the player's state. New cats/cosmetics append a fresh
 * instance. Backgrounds go into ownedBackgrounds (flag-style); duplicates refund.
 *
 * For cats the catalog breed name is used as the default instance name — the
 * client will prompt the player to rename via POST /api/cats/rename.
 */
export function applyPullToState(state: PlayerState, pull: PullResult): void {
  if (pull.kind === 'cat') {
    const catEntry = CAT_CATALOG.find((c) => c.id === pull.itemId);
    state.ownedCats.push({
      id: pull.instanceId ?? makeInstanceId(),
      breed: pull.itemId as CatBreed,
      name: catEntry?.name ?? (pull.itemId as string),
    });
    return;
  }

  if (pull.kind === 'cosmetic') {
    state.ownedCosmetics.push({
      id: pull.instanceId ?? makeInstanceId(),
      type: pull.itemId as CosmeticId,
    });
    return;
  }

  // background
  if (pull.duplicate) {
    state.coins += pull.refundCoins;
  } else {
    state.ownedBackgrounds.push(pull.itemId as BackgroundId);
  }
}
