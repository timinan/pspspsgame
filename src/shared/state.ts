/**
 * Single source of truth for cat / cosmetic / box catalogs and player state.
 *
 * Imported by both the Phaser client and the Devvit Hono server so the two
 * sides can never disagree about drop tables, prices, or item lists. The
 * server uses these to roll boxes and validate adoption; the client uses
 * them to render names, rarity badges, and shop UI.
 */

import { BACKGROUND_CATALOG } from './themes-catalog.generated';

// -- Item identifiers ---------------------------------------------------

// IDs are typed loosely as strings now that the catalogs are generated
// from tools/{cosmetics,cats}/*.json. Specific base IDs are still
// referenced by string literal in places that need to special-case them
// (e.g. `breed === 'rainbow'` for the hue-cycle shader).
export type CatBreed = string;
export type CosmeticId = string;

// -- Per-instance ownership types ---------------------------------------

/** A single owned cat — one pull from the cat box creates one instance. */
export interface OwnedCat {
  /** Unique instance id generated at pull time. */
  id: string;
  /** Catalog breed reference. */
  breed: CatBreed;
  /** Custom name set by the player on box reveal. Defaults to the catalog breed name. */
  name: string;
}

/** A single owned cosmetic item — one pull creates one instance. Duplicates allowed. */
export interface OwnedCosmetic {
  /** Unique instance id generated at pull time. */
  id: string;
  /** Catalog cosmetic id. */
  type: CosmeticId;
}

/**
 * Generate a short unique id for a new cat/cosmetic instance.
 * Combines Math.random (base-36) + Date.now (base-36) for practical uniqueness.
 */
export function makeInstanceId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export type Rarity = 'common' | 'uncommon' | 'rare' | 'legendary';

export type BoxId = 'catBox' | 'cosmeticBox' | 'backgroundBox';

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

// -- Themes (Backgrounds) -----------------------------------------------

export type ThemeId = string;
export type SeatId = string;

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
  displayName: string;
  description: string;
  price: number;
  rewardKind: 'cat' | 'cosmetic' | 'background';
  /** Drop weights by rarity. Must sum to 100 (enforced by tests). */
  rates: Record<Rarity, number>;
}

// -- Cat catalog --------------------------------------------------------
// Both catalogs are auto-synced from tools/{cats,cosmetics}/*.json by
// scripts/sync-catalog.ts (runs after every calibrator save). Do not
// edit the generated arrays by hand — the calibrators are the source
// of truth.

export { GENERATED_CAT_CATALOG as CAT_CATALOG } from './cats-catalog.generated';
export { GENERATED_THEME_CATALOG as THEME_CATALOG, BACKGROUND_CATALOG } from './themes-catalog.generated';

import { GENERATED_COSMETIC_CATALOG } from './cosmetics-catalog.generated';

/**
 * Effect cosmetics — pure code-driven visual flair (glow, bobbing, particles)
 * that lives in the 'effect' slot. Each entry carries `iconEmoji` instead of
 * an atlas frame; the DressingRoom renders the emoji as the thumbnail.
 *
 * Implementations and per-effect apply() functions live in
 * `src/client/effects/cat-effects.ts`. This catalog is the SOURCE list — the
 * client maps id → apply() at render time.
 */
export const EFFECT_COSMETIC_CATALOG: CosmeticEntry[] = [
  { id: 'effect-red-glow',    name: 'Red Glow',    rarity: 'common',    slot: 'effect' },
  { id: 'effect-blue-glow',   name: 'Blue Glow',   rarity: 'common',    slot: 'effect' },
  { id: 'effect-gold-glow',   name: 'Gold Glow',   rarity: 'rare',      slot: 'effect' },
  { id: 'effect-green-glow',  name: 'Green Glow',  rarity: 'uncommon',  slot: 'effect' },
  { id: 'effect-purple-glow', name: 'Purple Glow', rarity: 'uncommon',  slot: 'effect' },
  { id: 'effect-pink-glow',   name: 'Pink Glow',   rarity: 'common',    slot: 'effect' },
  { id: 'effect-bob',         name: 'Bobbing',     rarity: 'common',    slot: 'effect' },
  { id: 'effect-pulse',       name: 'Pulsing',     rarity: 'common',    slot: 'effect' },
  { id: 'effect-spin',        name: 'Spinning',    rarity: 'rare',      slot: 'effect' },
  { id: 'effect-wobble',      name: 'Wobble',      rarity: 'common',    slot: 'effect' },
  { id: 'effect-ghost',       name: 'Ghost',       rarity: 'rare',      slot: 'effect' },
  { id: 'effect-sparkle',     name: 'Sparkles',    rarity: 'uncommon',  slot: 'effect' },
  { id: 'effect-hearts',      name: 'Hearts',      rarity: 'rare',      slot: 'effect' },
];

/** Merged cosmetic catalog: generated atlas-backed cosmetics + effect cosmetics. */
export const COSMETIC_CATALOG: CosmeticEntry[] = [
  ...GENERATED_COSMETIC_CATALOG,
  ...EFFECT_COSMETIC_CATALOG,
];

// -- Box catalog --------------------------------------------------------

