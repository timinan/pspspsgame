import type { PlayerState } from '../../shared/state';
import { STARTER_COINS } from '../../shared/state';

/**
 * Minimal interface to Redis — the only operations player-state needs.
 * Devvit's `redis` import from '@devvit/web/server' satisfies this, and
 * tests pass an in-memory mock with the same shape.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}

const KEY = (username: string): string => `pspsps:state:${username}`;

/**
 * Reads the player's persisted state from Redis, or initializes a fresh
 * one with STARTER_COINS if there's no record yet. Any keys missing from
 * an older stored state get filled in with the fresh-state defaults
 * (forward-compatibility for state schema additions).
 */
export async function loadOrInit(
  redis: RedisLike,
  username: string,
): Promise<PlayerState> {
  const raw = await redis.get(KEY(username));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<PlayerState>;
      return { ...freshState(username), ...parsed };
    } catch {
      // Corrupt JSON in Redis — fall back to a clean init so the user
      // isn't blocked.
    }
  }
  // Fresh user — initialize AND persist so we don't keep handing out
  // STARTER_COINS on every page reload.
  const fresh = freshState(username);
  await save(redis, fresh);
  return fresh;
}

function freshState(username: string): PlayerState {
  return {
    username,
    coins: STARTER_COINS,
    ownedCats: [],
    ownedCosmetics: [],
    equippedCosmetics: {},
    bestScore: 0,
    onboardingDone: false,
    updatedAt: Date.now(),
  };
}

/** Persist the given state back to Redis, stamping a fresh updatedAt. */
export async function save(redis: RedisLike, state: PlayerState): Promise<void> {
  state.updatedAt = Date.now();
  await redis.set(KEY(state.username), JSON.stringify(state));
}
