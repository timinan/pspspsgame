import { Hono } from 'hono';
import { redis, reddit } from '@devvit/web/server';
import { loadOrInit, resetState, save } from '../core/player-state';
import { pullBox, applyPullToState } from '../core/box-pull';
import {
  BACKGROUND_CATALOG,
  BOX_CATALOG,
  type BackgroundId,
  type BoxId,
  type ThemeId,
  type SeatId,
  type CosmeticId,
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
  player.coins = Math.max(0, player.coins + Math.floor(coinsDelta));
  if (bestScore !== undefined && bestScore > player.bestScore) {
    player.bestScore = bestScore;
  }
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
  await save(redis, player);
  return c.json({ state: player });
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
