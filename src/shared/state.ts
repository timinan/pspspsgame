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
  /** When true, this cosmetic has no per-frame animation art and the Cat
   *  entity rides it through `cat-frame-offsets.json` so it bobs with
   *  its cat. Set by the Cosmetic Quick Add upload flow on single-PNG
   *  cosmetics. Existing hand-animated cosmetics leave this unset and
   *  keep using their per-frame art for motion. */
  isStatic?: boolean;
  /** Optional per-cosmetic override of the slot-default motion strength.
   *  Only used when `isStatic` is true. 1.0 = tracks cat 1:1. */
  motionStrength?: number;
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

import { GENERATED_CAT_CATALOG } from './cats-catalog.generated';
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
  // Auras (fuzzy ground glow at the cat's feet)
  { id: 'effect-red-glow',    name: 'Red Aura',    rarity: 'common',    slot: 'effect' },
  { id: 'effect-blue-glow',   name: 'Blue Aura',   rarity: 'common',    slot: 'effect' },
  { id: 'effect-gold-glow',   name: 'Gold Aura',   rarity: 'rare',      slot: 'effect' },
  { id: 'effect-green-glow',  name: 'Green Aura',  rarity: 'uncommon',  slot: 'effect' },
  { id: 'effect-purple-glow', name: 'Purple Aura', rarity: 'uncommon',  slot: 'effect' },
  { id: 'effect-pink-glow',   name: 'Pink Aura',   rarity: 'common',    slot: 'effect' },
  // Filter
  { id: 'effect-ghost',       name: 'Ghost',       rarity: 'rare',      slot: 'effect' },
  // Particles
  { id: 'effect-sparkle',     name: 'Sparkles',    rarity: 'uncommon',  slot: 'effect' },
  { id: 'effect-hearts',      name: 'Hearts',      rarity: 'rare',      slot: 'effect' },
  { id: 'effect-stars',       name: 'Stars',       rarity: 'uncommon',  slot: 'effect' },
  { id: 'effect-music',       name: 'Music',       rarity: 'uncommon',  slot: 'effect' },
  { id: 'effect-snow',        name: 'Snow',        rarity: 'rare',      slot: 'effect' },
  { id: 'effect-blossom',     name: 'Blossoms',    rarity: 'rare',      slot: 'effect' },
  { id: 'effect-fire',        name: 'Fire',        rarity: 'rare',      slot: 'effect' },
  { id: 'effect-bubbles',     name: 'Bubbles',     rarity: 'uncommon',  slot: 'effect' },
  { id: 'effect-butterfly',   name: 'Butterflies', rarity: 'legendary', slot: 'effect' },
];

/** Merged cosmetic catalog: generated atlas-backed cosmetics + effect cosmetics. */
export const COSMETIC_CATALOG: CosmeticEntry[] = [
  ...GENERATED_COSMETIC_CATALOG,
  ...EFFECT_COSMETIC_CATALOG,
];

// -- Music catalogs -----------------------------------------------------
//
// Music plays during a round in two layers: a long looping backing
// instrumental (BGM) underneath, and short meow stem one-shots (SFX)
// fired on every successful lane tap. Both layers are curated content
// shipped with the app — no per-user generation, no API cost at scale.
// See `outputs/prds/2026-06-22-pspsps-music-system-spec.md` for the
// full design rationale.

/** Vibe categories for the editor's vibe picker. Each backing track
 *  carries one; the chart stores the player's pick so the same chart
 *  always sounds like the same vibe.
 *
 *  - `upbeat`   — bouncy, energetic, dance, chiptune, synthwave
 *  - `melodic`  — pretty, dreamy, lo-fi, ambient, melodic
 *  - `smooth`   — jazzy, bossa, lounge, soulful
 */
export type BackingVibe = 'upbeat' | 'melodic' | 'smooth';

/** One backing instrumental loop. Lives in `public/assets/audio/backings/`. */
export interface BackingTrack {
  /** Stable id, e.g. 'fast-130'. */
  id: string;
  /** Optional human-readable name shown in the music calibrator + future
   *  player-facing pickers. The id stays stable; this can be re-titled. */
  displayName?: string;
  /** User-facing tempo label shown in the editor's tempo cycle button. */
  speedLabel: 'slow' | 'medium' | 'fast' | 'faster';
  /** User-facing vibe category shown in the editor's vibe picker. */
  vibe: BackingVibe;
  /** Beats per minute. Charts authored at this BPM align exactly to the
   *  backing's beat grid (no drift across a 30s round). */
  bpm: number;
  /** Phaser asset key registered in Preloader. */
  audioKey: string;
  /** One full loop length in ms — informational, used by future tooling
   *  that wants to schedule visual cues against bar boundaries. */
  loopDurationMs: number;
}

