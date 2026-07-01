import { Hono } from 'hono';
import { redis, reddit } from '@devvit/web/server';
import { loadOrInit, resetState, save } from '../core/player-state';
import { pullBox, applyPullToState } from '../core/box-pull';
import {
  BACKGROUND_CATALOG,
  BOX_CATALOG,
  CAT_CATALOG,
  makeInstanceId,
  type BackgroundId,
  type BoxId,
  type ThemeId,
  type SeatId,
  type CosmeticId,
  type CatBreed,
  type RoundStatsDelta,
  type PerSongStats,
} from '../../shared/state';
import type { TutorialStepId } from '../../shared/tutorial-types';

// DEV ONLY — every GET /api/state wipes the player's record and hands
// back a fresh one with DEV_STARTER_COINS. Onboarding re-runs each page
// load and you have plenty of coins to test premium boxes. Flip
// DEV_RESET_ON_LOAD to false (or delete this block) before shipping.
const DEV_RESET_ON_LOAD = true;
const DEV_STARTER_COINS = 5000;

export const state = new Hono();

async function currentUsername(): Promise<string> {
  const username = await reddit.getCurrentUsername();
  return username ?? 'anonymous';
}

/** GET /api/state — current player state, initializes on first hit. */
state.get('/state', async (c) => {
  const username = await currentUsername();
  const player = DEV_RESET_ON_LOAD
    ? await resetState(redis, username, DEV_STARTER_COINS)
    : await loadOrInit(redis, username);
  return c.json({ state: player });
});

/** POST /api/box/open — body: { boxId }. Server rolls + persists. */
state.post('/box/open', async (c) => {
  const { boxId } = (await c.req.json()) as { boxId: BoxId };
  const box = BOX_CATALOG[boxId];
  if (!box) {
    return c.json({ ok: false, reason: 'unknown_box' }, 400);
  }
  const username = await currentUsername();
  const player = await loadOrInit(redis, username);
  if (player.coins < box.price) {
    return c.json({ ok: false, reason: 'insufficient_coins' }, 400);
  }
  player.coins -= box.price;
  const pull = pullBox(boxId, player);
  applyPullToState(player, pull);
  // Stats — every box open bumps the per-type counter + folds the box
  // price into lifetime spend. Refund coins from duplicate pulls are
  // handled on the client via /api/coins/sync, so we don't double-count
  // the refund as "earned" here — that path fires later.
  player.stats.coinsSpentLifetime += box.price;
  player.stats.boxesOpened[boxId] = (player.stats.boxesOpened[boxId] ?? 0) + 1;
  await save(redis, player);
  return c.json({ ok: true, pull, state: player });
});

/** POST /api/coins/sync — body: { coinsDelta, bestScore? }.
 * Lets the client push incremental coin gains + best-score updates
 * without round-tripping the whole state. */
state.post('/coins/sync', async (c) => {
  const { coinsDelta, bestScore } = (await c.req.json()) as {
    coinsDelta: number;
    bestScore?: number;
  };
  const username = await currentUsername();
  const player = await loadOrInit(redis, username);
  const delta = Math.floor(coinsDelta);
  player.coins = Math.max(0, player.coins + delta);
  if (bestScore !== undefined && bestScore > player.bestScore) {
    player.bestScore = bestScore;
  }
  // Stats — only positive deltas count as "earned". Negative deltas
  // are handled at their spend site (box/open bumps coinsSpentLifetime
  // directly). Sync-driven deductions are rare but not unheard of.
  if (delta > 0) player.stats.coinsEarnedLifetime += delta;
  await save(redis, player);
  return c.json({ state: player });
});

/**
 * POST /api/cosmetic/equip
 * Body: { catInstanceId, slot, cosmeticInstanceId | null }
 *
 * Equips a cosmetic instance into a slot on a cat.
 * - The cosmetic instance is popped from ownedCosmetics.
 * - Whatever was previously in the slot is pushed BACK into ownedCosmetics.
 * - Pass cosmeticInstanceId=null to clear the slot (restores previous to inventory).
 *
 * equippedCosmeticTypes is maintained so we can restore the catalog type when a
 * cosmetic is displaced or the player rehomes the cat.
 */
