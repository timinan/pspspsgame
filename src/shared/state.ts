/**
 * Single source of truth for cat / cosmetic / box catalogs and player state.
 *
 * Imported by both the Phaser client and the Devvit Hono server so the two
 * sides can never disagree about drop tables, prices, or item lists. The
 * server uses these to roll boxes and validate adoption; the client uses
 * them to render names, rarity badges, and shop UI.
 */

// -- Item identifiers ---------------------------------------------------

// IDs are typed loosely as strings now that the catalogs are generated
// from tools/{cosmetics,cats}/*.json. Specific base IDs are still
// referenced by string literal in places that need to special-case them
// (e.g. `breed === 'rainbow'` for the hue-cycle shader).
export type CatBreed = string;
export type CosmeticId = string;

export type Rarity = 'common' | 'uncommon' | 'rare' | 'legendary';

export type BoxId =
  | 'catCrate'
  | 'premiumCatCrate'
  | 'stylePack'
  | 'premiumStylePack'
  | 'decorCrate'
  | 'themePack';

// -- Catalog entries ----------------------------------------------------

export interface CatEntry {
  id: CatBreed;
  name: string;
  rarity: Rarity;
  /** Optional render scale (cats only). Defaults to 1. */
  scale?: number;
  /** For generated/tinted cats: the parent breed whose atlas frames are used. */
  sourceFrame?: string;
  /** Hex tint (e.g. "#ff5555") applied at render time. */
  tint?: string;
  /** Blend mode used at render time. */
  tintMode?: 'color' | 'hue' | 'multiply' | 'soft-light';
}

export interface CosmeticEntry {
  id: CosmeticId;
  name: string;
  rarity: Rarity;
  /** Where the cosmetic sits on the cat (head, face, neck, body, held). */
  slot?: string;
  /** For generated/tinted cosmetics: the parent's atlas frame name to render. */
  sourceFrame?: string;
  /** Hex tint applied at render time. */
  tint?: string;
  /** Blend mode used at render time. */
  tintMode?: 'color' | 'hue' | 'multiply' | 'soft-light';
}

// -- Decorations + Themes ------------------------------------------------

export type DecorationId = string;
export type ThemeId = string;
export type SlotId = string;

export interface DecorationEntry {
  id: DecorationId;
  displayName: string;
  /** Frame key in the decorations atlas */
  frame: string;
  rarity: Rarity;
}

export interface ThemeEntry {
  id: ThemeId;
  displayName: string;
  /** Phaser texture key for the backdrop image */
  backdropKey: string;
  /** Phaser audio key for the music track */
  musicKey: string;
  rarity: Rarity;
}

export interface BoxConfig {
  id: BoxId;
  cost: number;
  rewardKind: 'cat' | 'cosmetic' | 'decoration' | 'theme';
  /** Drop weights by rarity. Must sum to 100 (enforced by tests). */
  rates: Record<Rarity, number>;
}

// -- Cat catalog --------------------------------------------------------
// Both catalogs are auto-synced from tools/{cats,cosmetics}/*.json by
// scripts/sync-catalog.ts (runs after every calibrator save). Do not
// edit the generated arrays by hand — the calibrators are the source
// of truth.

export { GENERATED_CAT_CATALOG as CAT_CATALOG } from './cats-catalog.generated';
export { GENERATED_COSMETIC_CATALOG as COSMETIC_CATALOG } from './cosmetics-catalog.generated';

// -- Box catalog --------------------------------------------------------

export const BOX_CATALOG: Record<BoxId, BoxConfig> = {
  catCrate: {
    id: 'catCrate',
    cost: 200,
    rewardKind: 'cat',
    rates: { common: 70, uncommon: 25, rare: 5, legendary: 0 },
  },
  premiumCatCrate: {
    id: 'premiumCatCrate',
    cost: 1000,
    rewardKind: 'cat',
    rates: { common: 0, uncommon: 40, rare: 50, legendary: 10 },
  },
  stylePack: {
    id: 'stylePack',
    cost: 50,
    rewardKind: 'cosmetic',
    rates: { common: 70, uncommon: 25, rare: 5, legendary: 0 },
  },
  premiumStylePack: {
    id: 'premiumStylePack',
    cost: 250,
    rewardKind: 'cosmetic',
    rates: { common: 0, uncommon: 40, rare: 50, legendary: 10 },
  },
  decorCrate: {
    id: 'decorCrate',
    cost: 50,
    rewardKind: 'decoration',
    rates: { common: 70, uncommon: 25, rare: 5, legendary: 0 },
  },
  themePack: {
    id: 'themePack',
    cost: 50,
    rewardKind: 'theme',
    rates: { common: 70, uncommon: 25, rare: 5, legendary: 0 },
  },
};

// -- Economy constants --------------------------------------------------

/** Fresh users get this many coins on first state load. Enough for one
 * Cat Crate (200) + one Style Pack (50), with 50 left over. */
export const STARTER_COINS = 300;

/** Duplicate pulls return this many coins as a soft refund. */
export const DUPLICATE_REFUND = 50;

// -- Player state -------------------------------------------------------

export interface PlayerState {
  /** Reddit username — the key under which this lives in Redis. */
  username: string;
  coins: number;
  ownedCats: CatBreed[];
  ownedCosmetics: CosmeticId[];
  /** Map of catBreed -> cosmeticId currently worn by that cat. */
  equippedCosmetics: Partial<Record<CatBreed, CosmeticId>>;
  bestScore: number;
  /** True after the player has completed the Welcome scene. */
  onboardingDone: boolean;
  /** Unix-ms of last write. */
  updatedAt: number;
}