/**
 * Curated backing tracks. The catalog is generated by
 * `scripts/sync-catalog.ts` from `tools/music/music.json`; edits live
 * in the music calibrator at /tools/music/calibrator.html, not here.
 */
export { BACKING_CATALOG } from './music-catalog.generated';

/** One pre-recorded meow audio one-shot. Lives in `public/assets/audio/meows/`. */
export interface MeowStem {
  /** Stable id, e.g. 'cute-01'. */
  id: string;
  /** Phaser asset key registered in Preloader. */
  audioKey: string;
  /** Meow character — narrative description of the inflection. */
  character: 'cute' | 'sass' | 'yowl' | 'chirp' | 'purr' | 'dramatic';
  /** Lane affinity. Lane 0 = low/sass, lane 1 = mid/cute, lane 2 = high/chirp.
   *  `MusicSystem` filters by lane on each successful tap before random pick. */
  lane: LaneId;
}

/**
 * Curated meow stem pool. 4 short staccato cuts of the legacy meow,
 * each ~140-450ms, with 1ms / 12ms fades to kill click artifacts at
 * the slice boundaries. Generated by `scripts/generate-meow-stems.mjs`
 * — re-run to regenerate after editing the source `meow.wav`.
 *
 * Per-lane affinity: lane 0 (sass) gets the longer-body cuts so taps
 * read as bass meows; lane 1 (cute) gets the bright opener; lane 2
 * (chirp) gets the sharp short stab.
 */
export const MEOW_STEM_CATALOG: MeowStem[] = [
  { id: 'sass-01',  audioKey: 'meow-sass-01',  character: 'sass',  lane: 0 },
  { id: 'purr-01',  audioKey: 'meow-purr-01',  character: 'purr',  lane: 0 },
  { id: 'cute-01',  audioKey: 'meow-cute-01',  character: 'cute',  lane: 1 },
  { id: 'chirp-01', audioKey: 'meow-chirp-01', character: 'chirp', lane: 2 },
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
  /** Total step count. Must be a positive multiple of CHART_PAGE_SIZE so
   *  the editor can scroll one page at a time and the chart's loop point
   *  aligns to a clean musical bar. */
  stepCount: number;
  bpm: number;
  /** Player-picked vibe for the backing track. Optional — old charts
   *  without it default to the first available vibe at the chart's
   *  tempo on next editor open. */
  vibe?: BackingVibe;
  /** Player-picked specific backing track id (e.g. 'neon-dash'). When set,
   *  MusicSystem plays this exact song. When unset, MusicSystem picks from
   *  the bpm+vibe bucket using the legacy chart-hash fallback. */
  audioKey?: string;
  steps: ChartStep[];
  updatedAt: number;
}

/** Step count = 4 pages × 8 steps = a 32-step chart. At 120bpm that's
 *  ~10.7s of music before the loop point — long enough to feel like a
 *  beat instead of a stutter, short enough that the player can scan
 *  the whole thing in the editor without scrolling marathons. */
export const CHART_PAGE_SIZE = 8;
export const DEFAULT_CHART_STEP_COUNT = 32;

export type BackgroundId = keyof typeof BACKGROUND_CATALOG;

export function emptyChart(
  authorId: string,
  title: string,
  stepCount: number = DEFAULT_CHART_STEP_COUNT,
): Chart {
  return {
    authorId,
    title,
    stepCount,
    bpm: 120,
    steps: Array.from({ length: stepCount }, () => ({ lanes: [] })),
    updatedAt: Date.now(),
  };
}

export function validateChart(c: Chart): { ok: true } | { ok: false; reason: string } {
  if (!c.authorId) return { ok: false, reason: 'authorId required' };
  if (c.stepCount <= 0 || c.stepCount % CHART_PAGE_SIZE !== 0)
    return { ok: false, reason: `stepCount must be a positive multiple of ${CHART_PAGE_SIZE}` };
  if (c.bpm < 60 || c.bpm > 200) return { ok: false, reason: 'bpm out of range' };
  if (c.steps.length !== c.stepCount) return { ok: false, reason: 'steps length must equal stepCount' };
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
  /** Background ids the player owns. Always includes 'stage' (the default). */
  ownedBackgrounds: BackgroundId[];
  /** Currently active background. */
  activeBackground: BackgroundId;
}