state.post('/cosmetic/equip', async (c) => {
  const { catInstanceId, slot, cosmeticInstanceId } = (await c.req.json()) as {
    catInstanceId: string;
    slot: string;
    cosmeticInstanceId: string | null;
  };
  if (!slot || typeof slot !== 'string') {
    return c.json({ ok: false, reason: 'missing_slot' }, 400);
  }
  const username = await currentUsername();
  const player = await loadOrInit(redis, username);

  // Ensure equippedCosmeticTypes exists (backfill for older state).
  if (!player.equippedCosmeticTypes) player.equippedCosmeticTypes = {};

  const catInstance = player.ownedCats.find((cat) => cat.id === catInstanceId);
  if (!catInstance) {
    return c.json({ ok: false, reason: 'cat_not_owned' }, 400);
  }

  const slots = player.equippedCosmetics[catInstanceId] ?? {};

  // Restore whatever was previously in this slot to the player's inventory.
  const previousCosmeticInstanceId = slots[slot];
  if (previousCosmeticInstanceId) {
    const prevType = player.equippedCosmeticTypes[previousCosmeticInstanceId] as CosmeticId | undefined;
    player.ownedCosmetics.push({
      id: previousCosmeticInstanceId,
      type: prevType ?? previousCosmeticInstanceId as CosmeticId,
    });
    delete player.equippedCosmeticTypes[previousCosmeticInstanceId];
  }

  if (cosmeticInstanceId === null) {
    // Clear slot — previous item already returned above.
    delete slots[slot];
  } else {
    // Verify the cosmetic instance is in ownedCosmetics.
    const cosmeticIndex = player.ownedCosmetics.findIndex((cos) => cos.id === cosmeticInstanceId);
    if (cosmeticIndex === -1) {
      // Roll back the previous re-insertion.
      if (previousCosmeticInstanceId) player.ownedCosmetics.pop();
      return c.json({ ok: false, reason: 'cosmetic_not_owned' }, 400);
    }
    const [cosmeticInstance] = player.ownedCosmetics.splice(cosmeticIndex, 1);
    // Track the type so we can restore it later.
    player.equippedCosmeticTypes[cosmeticInstanceId] = cosmeticInstance!.type;
    slots[slot] = cosmeticInstanceId;
  }

  if (Object.keys(slots).length === 0) {
    delete player.equippedCosmetics[catInstanceId];
  } else {
    player.equippedCosmetics[catInstanceId] = slots;
  }
  await save(redis, player);
  return c.json({ ok: true, state: player });
});

/** POST /api/onboarding/complete — flips onboardingDone=true. */
state.post('/onboarding/complete', async (c) => {
  const username = await currentUsername();
  const player = await loadOrInit(redis, username);
  player.onboardingDone = true;
  // Completing onboarding always clears any in-progress tutorial step
  // so re-entry after first complete doesn't resurrect a stale resume.
  player.tutorialStep = null;
  // Stamp the dev-override "consumed" timestamp so the same forced-
  // tutorial override doesn't fire again on next boot. The runtime
  // compares this against USER_OVERRIDES[username].setAt — Tim has to
  // re-flip the toggle (which bumps setAt) to force a replay.
  player.forcedTutorialClearedAt = Date.now();
  await save(redis, player);
  return c.json({ state: player });
});

/** POST /api/dev/apply-godmode — grant max coins + one of every cat
 *  breed, every cosmetic, every background. Idempotent at the catalog
 *  level (re-running adds duplicate instances of cats/cosmetics; coins
 *  and backgrounds are de-duped). Stamps player.forcedGodmodeAppliedAt
 *  so the matching USER_OVERRIDES entry doesn't fire on next boot
 *  unless Tim re-flips the toggle. Called by Preloader when the
 *  override condition is met — NOT a public endpoint. */
