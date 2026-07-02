// tests/economy-state.test.ts
import { describe, expect, it } from 'vitest';
import { createFreshEconomy, createFreshPlayerState, rolloverEconomy } from '../src/shared/state';

describe('economy state', () => {
  it('fresh player carries a zeroed economy block', () => {
    const p = createFreshPlayerState('tim');
    expect(p.economy.pendingCollect).toBe(0);
    expect(p.economy.daily.playIncome).toBe(0);
    expect(p.economy.streak.count).toBe(0);
    expect(p.stats.playsOnOwnShow).toBe(0);
  });

  it('rollover resets daily counters on a new day but keeps the pot', () => {
    const p = createFreshPlayerState('tim');
    p.economy.daily = { ...createFreshEconomy('2026-07-01').daily, playIncome: 900, chartPlays: { t3_abc: 2 } };
    p.economy.pendingCollect = 240;
    rolloverEconomy(p, '2026-07-02');
    expect(p.economy.daily.day).toBe('2026-07-02');
    expect(p.economy.daily.playIncome).toBe(0);
    expect(p.economy.daily.chartPlays).toEqual({});
    expect(p.economy.pendingCollect).toBe(240);
  });

  it('rollover is a no-op on the same day', () => {
    const p = createFreshPlayerState('tim');
    p.economy.daily.day = '2026-07-01';
    p.economy.daily.playIncome = 500;
    rolloverEconomy(p, '2026-07-01');
    expect(p.economy.daily.playIncome).toBe(500);
  });
});
