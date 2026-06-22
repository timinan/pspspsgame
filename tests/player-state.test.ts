import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadOrInit,
  save,
  type RedisLike,
} from '../src/server/core/player-state';
import { STARTER_COINS, createFreshPlayerState, type SeatId } from '../src/shared/state';

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

  it('initializes a fresh user with starter coins, three seated cats, and onboardingDone=true', async () => {
    const state = await loadOrInit(redis, 'alice');
    expect(state.username).toBe('alice');
    expect(state.coins).toBe(STARTER_COINS);
    // Fresh state auto-grants three starter cats (cat1/cat2/cat3) and seats
    // them so the player lands in Decorate with a complete house. Welcome
    // tutorial is skipped via onboardingDone: true.
    expect(state.ownedCats).toHaveLength(3);
    expect(state.ownedCats.map((c) => c.breed)).toEqual(['cat1', 'cat2', 'cat3']);
    expect(Object.keys(state.seatedCats)).toHaveLength(3);
    // Auto-grants one of each EFFECT cosmetic for immediate DressingRoom testing.
    expect(state.ownedCosmetics.length).toBeGreaterThan(0);
    expect(state.ownedCosmetics.every((c) => c.type.startsWith('effect-'))).toBe(true);
    expect(state.equippedCosmetics).toEqual({});
    expect(state.equippedCosmeticTypes).toEqual({});
    expect(state.bestScore).toBe(0);
    expect(state.onboardingDone).toBe(true);
    expect(state.updatedAt).toBeGreaterThan(0);
  });

  it('round-trips a saved state', async () => {
    const initial = await loadOrInit(redis, 'alice');
    initial.coins = 250;
    initial.ownedCats = [
      { id: 'inst-1', breed: 'cat1', name: 'Mochi' },
      { id: 'inst-2', breed: 'cat4', name: 'Cloud' },
    ];
    initial.ownedCosmetics = [{ id: 'cos-inst-1', type: 'c9' }];
    initial.equippedCosmetics = { 'inst-1': { head: 'cos-inst-1' } };
    initial.equippedCosmeticTypes = { 'cos-inst-1': 'c9' };
    initial.bestScore = 4200;
    initial.onboardingDone = true;
    await save(redis, initial);

    const reloaded = await loadOrInit(redis, 'alice');
    expect(reloaded.coins).toBe(250);
    expect(reloaded.ownedCats).toHaveLength(2);
    expect(reloaded.ownedCats[0]!.breed).toBe('cat1');
    expect(reloaded.ownedCats[0]!.name).toBe('Mochi');
    expect(reloaded.ownedCosmetics).toHaveLength(1);
    expect(reloaded.ownedCosmetics[0]!.type).toBe('c9');
    expect(reloaded.equippedCosmetics).toEqual({ 'inst-1': { head: 'cos-inst-1' } });
    expect(reloaded.equippedCosmeticTypes).toEqual({ 'cos-inst-1': 'c9' });
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
    // Fresh users skip onboarding and land in Decorate immediately.
    expect(state.onboardingDone).toBe(true);
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
  it('house has themeId defaulting to "default"', () => {
    const fresh = createFreshPlayerState();
    expect(fresh.house.themeId).toBe('default');
  });

  it('house has ownedThemes array starting with default', () => {
    const fresh = createFreshPlayerState();
    expect(Array.isArray(fresh.house.ownedThemes)).toBe(true);
    expect(fresh.house.ownedThemes).toEqual(['default']);
  });
});

describe('PlayerState.chart + backgrounds', () => {
  it('fresh state has a 32-step chart at 120 bpm', () => {
    const fresh = createFreshPlayerState('alice');
    expect(fresh.chart).toBeDefined();
    expect(fresh.chart.stepCount).toBe(32);
    expect(fresh.chart.bpm).toBe(120);
    expect(fresh.chart.steps).toHaveLength(32);
  });

  it('fresh state owns every catalog background and starts on default', () => {
    // DEV: fresh state currently grants all backgrounds so playtests can
    // swap freely without grinding the background box. The active one is
    // still 'default'. Revert to ['default'] before shipping.
    const fresh = createFreshPlayerState();
    expect(fresh.ownedBackgrounds).toContain('default');
    expect(fresh.ownedBackgrounds.length).toBeGreaterThan(1);
    expect(fresh.activeBackground).toBe('default');
  });
});

describe('PlayerState.seatedCats', () => {
  it('SeatId is a string', () => {
    const id: SeatId = 'seat-left';
    expect(typeof id).toBe('string');
  });

  it('fresh state seats three starter cats by default', () => {
    const fresh = createFreshPlayerState();
    expect(fresh.seatedCats).toBeDefined();
    expect(typeof fresh.seatedCats).toBe('object');
    expect(Object.keys(fresh.seatedCats).sort()).toEqual([
      'seat-center',
      'seat-left',
      'seat-right',
    ]);
    // Each seated value points to an actual owned cat instance.
    const ownedIds = new Set(fresh.ownedCats.map((c) => c.id));
    for (const id of Object.values(fresh.seatedCats)) {
      expect(ownedIds.has(id!)).toBe(true);
    }
  });

  it('seatedCats key is SeatId and value is a cat instance id string', () => {
    const fresh = createFreshPlayerState();
    fresh.seatedCats['seat-left'] = 'some-instance-id-123';
    expect(fresh.seatedCats['seat-left']).toBe('some-instance-id-123');
  });
});