state.post('/dev/apply-godmode', async (c) => {
  const username = await currentUsername();
  const player = await loadOrInit(redis, username);

  // Bottomless coins. Pick a number big enough that no purchase can
  // dent it but not so big it overflows any UI display logic.
  player.coins = 1_000_000;

  // One of each cat breed not currently owned. CAT_CATALOG is a flat
  // array of CatEntry (id + name + rarity) so we iterate it directly.
  const ownedBreeds = new Set(player.ownedCats.map((c) => c.breed));
  for (const entry of CAT_CATALOG) {
    if (ownedBreeds.has(entry.id)) continue;
    player.ownedCats.push({
      id: makeInstanceId(),
      breed: entry.id,
      name: entry.name,
    });
  }

  // One of every cosmetic. Lazy-imported to avoid front-loading the
  // (large) catalog when the route module first loads.
  const { COSMETIC_CATALOG } = await import('../../shared/state');
  for (const cosmetic of COSMETIC_CATALOG) {
    player.ownedCosmetics.push({
      id: makeInstanceId(),
      type: cosmetic.id,
    });
  }

  // All backgrounds (set-based — duplicates skipped).
  const ownedBg = new Set(player.ownedBackgrounds);
  for (const bgId of Object.keys(BACKGROUND_CATALOG) as BackgroundId[]) {
    if (!ownedBg.has(bgId)) {
      player.ownedBackgrounds.push(bgId);
    }
  }

  // Godmode also flips onboardingDone. Tim's intent: godmode = "set
  // this player up for dev / testing, skip every gate". Without this,
  // DEV_RESET_ON_LOAD=true wipes state to a fresh PlayerState every
  // page load (onboardingDone: false), and the Preloader's tutorial
  // routing wins over godmode — player lands in TutorialOrchestrator
  // regardless of how loaded they are.
  //
  // NOTE: we deliberately do NOT stamp forcedTutorialClearedAt here.
  // Godmode + tutorialCheck are independent overrides — if the player
  // has both on, the Preloader's tutorialCheck block fires after
  // godmode and locally mutates onboardingDone=false before routing.
  // Stamping forcedTutorialClearedAt here would consume the tutorial
  // override at the same instant and the tutorial block would think
  // it's already been cleared this session. Kept separate.
  player.onboardingDone = true;
  player.tutorialStep = null;
  player.forcedGodmodeAppliedAt = Date.now();
  await save(redis, player);
  return c.json({ ok: true, state: player });
});

/** POST /api/stats/round — client posts a RoundStatsDelta at the end
 *  of a real (non-tutorial) round (or at scene teardown when the round
 *  didn't finish). Server folds the delta into PlayerStats: bumps
 *  lifetime counters, updates per-song best-score / best-combo /
 *  best-accuracy / plays / lastPlayedAt, and re-evaluates the daily
 *  streak. Non-negative clamps + integer coercion guard against
 *  spoofed client payloads. Returns the updated state so the client can
 *  cache-invalidate immediately if any UI reads stats. */
state.post('/stats/round', async (c) => {
  const raw = (await c.req.json()) as Partial<RoundStatsDelta>;
  const clampNonNeg = (n: number | undefined): number =>
    Number.isFinite(n) ? Math.max(0, Math.floor(n as number)) : 0;
  const clampFloat = (n: number | undefined, lo: number, hi: number): number =>
    Number.isFinite(n) ? Math.min(hi, Math.max(lo, n as number)) : 0;
  const delta: RoundStatsDelta = {
    songKey: (typeof raw.songKey === 'string' ? raw.songKey : '').slice(0, 200) || 'untitled',
    finalScore: clampNonNeg(raw.finalScore),
    accuracy: clampFloat(raw.accuracy, 0, 1),
    perfects: clampNonNeg(raw.perfects),
    hits: clampNonNeg(raw.hits),
    misses: clampNonNeg(raw.misses),
    tapsAttempted: clampNonNeg(raw.tapsAttempted),
    maxCombo: clampNonNeg(raw.maxCombo),
    combosCompleted: clampNonNeg(raw.combosCompleted),
    slidesLanded: clampNonNeg(raw.slidesLanded),
    slidesMissed: clampNonNeg(raw.slidesMissed),
    holdsStarted: clampNonNeg(raw.holdsStarted),
    holdsCompleted: clampNonNeg(raw.holdsCompleted),
    holdMsAccumulated: clampNonNeg(raw.holdMsAccumulated),
    longestHoldMs: clampNonNeg(raw.longestHoldMs),
    finished: raw.finished === true,
  };

  const username = await currentUsername();
  const player = await loadOrInit(redis, username);
  const s = player.stats;

  // Lifetime rhythm counters.
  s.totalPerfects += delta.perfects;
  s.totalHits += delta.hits;
  s.totalMisses += delta.misses;
  s.totalTapsAttempted += delta.tapsAttempted;
  s.longestCombo = Math.max(s.longestCombo, delta.maxCombo);
  s.totalCombos += delta.combosCompleted;

  // Songs finished vs abandoned. Perfect songs = finished + non-zero
  // attempts + zero misses. Zero-attempt finishes (empty rehearsal / stub
  // charts) don't count as "perfect" — they're just noise.
  if (delta.finished) {
    s.songsFinished += 1;
    if (delta.misses === 0 && delta.tapsAttempted > 0) s.perfectSongs += 1;
  } else {
    s.songsAbandoned += 1;
  }

  // Slides + holds.
  s.slidesHit += delta.slidesLanded;
  s.slidesMissed += delta.slidesMissed;
  s.holdsStarted += delta.holdsStarted;
  s.holdsCompleted += delta.holdsCompleted;
  s.totalHoldMs += delta.holdMsAccumulated;
  s.longestHoldMs = Math.max(s.longestHoldMs, delta.longestHoldMs);

  // Per-song aggregate — keyed by the delta's songKey so audioKey-less
  // charts still group under their title.
  const prev: PerSongStats = s.perSong[delta.songKey] ?? {
    plays: 0,
    bestScore: 0,
    bestCombo: 0,
    bestAccuracy: 0,
    lastPlayedAt: 0,
  };
  s.perSong[delta.songKey] = {
    plays: prev.plays + 1,
    bestScore: Math.max(prev.bestScore, delta.finalScore),
    bestCombo: Math.max(prev.bestCombo, delta.maxCombo),
    bestAccuracy: Math.max(prev.bestAccuracy, delta.accuracy),
    lastPlayedAt: Date.now(),
  };

  // Timestamps + streak. currentDailyStreak bumps when yesterday is in
  // the recorded set; otherwise resets to 1. Bounded to 365 days so the
  // list can't grow forever.
  const now = Date.now();
  s.lastPlayAt = now;
  if (s.firstPlayAt === null) s.firstPlayAt = now;
  const isoToday = new Date(now).toISOString().slice(0, 10);
  if (!s.daysPlayedISO.includes(isoToday)) {
    s.daysPlayedISO.push(isoToday);
    const yDate = new Date(now);
    yDate.setUTCDate(yDate.getUTCDate() - 1);
    const isoYesterday = yDate.toISOString().slice(0, 10);
    s.currentDailyStreak = s.daysPlayedISO.includes(isoYesterday)
      ? (s.currentDailyStreak || 0) + 1
      : 1;
    if (s.currentDailyStreak > s.longestDailyStreak) {
      s.longestDailyStreak = s.currentDailyStreak;
    }
    if (s.daysPlayedISO.length > 365) {
      s.daysPlayedISO.sort();
      s.daysPlayedISO.splice(0, s.daysPlayedISO.length - 365);
    }
  }

  await save(redis, player);
  return c.json({ ok: true, state: player });
});

