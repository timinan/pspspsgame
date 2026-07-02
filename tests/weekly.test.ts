import { describe, expect, it } from 'vitest';
import { createFreshPlayerState, rolloverWeekly } from '../src/shared/state';
import {
  WEEKLY_QUEST_POOL, WEEKLY_BONUS_COINS, isoWeekOf, recordWeeklyEvent,
  weeklyClaimError, weeklyBonusError,
} from '../src/shared/quests';

describe('isoWeekOf', () => {
  it('matches the spec example', () => expect(isoWeekOf('2026-07-02')).toBe('2026-W27'));
  it('weeks start Monday 00:00 UTC', () => {
    expect(isoWeekOf('2026-06-28')).toBe('2026-W26'); // Sunday
    expect(isoWeekOf('2026-06-29')).toBe('2026-W27'); // Monday
  });
  it('handles the ISO year boundary', () => {
    expect(isoWeekOf('2025-12-29')).toBe('2026-W01'); // Mon of week containing Jan 1 (a Thursday)
    expect(isoWeekOf('2026-01-01')).toBe('2026-W01');
  });
});

describe('weekly pool', () => {
  it('locked launch set', () => {
    expect(WEEKLY_QUEST_POOL.map(q => [q.id, q.target, q.coins])).toEqual([
      ['wplays15', 15, 100], ['whardpass5', 5, 150], ['whostplays25', 25, 150],
    ]);
    expect(WEEKLY_BONUS_COINS).toBe(500);
  });
});

describe('rolloverWeekly', () => {
  it('resets progress/claims on a new week, no-op same week', () => {
    const p = createFreshPlayerState('tim');
    p.economy.weekly = { weekKey: '2026-W26', progress: { wplays15: 9 }, claimed: { whardpass5: true }, bonusClaimed: true };
    rolloverWeekly(p, '2026-W26');
    expect(p.economy.weekly.progress.wplays15).toBe(9);
    rolloverWeekly(p, '2026-W27');
    expect(p.economy.weekly).toEqual({ weekKey: '2026-W27', progress: {}, claimed: {}, bonusClaimed: false });
  });
});

describe('recordWeeklyEvent', () => {
  const W = '2026-W27';
  it('play increments wplays15 and clamps at target', () => {
    const p = createFreshPlayerState('tim');
    for (let i = 0; i < 20; i++) recordWeeklyEvent(p, { kind: 'play', passed: false, difficulty: 'easy' }, W);
    expect(p.economy.weekly.progress.wplays15).toBe(15);
  });
  it('hard+insane passes count toward whardpass5; hard fails and easy passes do not', () => {
    const p = createFreshPlayerState('tim');
    recordWeeklyEvent(p, { kind: 'play', passed: true, difficulty: 'hard' }, W);
    recordWeeklyEvent(p, { kind: 'play', passed: true, difficulty: 'insane' }, W);
    recordWeeklyEvent(p, { kind: 'play', passed: false, difficulty: 'hard' }, W);
    recordWeeklyEvent(p, { kind: 'play', passed: true, difficulty: 'easy' }, W);
    expect(p.economy.weekly.progress.whardpass5).toBe(2);
  });
  it('hostplay increments whostplays25', () => {
    const p = createFreshPlayerState('tim');
    recordWeeklyEvent(p, { kind: 'hostplay' }, W);
    expect(p.economy.weekly.progress.whostplays25).toBe(1);
  });
  it('claimed quests stop accumulating and stale weekKey rolls over first', () => {
    const p = createFreshPlayerState('tim');
    p.economy.weekly = { weekKey: '2026-W26', progress: { wplays15: 14 }, claimed: {}, bonusClaimed: false };
    recordWeeklyEvent(p, { kind: 'play', passed: false, difficulty: 'easy' }, W);
    expect(p.economy.weekly.weekKey).toBe(W);
    expect(p.economy.weekly.progress.wplays15).toBe(1); // rolled, then counted
    p.economy.weekly.claimed.wplays15 = true;
    recordWeeklyEvent(p, { kind: 'play', passed: false, difficulty: 'easy' }, W);
    expect(p.economy.weekly.progress.wplays15).toBe(1);
  });
});

describe('claim validators', () => {
  const done = { weekKey: '2026-W27', progress: { wplays15: 15, whardpass5: 5, whostplays25: 25 }, claimed: {} as Record<string, boolean>, bonusClaimed: false };
  it('weeklyClaimError paths', () => {
    expect(weeklyClaimError(done, 'nope', 'golden')).toBe('unknown_quest');
    expect(weeklyClaimError(done, 'wplays15', 'standard')).toBe('not_golden_box');
    expect(weeklyClaimError(done, 'wplays15', undefined)).toBe('not_golden_box');
    expect(weeklyClaimError({ ...done, progress: { wplays15: 3 } }, 'wplays15', 'golden')).toBe('not_complete');
    expect(weeklyClaimError({ ...done, claimed: { wplays15: true } }, 'wplays15', 'golden')).toBe('already_claimed');
    expect(weeklyClaimError(done, 'wplays15', 'golden')).toBeNull();
  });
  it('weeklyBonusError paths', () => {
    expect(weeklyBonusError(done, 'golden')).toBe('quests_incomplete');
    const allClaimed = { ...done, claimed: { wplays15: true, whardpass5: true, whostplays25: true } };
    expect(weeklyBonusError(allClaimed, 'mythic')).toBe('not_golden_box');
    expect(weeklyBonusError({ ...allClaimed, bonusClaimed: true }, 'golden')).toBe('already_claimed');
    expect(weeklyBonusError(allClaimed, 'golden')).toBeNull();
  });
});
