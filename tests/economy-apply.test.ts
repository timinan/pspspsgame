// tests/economy-apply.test.ts
import { describe, expect, it } from 'vitest';
import { applyPlayReward } from '../src/shared/economy-apply';
import { ECONOMY, type PlayRewardBreakdown } from '../src/shared/economy';
import { createFreshPlayerState } from '../src/shared/state';

function makeBreakdown(overrides: Partial<PlayRewardBreakdown> = {}): PlayRewardBreakdown {
  return {
    tier: 'great',
    tierBase: 200,
    skillBonus: 0,
    fullCombo: false,
    fullPerfect: false,
    multiplier: 1.0,
    decayRate: 1,
    budgetReduced: false,
    ownShow: false,
    final: 200,
    ...overrides,
  };
}

const TODAY = '2026-07-01';
const YESTERDAY = '2026-06-30';
const STARTER = 600; // STARTER_COINS

describe('applyPlayReward', () => {
  it('credits visitor coins and updates daily counters', () => {
    const visitor = createFreshPlayerState('alice');
    visitor.economy.daily.day = TODAY;
    const owner = createFreshPlayerState('bob');
    owner.economy.daily.day = TODAY;
    const breakdown = makeBreakdown({ final: 100 });

    const { royalty } = applyPlayReward(visitor, owner, breakdown, 'post1', TODAY);

    expect(visitor.coins).toBe(STARTER + 100);
    expect(visitor.stats.coinsEarnedLifetime).toBe(100);
    expect(visitor.economy.daily.playIncome).toBe(100);
    expect(visitor.economy.daily.chartPlays['post1']).toBe(1);
    expect(royalty).toBe(Math.floor(100 * ECONOMY.hostRoyaltyRate)); // 25
  });

  it('increments chartPlays counter so 2nd play registers correctly', () => {
    const visitor = createFreshPlayerState('alice');
    visitor.economy.daily.day = TODAY;
    const owner = createFreshPlayerState('bob');
    owner.economy.daily.day = TODAY;

    applyPlayReward(visitor, owner, makeBreakdown({ final: 200 }), 'post1', TODAY);
    expect(visitor.economy.daily.chartPlays['post1']).toBe(1);

    applyPlayReward(visitor, owner, makeBreakdown({ final: 100, decayRate: 0.5 }), 'post1', TODAY);
    expect(visitor.economy.daily.chartPlays['post1']).toBe(2);
    expect(visitor.coins).toBe(STARTER + 200 + 100);
  });

  it('own-show: increments playsOnOwnShow, no coins, royalty 0', () => {
    const player = createFreshPlayerState('alice');
    player.economy.daily.day = TODAY;
    const breakdown = makeBreakdown({ final: 0, ownShow: true });

    const { royalty } = applyPlayReward(player, player, breakdown, 'post1', TODAY);

    expect(player.coins).toBe(STARTER); // unchanged
    expect(player.stats.playsOnOwnShow).toBe(1);
    expect(royalty).toBe(0);
  });

  it('royalty is floor(final × 0.25) credited to the owner COLLECT pot, not coins', () => {
    const visitor = createFreshPlayerState('alice');
    visitor.economy.daily.day = TODAY;
    const owner = createFreshPlayerState('bob');
    owner.economy.daily.day = TODAY;

    const { royalty } = applyPlayReward(visitor, owner, makeBreakdown({ final: 100 }), 'post1', TODAY);

    expect(royalty).toBe(25); // floor(100 × 0.25)
    expect(owner.economy.pendingCollect).toBe(25);
    expect(owner.coins).toBe(STARTER); // coins move at collect time, not here
    expect(owner.economy.daily.hostPotAccrued).toBe(25);
  });

  it('royalty capped by remaining daily pot — 290+25→10 boundary', () => {
    const visitor = createFreshPlayerState('alice');
    visitor.economy.daily.day = TODAY;
    const owner = createFreshPlayerState('bob');
    owner.economy.daily.day = TODAY;
    owner.economy.daily.hostPotAccrued = 290; // 10 left in the 300 cap

    const { royalty } = applyPlayReward(visitor, owner, makeBreakdown({ final: 100 }), 'post1', TODAY);

    expect(royalty).toBe(10); // min(floor(100×0.25)=25, 300-290=10)
    expect(owner.economy.daily.hostPotAccrued).toBe(300);
  });

  it('rolls over stale economy daily for visitor', () => {
    const visitor = createFreshPlayerState('alice');
    visitor.economy.daily.day = YESTERDAY;
    visitor.economy.daily.playIncome = 500;
    visitor.economy.daily.chartPlays = { post1: 2 };

    const owner = createFreshPlayerState('bob');
    owner.economy.daily.day = TODAY;

    applyPlayReward(visitor, owner, makeBreakdown({ final: 100 }), 'post1', TODAY);

    // Daily block reset to today then this play credited
    expect(visitor.economy.daily.day).toBe(TODAY);
    expect(visitor.economy.daily.playIncome).toBe(100); // fresh + this play
    expect(visitor.economy.daily.chartPlays['post1']).toBe(1); // reset then +1
  });

  it('rolls over stale economy daily for owner', () => {
    const visitor = createFreshPlayerState('alice');
    visitor.economy.daily.day = TODAY;

    const owner = createFreshPlayerState('bob');
    owner.economy.daily.day = YESTERDAY;
    owner.economy.daily.hostPotAccrued = 200; // stale — should be wiped

    applyPlayReward(visitor, owner, makeBreakdown({ final: 100 }), 'post1', TODAY);

    expect(owner.economy.daily.day).toBe(TODAY);
    expect(owner.economy.daily.hostPotAccrued).toBe(25); // fresh start + royalty only
  });
});
