import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchState,
  openBox,
  syncCoins,
  equipCosmetic,
  completeOnboarding,
  setDecorationInSlot,
  setTheme,
} from '@/services/state-client';
import type { PlayerState } from '@/../shared/state';

function makeState(): PlayerState {
  return {
    username: 'alice',
    coins: 100,
    ownedCats: ['cat1'],
    ownedCosmetics: [],
    equippedCosmetics: {},
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
      itemId: 'cat4' as const,
      rarity: 'uncommon' as const,
      duplicate: false,
      refundCoins: 0,
    };
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, pull, state }),
    });
    vi.stubGlobal('fetch', spy);

    const result = await openBox('catCrate');
    expect(spy).toHaveBeenCalledWith(
      '/api/box/open',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ boxId: 'catCrate' }),
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

  it('equipCosmetic POSTs the breed + cosmeticId', async () => {
    const state = makeState();
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, state }),
    });
    vi.stubGlobal('fetch', spy);

    await equipCosmetic('cat1', 'c9');
    expect(spy).toHaveBeenCalledWith(
      '/api/cosmetic/equip',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ breed: 'cat1', cosmeticId: 'c9' }),
      }),
    );
  });

  it('equipCosmetic sends cosmeticId: null when unequipping', async () => {
    const state = makeState();
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, state }),
    });
    vi.stubGlobal('fetch', spy);

    await equipCosmetic('cat1', null);
    expect(spy).toHaveBeenCalledWith(
      '/api/cosmetic/equip',
      expect.objectContaining({
        body: JSON.stringify({ breed: 'cat1', cosmeticId: null }),
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

  it('setDecorationInSlot POSTs the slotId + decorationId and returns the new state', async () => {
    const state = makeState();
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ state }),
    });
    vi.stubGlobal('fetch', spy);

    await setDecorationInSlot('slot-1', 'dec-5');
    expect(spy).toHaveBeenCalledWith(
      '/api/house/decoration',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ slotId: 'slot-1', decorationId: 'dec-5' }),
      }),
    );
  });

  it('setDecorationInSlot sends decorationId: null when removing', async () => {
    const state = makeState();
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ state }),
    });
    vi.stubGlobal('fetch', spy);

    await setDecorationInSlot('slot-1', null);
    expect(spy).toHaveBeenCalledWith(
      '/api/house/decoration',
      expect.objectContaining({
        body: JSON.stringify({ slotId: 'slot-1', decorationId: null }),
      }),
    );
  });

  it('setTheme POSTs the themeId and returns the new state', async () => {
    const state = makeState();
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ state }),
    });
    vi.stubGlobal('fetch', spy);

    await setTheme('theme-forest');
    expect(spy).toHaveBeenCalledWith(
      '/api/house/theme',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ themeId: 'theme-forest' }),
      }),
    );
  });
});