/**
 * Create a fresh PlayerState with all fields initialized to defaults.
 * Used by tests and the server-side state initializer.
 */
export function createFreshPlayerState(username: string = ''): PlayerState {
  // DEV: grant one instance of every cat in the catalog and seat the three
  // demo headliners — Snow White / Jade / Sakura — each with a thematic
  // effect cosmetic pre-equipped so the playtest opens on a vibe-y stage
  // instead of a bare lineup. Revert to first-three-only seat + no pre-
  // equipped effects (`STARTER_BREEDS`) before shipping alongside
  // DEV_RESET_ON_LOAD = false.
  const SEAT_IDS = ['seat-left', 'seat-center', 'seat-right'] as const;
  const starterCats: OwnedCat[] = GENERATED_CAT_CATALOG.map((entry) => ({
    id: makeInstanceId(),
    breed: entry.id,
    name: entry.name ?? entry.id,
  }));

  // Resolve the three demo headliners by breed id. Falls back to the
  // first owned cat for any missing breed so the state stays valid even
  // if the catalog ids shift later.
  const findCatByBreed = (breedId: string): OwnedCat | undefined =>
    starterCats.find((c) => c.breed === breedId);
  const headliners: Array<{ cat: OwnedCat | undefined; effectId: string }> = [
    { cat: findCatByBreed('cat9'),  effectId: 'effect-sparkle' },     // Snow White → Sparkles
    { cat: findCatByBreed('cat10'), effectId: 'effect-green-glow' },  // Jade → Green Aura
    { cat: findCatByBreed('cat12'), effectId: 'effect-blossom' },     // Sakura → Blossoms
  ];

  const seatedCats: Partial<Record<SeatId, string>> = {};
  headliners.forEach((h, i) => {
    if (!h.cat) return;
    const seatId = SEAT_IDS[i];
    if (seatId) seatedCats[seatId] = h.cat.id;
  });

  const ownedCosmetics: OwnedCosmetic[] = COSMETIC_CATALOG.map((e) => ({
    id: makeInstanceId(),
    type: e.id,
  }));

  // Pre-equip the headliner effects. Pull each chosen effect instance
  // out of ownedCosmetics (the dressing room treats equipped items as
  // living outside ownedCosmetics + tracked via equippedCosmeticTypes)
  // and write the slot binding.
  const equippedCosmetics: Partial<Record<string, Partial<Record<string, string>>>> = {};
  const equippedCosmeticTypes: Record<string, string> = {};
  for (const h of headliners) {
    if (!h.cat) continue;
    const cosIdx = ownedCosmetics.findIndex((c) => c.type === h.effectId);
    if (cosIdx === -1) continue;
    const cosmetic = ownedCosmetics[cosIdx]!;
    ownedCosmetics.splice(cosIdx, 1);
    equippedCosmetics[h.cat.id] = { effect: cosmetic.id };
    equippedCosmeticTypes[cosmetic.id] = cosmetic.type;
  }

  return {
    username,
    coins: STARTER_COINS,
    ownedCats: starterCats,
    // DEV: grant one instance of every cosmetic in the catalog (atlas-backed
    // + effects) so the DressingRoom shows the full set without box-pull
    // RNG. Revert to box-pull-only (`[]`) before shipping alongside
    // DEV_RESET_ON_LOAD = false.
    ownedCosmetics,
    equippedCosmetics,
    equippedCosmeticTypes,
    bestScore: 0,
    // Skip the Welcome tutorial — players land straight in Decorate.
    onboardingDone: true,
    updatedAt: Date.now(),
    house: {
      themeId: 'default',
      ownedThemes: ['default'],
    },
    seatedCats,
    chart: emptyChart(username, 'Untitled'),
    // DEV: grant all catalog backgrounds so playtests can swap freely
    // without pulling from the background box every time. Revert to
    // ['stage'] before shipping (alongside DEV_RESET_ON_LOAD = false).
    ownedBackgrounds: Object.keys(BACKGROUND_CATALOG) as BackgroundId[],
    activeBackground: 'stage',
  };
}

