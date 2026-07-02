import { describe, expect, it } from 'vitest';
import { createFreshPlayerState } from '../src/shared/state';
import {
  ACHIEVEMENTS, ACHIEVEMENT_TIER_REWARDS, achievementClaimError, achievementProgress, tierReached, tierThreshold,
} from '../src/shared/achievements';

describe('defs table', () => {
  it('locked launch set: 10 defs, thresholds ascending', () => {
    expect(ACHIEVEMENTS.map(a => a.id)).toEqual(['songs','perfects','cats','streak','crowd','hopper','combo','pockets','boxes','holds']);
    for (const a of ACHIEVEMENTS) expect(a.thresholds[0] < a.thresholds[1] && a.thresholds[1] < a.thresholds[2]).toBe(true);
  });
  it('locked tier rewards', () => {
    expect(ACHIEVEMENT_TIER_REWARDS.bronze).toEqual({ coins: 100 });
    expect(ACHIEVEMENT_TIER_REWARDS.silver).toEqual({ boxTier: 'golden' });
    expect(ACHIEVEMENT_TIER_REWARDS.gold).toEqual({ boxTier: 'mythic' });
  });
});

describe('achievementProgress', () => {
  it('reads live stats (computed, not counted)', () => {
    const p = createFreshPlayerState('tim');
    p.stats.songsFinished = 42;
    p.stats.boxesOpened = { catBox: 2, cosmeticBoxGolden: 3 };
    expect(achievementProgress(p, 'songs')).toBe(42);
    expect(achievementProgress(p, 'boxes')).toBe(5);
    expect(achievementProgress(p, 'cats')).toBe(p.ownedCats.length);
  });
});

describe('tierReached / tierThreshold', () => {
  const songs = ACHIEVEMENTS.find(a => a.id === 'songs')!;
  it('boundaries', () => {
    expect(tierReached(9, songs)).toBeNull();
    expect(tierReached(10, songs)).toBe('bronze');
    expect(tierReached(100, songs)).toBe('silver');
    expect(tierReached(1000, songs)).toBe('gold');
    expect(tierThreshold(songs, 'silver')).toBe(100);
  });
});

describe('achievementClaimError', () => {
  it('validates def, tier, progress, dupes, and box tier before mutation', () => {
    const p = createFreshPlayerState('tim');
    p.stats.songsFinished = 150; // bronze + silver reached
    expect(achievementClaimError(p, 'nope', 'bronze', undefined)).toBe('unknown_achievement');
    expect(achievementClaimError(p, 'songs', 'platinum', undefined)).toBe('unknown_tier');
    expect(achievementClaimError(p, 'songs', 'gold', 'mythic')).toBe('not_reached');
    expect(achievementClaimError(p, 'songs', 'bronze', undefined)).toBeNull();     // bronze needs no box
    expect(achievementClaimError(p, 'songs', 'silver', undefined)).toBe('wrong_box_tier');
    expect(achievementClaimError(p, 'songs', 'silver', 'standard')).toBe('wrong_box_tier');
    expect(achievementClaimError(p, 'songs', 'silver', 'golden')).toBeNull();
    p.economy.achievementsClaimed.songs = ['silver'];
    expect(achievementClaimError(p, 'songs', 'silver', 'golden')).toBe('already_claimed');
    expect(achievementClaimError(p, 'songs', 'bronze', undefined)).toBeNull();      // any order
  });
});
