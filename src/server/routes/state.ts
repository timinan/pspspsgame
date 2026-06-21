import { Hono } from 'hono';
import { redis, reddit } from '@devvit/web/server';
import { loadOrInit, resetState, save } from '../core/player-state';
import { pullBox, applyPullToState } from '../core/box-pull';
import {
  BOX_CATALOG,
  type BoxId,
  type CatBreed,
  type CosmeticId,
  type DecorationId,
  type SlotId,
  type ThemeId,
  type SeatId,
} from '../../shared/state';

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
  if (player.coins < box.cost) {
    return c.json({ ok: false, reason: 'insufficient_coins' }, 400);
  }
  player.coins -= box.cost;
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

/** POST /api/cosmetic/equip — body: { breed, cosmeticId | null }. */
state.post('/cosmetic/equip', async (c) => {
  const { breed, cosmeticId } = (await c.req.json()) as {
    breed: CatBreed;
    cosmeticId: CosmeticId | null;
  };
  const username = await currentUsername();
  const player = await loadOrInit(redis, username);
  if (!player.ownedCats.includes(breed)) {
    return c.json({ ok: false, reason: 'cat_not_owned' }, 400);
  }
  if (cosmeticId !== null && !player.ownedCosmetics.includes(cosmeticId)) {
    return c.json({ ok: false, reason: 'cosmetic_not_owned' }, 400);
  }
  if (cosmeticId === null) {
    delete player.equippedCosmetics[breed];
  } else {
    player.equippedCosmetics[breed] = cosmeticId;
  }
  await save(redis, player);
  return c.json({ ok: true, state: player });
});

/** POST /api/onboarding/complete — flips onboardingDone=true. */
state.post('/onboarding/complete', async (c) => {
  const username = await currentUsername();
  const player = await loadOrInit(redis, username);
  player.onboardingDone = true;
  await save(redis, player);
  return c.json({ state: player });
});

/** POST /api/house/decoration — body: { slotId, decorationId | null }.
 * Pass null decorationId to clear the slot. */
state.post('/house/decoration', async (c) => {
  const { slotId, decorationId } = (await c.req.json()) as {
    slotId: SlotId;
    decorationId: DecorationId | null;
  };
  const username = await currentUsername();
  const player = await loadOrInit(redis, username);
  if (decorationId === null) {
    delete player.house.decorations[slotId];
  } else {
    if (!player.house.ownedDecorations.includes(decorationId)) {
      return c.json({ ok: false, reason: 'decoration_not_owned' }, 400);
    }
    player.house.decorations[slotId] = decorationId;
  }
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

/** POST /api/house/seat — body: { seatId, catId | null }.
 * Pass null catId to unseat the cat. */
state.post('/house/seat', async (c) => {
  const { seatId, catId } = (await c.req.json()) as { seatId: SeatId; catId: CatBreed | null };
  const username = await currentUsername();
  const player = await loadOrInit(redis, username);
  if (catId === null) {
    delete player.seatedCats[seatId];
  } else {
    if (!player.ownedCats.includes(catId)) {
      return c.json({ ok: false, reason: 'cat_not_owned' }, 400);
    }
    player.seatedCats[seatId] = catId;
  }
  await save(redis, player);
  return c.json({ ok: true, state: player });
});