/** POST /api/state/tutorial-step — body: { step: TutorialStepId | null }.
 *  Persists the resume index for the tutorial. Called by the orchestrator
 *  on every step advance and by the skip / complete paths (with null).
 *  Returns the updated PlayerState so the client can stay in sync without
 *  a follow-up GET. */
state.post('/tutorial-step', async (c) => {
  const body = (await c.req.json()) as { step: TutorialStepId | null };
  const username = await currentUsername();
  const player = await loadOrInit(redis, username);
  player.tutorialStep = body.step;
  await save(redis, player);
  return c.json({ state: player });
});

/** POST /api/tutorial/seed-starter-cat — body: { breed }.
 *  Tutorial's pick-cat step calls this with the player's choice. Server:
 *    1. If the player doesn't already own an instance of `breed`, mint
 *       one (id + default name from catalog) and append to ownedCats.
 *    2. Seat that instance in seat-center.
 *    3. Clear any other seats so the lone starter cat is the only one
 *       on stage (DEV mode's pre-seeded 3 cats get unseated; their
 *       instances stay in ownedCats so DEV swaps still work — only the
 *       seatedCats map changes).
 *  Returns the updated PlayerState. */
state.post('/tutorial/seed-starter-cat', async (c) => {
  const { breed } = (await c.req.json()) as { breed: CatBreed };
  const username = await currentUsername();
  const player = await loadOrInit(redis, username);

  // 1. Find or create an instance of the picked breed.
  let instance = player.ownedCats.find((c) => c.breed === breed);
  if (!instance) {
    const catalogEntry = CAT_CATALOG.find((e) => e.id === breed);
    if (!catalogEntry) {
      return c.json({ ok: false, reason: 'unknown_breed' }, 400);
    }
    instance = {
      id: makeInstanceId(),
      breed,
      name: catalogEntry.name,
    };
    player.ownedCats.push(instance);
  }

  // 2. Seat in center; 3. clear the others.
  player.seatedCats = { 'seat-center': instance.id };

  await save(redis, player);
  return c.json({ ok: true, state: player });
});

/** POST /api/house/theme — body: { themeId }. */
state.post('/house/theme', async (c) => {
  const { themeId } = (await c.req.json()) as { themeId: ThemeId };
  const username = await currentUsername();
  const player = await loadOrInit(redis, username);
  if (!player.house.ownedThemes.includes(themeId)) {
    return c.json({ ok: false, reason: 'theme_not_owned' }, 400);
  }
  player.house.themeId = themeId;
  await save(redis, player);
  return c.json({ ok: true, state: player });
});

/** POST /api/house/seat — body: { seatId, catInstanceId | null }.
 * Pass null catInstanceId to unseat. */