export const BOX_CATALOG: Record<BoxId, BoxConfig> = {
  catBox: {
    id: 'catBox',
    displayName: 'Cat Box',
    description: 'Opens a random cat. Could be a new face for your stage.',
    price: 150,
    rewardKind: 'cat',
    rates: { common: 70, uncommon: 25, rare: 5, legendary: 0 },
  },
  cosmeticBox: {
    id: 'cosmeticBox',
    displayName: 'Cosmetic Box',
    description: 'Opens a random hat, bow, or accessory for the Dressing Room.',
    price: 80,
    rewardKind: 'cosmetic',
    rates: { common: 70, uncommon: 25, rare: 5, legendary: 0 },
  },
  backgroundBox: {
    id: 'backgroundBox',
    displayName: 'Background Box',
    description: 'Opens a random stage background.',
    price: 250,
    rewardKind: 'background',
    rates: { common: 70, uncommon: 25, rare: 5, legendary: 0 },
  },
};

// -- Economy constants --------------------------------------------------

/** Fresh users get this many coins on first state load. Enough for one
 * Cat Crate (200) + one Style Pack (50), with 50 left over. */
// TEMP-DEMO: bumped from 300 to give 5 cosmetic boxes for testing
// breakdown: 1 cat crate (200) + 5 style packs (250) + 100 buffer = 550
export const STARTER_COINS = 600;

/** Duplicate pulls return this many coins as a soft refund. */
export const DUPLICATE_REFUND = 50;

// -- Chart data model ---------------------------------------------------

export type LaneId = 0 | 1 | 2;

export interface ChartStep {
  lanes: LaneId[];
}

export interface Chart {
  authorId: string;
  title: string;
  stepCount: 8;
  bpm: number;
  steps: ChartStep[];
  updatedAt: number;
}

export type BackgroundId = keyof typeof BACKGROUND_CATALOG;

export function emptyChart(authorId: string, title: string): Chart {
  return {
    authorId,
    title,
    stepCount: 8,
    bpm: 120,
    steps: Array.from({ length: 8 }, () => ({ lanes: [] })),
    updatedAt: Date.now(),
  };
}

export function validateChart(c: Chart): { ok: true } | { ok: false; reason: string } {
  if (!c.authorId) return { ok: false, reason: 'authorId required' };
  if (c.stepCount !== 8) return { ok: false, reason: 'stepCount must be 8' };
  if (c.bpm < 60 || c.bpm > 200) return { ok: false, reason: 'bpm out of range' };
  if (c.steps.length !== 8) return { ok: false, reason: 'steps length must equal stepCount' };
  for (const s of c.steps) {
    for (const l of s.lanes) {
      if (l !== 0 && l !== 1 && l !== 2) return { ok: false, reason: `bad lane ${l}` };
    }
  }
  return { ok: true };
}

// -- Player state -------------------------------------------------------

export interface PlayerHouseState {
  /** Active theme — 'default' for fresh players */
  themeId: ThemeId;
  /** All theme ids the player owns. Always includes 'default'. */
  ownedThemes: ThemeId[];
}

export interface PlayerState {
  /** Reddit username — the key under which this lives in Redis. */
  username: string;
  coins: number;
  /** Each entry is a unique instance of an owned cat. Duplicates allowed. */
  ownedCats: OwnedCat[];
  /** Each entry is a unique instance of an owned cosmetic. Duplicates allowed. */
  ownedCosmetics: OwnedCosmetic[];
  /**
   * Per-cat-instance equipped cosmetics.
   * Outer key = cat instance id. Inner key = slot name. Value = cosmetic instance id.
   * Equipping moves the cosmetic OUT of ownedCosmetics; unequipping puts it back.
   */
  equippedCosmetics: Partial<Record<string, Partial<Record<string, string>>>>;
  /**
   * Lookup from cosmetic instance id → catalog cosmetic type (CosmeticId).
   * Needed because equipped cosmetics are removed from ownedCosmetics, so we
   * can't look up their type from there. Updated whenever a cosmetic is equipped
   * or unequipped.
   */
  equippedCosmeticTypes: Record<string, CosmeticId>;
  bestScore: number;
  /** True after the player has completed the Welcome scene. */
  onboardingDone: boolean;
  /** Unix-ms of last write. */
  updatedAt: number;
  house: PlayerHouseState;
  /** Map of seat id → cat instance id (NOT breed). */
  seatedCats: Partial<Record<SeatId, string>>;
  /** The player's current rhythm chart. */
  chart: Chart;
  /** Background ids the player owns. Always includes 'default'. */
  ownedBackgrounds: BackgroundId[];
  /** Currently active background. */
  activeBackground: BackgroundId;
}

/**
 * Create a fresh PlayerState with all fields initialized to defaults.
 * Used by tests and the server-side state initializer.
 */
export function createFreshPlayerState(username: string = ''): PlayerState {
  return {
    username,
    coins: STARTER_COINS,
    ownedCats: [],
    // Auto-grant one instance of each EFFECT cosmetic so the player can test
    // them in the DressingRoom EFFECT tab without going through the
    // cosmetic-box RNG. Atlas-backed cosmetics still come from box pulls.
    ownedCosmetics: EFFECT_COSMETIC_CATALOG.map((e) => ({
      id: makeInstanceId(),
      type: e.id,
    })),
    equippedCosmetics: {},
    equippedCosmeticTypes: {},
    bestScore: 0,
    onboardingDone: false,
    updatedAt: Date.now(),
    house: {
      themeId: 'default',
      ownedThemes: ['default'],
    },
    seatedCats: {},
    chart: emptyChart(username, 'Untitled'),
    ownedBackgrounds: ['default'],
    activeBackground: 'default',
  };
}

