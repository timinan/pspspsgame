import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadOrInit,
  save,
  type RedisLike,
} from '../src/server/core/player-state';
import { STARTER_COINS, createFreshPlayerState } from '../src/shared/state';

class FakeRedis implements RedisLike {
  private store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  size(): number {
    return this.store.size;
  }
}

describe('player-state', () => {
  let redis: FakeRedis;
  beforeEach(() => {
    redis = new FakeRedis();
  });

  it('initializes a fresh user with starter coins, empty collections and onboardingDone=false', async () => {
    const state = await loadOrInit(redis, 'alice');
    expect(state.username).toBe('alice');
    expect(state.coins).toBe(STARTER_COINS);
    expect(state.ownedCats).toEqual([]);
    expect(state.ownedCosmetics).toEqual([]);
    expect(state.equippedCosmetics).toEqual({});
    expect(state.bestScore).toBe(0);
    expect(state.onboardingDone).toBe(false);
    expect(state.updatedAt).toBeGreaterThan(0);
  });

  it('round-trips a saved state', async () => {
    const initial = await loadOrInit(redis, 'alice');
    initial.coins = 250;
    initial.ownedCats = ['cat1', 'cat4'];
    initial.ownedCosmetics = ['c9'];
    initial.equippedCosmetics = { cat1: 'c9' };
    initial.bestScore = 4200;
    initial.onboardingDone = true;
    await save(redis, initial);

    const reloaded = await loadOrInit(redis, 'alice');
    expect(reloaded.coins).toBe(250);
    expect(reloaded.ownedCats).toEqual(['cat1', 'cat4']);
    expect(reloaded.ownedCosmetics).toEqual(['c9']);
    expect(reloaded.equippedCosmetics).toEqual({ cat1: 'c9' });
    expect(reloaded.bestScore).toBe(4200);
    expect(reloaded.onboardingDone).toBe(true);
  });

  it('writes updatedAt on every save', async () => {
    const initial = await loadOrInit(redis, 'alice');
    const t0 = initial.updatedAt;
    // Force a delay so the timestamp comparison is meaningful
    await new Promise((r) => setTimeout(r, 5));
    initial.coins = 999;
    await save(redis, initial);
    expect(initial.updatedAt).toBeGreaterThan(t0);
  });

  it('keeps two different usernames isolated', async () => {
    const a = await loadOrInit(redis, 'alice');
    a.coins = 100;
    await save(redis, a);
    const b = await loadOrInit(redis, 'bob');
    expect(b.coins).toBe(STARTER_COINS);
    expect(redis.size()).toBe(2);
  });

  it('treats malformed JSON in redis as a fresh user', async () => {
    await redis.set('pspsps:state:carol', 'this-is-not-json');
    const state = await loadOrInit(redis, 'carol');
    expect(state.coins).toBe(STARTER_COINS);
    expect(state.onboardingDone).toBe(false);
  });

  it('backfills new fields onto an older stored state', async () => {
    // Simulate a state saved before equippedCosmetics existed.
    await redis.set(
      'pspsps:state:dave',
      JSON.stringify({
        username: 'dave',
        coins: 42,
        ownedCats: ['cat1'],
        ownedCosmetics: [],
        // equippedCosmetics intentionally omitted
        bestScore: 100,
        onboardingDone: true,
        updatedAt: 1,
      }),
    );
    const state = await loadOrInit(redis, 'dave');
    expect(state.coins).toBe(42);
    expect(state.equippedCosmetics).toEqual({});
  });
});

describe('PlayerState.house', () => {
  it('house has decorations map keyed by SlotId', () => {
    const fresh = createFreshPlayerState();
    expect(fresh.house).toBeDefined();
    expect(fresh.house.decorations).toBeDefined();
    expect(typeof fresh.house.decorations).toBe('object');
  });

  it('house has themeId defaulting to "default"', () => {
    const fresh = createFreshPlayerState();
    expect(fresh.house.themeId).toBe('default');
  });

  it('house starts with empty slot map', () => {
    const fresh = createFreshPlayerState();
    expect(Object.keys(fresh.house.decorations).length).toBe(0);
  });

  it('house has ownedDecorations and ownedThemes arrays starting empty', () => {
    const fresh = createFreshPlayerState();
    expect(Array.isArray(fresh.house.ownedDecorations)).toBe(true);
    expect(fresh.house.ownedDecorations.length).toBe(0);
    expect(Array.isArray(fresh.house.ownedThemes)).toBe(true);
    expect(fresh.house.ownedThemes).toEqual(['default']);
  });
});