state.post('/house/seat', async (c) => {
  const { seatId, catInstanceId } = (await c.req.json()) as {
    seatId: SeatId;
    catInstanceId: string | null;
  };
  const username = await currentUsername();
  const player = await loadOrInit(redis, username);
  if (catInstanceId === null) {
    delete player.seatedCats[seatId];
  } else {
    const catInstance = player.ownedCats.find((cat) => cat.id === catInstanceId);
    if (!catInstance) {
      return c.json({ ok: false, reason: 'cat_not_owned' }, 400);
    }
    player.seatedCats[seatId] = catInstanceId;
  }
  await save(redis, player);
  return c.json({ ok: true, state: player });
});

/** POST /inventory/sell — { kind: 'cosmetic', cosmeticInstanceId } */
state.post('/inventory/sell', async (c) => {
  const { cosmeticInstanceId } = await c.req.json() as {
    kind: 'cosmetic';
    cosmeticInstanceId: string;
  };
  const player = await loadOrInit(redis, await currentUsername());

  const cosmeticIndex = player.ownedCosmetics.findIndex((cos) => cos.id === cosmeticInstanceId);
  if (cosmeticIndex === -1) {
    return c.json({ ok: false, reason: 'cosmetic_not_owned' }, 400);
  }

  player.ownedCosmetics.splice(cosmeticIndex, 1);

  const SELL_PRICE = 25;
  player.coins += SELL_PRICE;
  // Stats — sold cosmetics count toward lifetime earned like any other
  // coin gain. No matching "cosmeticsSold" counter yet; add one when
  // there's a quest that needs it.
  player.stats.coinsEarnedLifetime += SELL_PRICE;

  await save(redis, player);
  return c.json({ ok: true, state: player });
});

/** POST /api/background/set — body: { backgroundId }.
 * Sets the player's active background. Must be owned. */
state.post('/background/set', async (c) => {
  const { backgroundId } = (await c.req.json()) as { backgroundId: BackgroundId };
  if (!(backgroundId in BACKGROUND_CATALOG)) {
    return c.json({ ok: false, reason: 'unknown_background' }, 400);
  }
  const username = await currentUsername();
  const player = await loadOrInit(redis, username);
  if (!player.ownedBackgrounds.includes(backgroundId)) {
    return c.json({ ok: false, reason: 'background_not_owned' }, 400);
  }
  player.activeBackground = backgroundId;
  await save(redis, player);
  return c.json({ state: player });
});

/** POST /cats/rehome — { catInstanceId } */
state.post('/cats/rehome', async (c) => {
  const { catInstanceId } = await c.req.json() as { catInstanceId: string };
  const player = await loadOrInit(redis, await currentUsername());

  if (!player.equippedCosmeticTypes) player.equippedCosmeticTypes = {};

  const catIndex = player.ownedCats.findIndex((cat) => cat.id === catInstanceId);
  if (catIndex === -1) {
    return c.json({ ok: false, reason: 'cat_not_owned' }, 400);
  }

  // Unseat if seated.
  for (const [seatId, seatedInstanceId] of Object.entries(player.seatedCats)) {
    if (seatedInstanceId === catInstanceId) delete player.seatedCats[seatId];
  }

  // Return any equipped cosmetics to inventory.
  const equippedSlots = player.equippedCosmetics[catInstanceId];
  if (equippedSlots) {
    for (const cosInstanceId of Object.values(equippedSlots)) {
      if (!cosInstanceId) continue;
      const cosType = player.equippedCosmeticTypes[cosInstanceId] as CosmeticId | undefined;
      player.ownedCosmetics.push({
        id: cosInstanceId,
        type: cosType ?? cosInstanceId as CosmeticId,
      });
      delete player.equippedCosmeticTypes[cosInstanceId];
    }
    delete player.equippedCosmetics[catInstanceId];
  }

  player.ownedCats.splice(catIndex, 1);

  await save(redis, player);
  return c.json({ ok: true, state: player });
});

/** POST /api/cats/rename — body: { catInstanceId, name }. */
state.post('/cats/rename', async (c) => {
  const { catInstanceId, name } = await c.req.json() as { catInstanceId: string; name: string };
  const username = await currentUsername();
  const player = await loadOrInit(redis, username);
  const cat = player.ownedCats.find((x) => x.id === catInstanceId);
  if (!cat) return c.json({ ok: false, reason: 'not_owned' }, 400);
  cat.name = String(name).slice(0, 20).trim() || cat.name;
  await save(redis, player);
  return c.json({ ok: true, state: player });
});
