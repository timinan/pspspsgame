import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchState,
  openBox,
  syncCoins,
  equipCosmetic,
  completeOnboarding,
  setTheme,
  setSeat,
  sellItem,
  rehomeCat,
  renameCat,
  saveChart,
  loadChart,
} from '@/services/state-client';
import type { PlayerState, Chart } from '@/../shared/state';
import { emptyChart } from '@/../shared/state';

function makeState(): Partial<PlayerState> {
  return {
    username: 'alice',
    coins: 100,
    ownedCats: [{ id: 'inst-1', breed: 'cat1', name: 'Mochi' }],
    ownedCosmetics: [],
    equippedCosmetics: {},
    equippedCosmeticTypes: {},
    bestScore: 0,
    onboardingDone: false,
    updatedAt: 1,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('state-client', () => {
  it('fetchState pulls /api/state and unwraps { state }', async () => {
    const state = makeState();
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ state }),
    });
    vi.stubGlobal('fetch', spy);

    const result = await fetchState();
    expect(spy).toHaveBeenCalledWith('/api/state');
    expect(result).toEqual(state);
  });

  it('openBox POSTs the boxId and returns the server response', async () => {
    const state = makeState();
    const pull = {
      kind: 'cat' as const,
      itemId: 'cat4',
      rarity: 'uncommon' as const,
      duplicate: false,
      refundCoins: 0,
      instanceId: 'new-inst-abc',
    };
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, pull, state }),
    });
    vi.stubGlobal('fetch', spy);

    const result = await openBox('catBox');
    expect(spy).toHaveBeenCalledWith(
      '/api/box/open',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ boxId: 'catBox' }),
      }),
    );
    expect(result).toEqual({ ok: true, pull, state });
  });

  it('syncCoins POSTs the delta + optional bestScore and returns the new state', async () => {
    const state = makeState();
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ state }),
    });
    vi.stubGlobal('fetch', spy);

    await syncCoins(50, 4200);
    expect(spy).toHaveBeenCalledWith(
      '/api/coins/sync',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ coinsDelta: 50, bestScore: 4200 }),
      }),
    );
  });

  it('equipCosmetic POSTs the catInstanceId + cosmeticInstanceId', async () => {
    const state = makeState();
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, state }),
    });
    vi.stubGlobal('fetch', spy);

    await equipCosmetic('inst-1', 'head', 'cos-inst-9');
    expect(spy).toHaveBeenCalledWith(
      '/api/cosmetic/equip',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ catInstanceId: 'inst-1', slot: 'head', cosmeticInstanceId: 'cos-inst-9' }),
      }),
    );
  });

  it('equipCosmetic sends cosmeticInstanceId: null when unequipping', async () => {
    const state = makeState();
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, state }),
    });
    vi.stubGlobal('fetch', spy);

    await equipCosmetic('inst-1', 'head', null);
    expect(spy).toHaveBeenCalledWith(
      '/api/cosmetic/equip',
      expect.objectContaining({
        body: JSON.stringify({ catInstanceId: 'inst-1', slot: 'head', cosmeticInstanceId: null }),
      }),
    );
  });

  it('completeOnboarding POSTs to /api/onboarding/complete with no body', async () => {
    const state = makeState();
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ state }),
    });
    vi.stubGlobal('fetch', spy);

    await completeOnboarding();
    expect(spy).toHaveBeenCalledWith(
      '/api/onboarding/complete',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('setTheme POSTs the themeId and returns the new state', async () => {
    const state = makeState();
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ state }),
    });
    vi.stubGlobal('fetch', spy);

    await setTheme('cozy');
    expect(spy).toHaveBeenCalledWith(
      '/api/house/theme',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ themeId: 'cozy' }),
      }),
    );
  });
});

describe('state-client house-editor operations', () => {
  it('setSeat POSTs catInstanceId (not breed)', async () => {
    const state = makeState();
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ state }),
    });
    vi.stubGlobal('fetch', spy);

    await setSeat('seat-left', 'inst-1');
    expect(spy).toHaveBeenCalledWith(
      '/api/house/seat',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ seatId: 'seat-left', catInstanceId: 'inst-1' }),
      }),
    );
  });

  it('setSeat POSTs null catInstanceId to unseat', async () => {
    const state = makeState();
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ state }),
    });
    vi.stubGlobal('fetch', spy);

    await setSeat('seat-left', null);
    expect(spy).toHaveBeenCalledWith(
      '/api/house/seat',
      expect.objectContaining({
        body: JSON.stringify({ seatId: 'seat-left', catInstanceId: null }),
      }),
    );
  });

  it('sellItem POSTs cosmeticInstanceId', async () => {
    const state = makeState();
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ state }),
    });
    vi.stubGlobal('fetch', spy);

    await sellItem('cosmetic', 'cos-inst-7');
    expect(spy).toHaveBeenCalledWith(
      '/api/inventory/sell',
      expect.objectContaining({
        body: JSON.stringify({ kind: 'cosmetic', cosmeticInstanceId: 'cos-inst-7' }),
      }),
    );
  });

  it('rehomeCat POSTs catInstanceId', async () => {
    const state = makeState();
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ state }),
    });
    vi.stubGlobal('fetch', spy);

    await rehomeCat('inst-1');
    expect(spy).toHaveBeenCalledWith(
      '/api/cats/rehome',
      expect.objectContaining({
        body: JSON.stringify({ catInstanceId: 'inst-1' }),
      }),
    );
  });

  it('renameCat POSTs catInstanceId + name', async () => {
    const state = makeState();
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, state }),
    });
    vi.stubGlobal('fetch', spy);

    await renameCat('inst-1', 'Fluffy');
    expect(spy).toHaveBeenCalledWith(
      '/api/cats/rename',
      expect.objectContaining({
        body: JSON.stringify({ catInstanceId: 'inst-1', name: 'Fluffy' }),
      }),
    );
  });

  it('exposes setSeat', () => {
    expect(typeof setSeat).toBe('function');
  });

  it('exposes sellItem', () => {
    expect(typeof sellItem).toBe('function');
  });

  it('exposes rehomeCat', () => {
    expect(typeof rehomeCat).toBe('function');
  });
});

describe('state-client chart operations', () => {
  it('saveChart POSTs to /api/chart/save', async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', spy);

    const c = emptyChart('alice', 'x');
    await saveChart(c);

    expect(spy).toHaveBeenCalledWith(
      '/api/chart/save',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('loadChart fetches /api/chart with author', async () => {
    const chart: Chart = {
      authorId: 'bob',
      title: 'test',
      stepCount: 8,
      bpm: 120,
      steps: [],
      updatedAt: 1,
    };
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(chart),
    });
    vi.stubGlobal('fetch', spy);

    const c = await loadChart('bob');

    expect(spy).toHaveBeenCalledWith('/api/chart?author=bob');
    expect(c.authorId).toBe('bob');
  });
});
