import type { PlayerState } from '../../shared/state';
import { CAT_CATALOG, createFreshPlayerState, createFreshStats, rolloverEconomy, rolloverWeekly } from '../../shared/state';
import { isoWeekOf } from '../../shared/quests';

/**
 * Minimal interface to Redis — the only operations player-state needs.
 * Devvit's `redis` import from '@devvit/web/server' returns
 * `string | undefined` from get(), so we accept either null or undefined
 * for the "no entry" case.
 */
export interface RedisLike {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string): Promise<unknown>;
}

const KEY = (username: string): string => `meowcert:state:${username}`;

/** Returns today's date as a YYYY-MM-DD UTC string. */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Mutates state to reset daily economy counters when the calendar date has
 * advanced.  Delegates to `rolloverEconomy` from the shared module.
 */
function applyDailyRollover(state: PlayerState): PlayerState {
  const today = todayISO();
  rolloverEconomy(state, today);
  rolloverWeekly(state, isoWeekOf(today));
  return state;
}

/**
 * Reads the player's persisted state from Redis, or initializes a fresh
 * one with STARTER_COINS if there's no record yet. Any keys missing from
 * an older stored state get filled in with the fresh-state defaults
 * (forward-compatibility for state schema additions).
 *
 * Also applies a daily rollover: if the stored economy counters belong to a
 * previous calendar day they are reset to zero before the state is returned.
 */
export async function loadOrInit(
  redis: RedisLike,
  username: string,
): Promise<PlayerState> {
  const raw = await redis.get(KEY(username));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<PlayerState>;
      const fresh = freshState(username);
      // Deep-merge PlayerStats so old saves get any newly-added counter
      // filled with its zero-default on next load. Top-level fields
      // still fall through the shallow spread — PlayerStats is the only
      // sub-shape that grows regularly, and shallow-spreading it would
      // lose defaults for fields not present in the stored JSON.
      const stats = { ...fresh.stats, ...(parsed.stats ?? createFreshStats()) };
      // Three-level merge for EconomyState: top-level, daily, and streak sub-shapes
      // each get their own spread so new fields in any sub-shape are backfilled
      // from fresh defaults on old saves.
      const economy = parsed.economy
        ? {
            ...fresh.economy,
            ...parsed.economy,
            daily: { ...fresh.economy.daily, ...parsed.economy.daily },
            streak: { ...fresh.economy.streak, ...parsed.economy.streak },
            weekly: { ...fresh.economy.weekly, ...parsed.economy.weekly },
          }
        : fresh.economy;
      const merged: PlayerState = { ...fresh, ...parsed, stats, economy };
      return applyDailyRollover(pruneRetiredBreeds(merged));
    } catch {
      // Corrupt JSON in Redis — fall back to a clean init so the user
      // isn't blocked.
    }
  }
  // Fresh user — initialize AND persist so we don't keep handing out
  // STARTER_COINS on every page reload.
  const fresh = applyDailyRollover(freshState(username));
  await save(redis, fresh);
  return fresh;
}

/**
 * Drops cats whose breed no longer exists in the catalog (2026-07-01
 * roster cleanup renumbered/deleted breeds — old saves reference ids
 * like 'cat80' or 'rainbow' that would render as missing-texture
 * placeholders). Unseats the removed instances and clears their
 * equipment maps so downstream code never sees an unknown breed.
 */
function pruneRetiredBreeds(state: PlayerState): PlayerState {
  const known = new Set(CAT_CATALOG.map((c) => c.id));
  const removed = new Set(
    state.ownedCats.filter((c) => !known.has(c.breed)).map((c) => c.id),
  );
  if (removed.size === 0) return state;
  state.ownedCats = state.ownedCats.filter((c) => !removed.has(c.id));
  for (const [seat, instanceId] of Object.entries(state.seatedCats)) {
    if (instanceId && removed.has(instanceId)) {
      delete state.seatedCats[seat as keyof typeof state.seatedCats];
    }
  }
  for (const instanceId of Object.keys(state.equippedCosmetics)) {
    if (removed.has(instanceId)) delete state.equippedCosmetics[instanceId];
  }
  for (const instanceId of Object.keys(state.equippedCosmeticTypes)) {
    if (removed.has(instanceId)) delete state.equippedCosmeticTypes[instanceId];
  }
  return state;
}

function freshState(username: string): PlayerState {
  const fresh = createFreshPlayerState(username);
  fresh.updatedAt = Date.now();
  return fresh;
}

/**
 * Force-wipe the player's state and re-initialize a fresh one. Used by
 * the GET /state route while DEV_RESET_ON_LOAD is on so testers can
 * re-run onboarding without manually clearing Redis.
 */
export async function resetState(
  redis: RedisLike,
  username: string,
  startingCoins: number,
): Promise<PlayerState> {
  const fresh: PlayerState = { ...freshState(username), coins: startingCoins };
  await save(redis, fresh);
  return fresh;
}

/** Persist the given state back to Redis, stamping a fresh updatedAt. */
export async function save(redis: RedisLike, state: PlayerState): Promise<void> {
  state.updatedAt = Date.now();
  await redis.set(KEY(state.username), JSON.stringify(state));
}
