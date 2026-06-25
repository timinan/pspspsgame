import { describe, it, expect } from 'vitest';
import {
  classifyScore,
  rewardWithComment,
  buildCommentBody,
  formatGift,
  SCORE_TIER_THRESHOLDS,
  LEADERBOARD_MIN_ACCURACY,
  FAIL_BASE_REWARD,
  COMMENT_REWARD_MULTIPLIER,
  GIFT_COIN_PRESETS,
  INBOX_MAX_EVENTS,
  LEADERBOARD_TOP_N,
  type PlaySummary,
} from '../src/shared/social-loop';

describe('social-loop / classifyScore', () => {
  it('returns fail tier for runs below the leaderboard min', () => {
    const res = classifyScore(0.50, false);
    expect(res.tier).toBe('fail');
    expect(res.baseReward).toBe(FAIL_BASE_REWARD);
  });

  it('returns pass tier for runs at exactly 0.75', () => {
    const res = classifyScore(0.75, true);
    expect(res.tier).toBe('great');
    expect(res.baseReward).toBe(200);
  });

  it('returns great tier for 80%', () => {
    const res = classifyScore(0.80, true);
    expect(res.tier).toBe('great');
    expect(res.baseReward).toBe(200);
  });

  it('returns perfect tier for 95%', () => {
    const res = classifyScore(0.95, true);
    expect(res.tier).toBe('perfect');
    expect(res.baseReward).toBe(300);
  });

  it('returns flawless tier for 100%', () => {
    const res = classifyScore(1.0, true);
    expect(res.tier).toBe('flawless');
    expect(res.baseReward).toBe(400);
  });

  it('respects passed=false override even at high accuracy (e.g. abandoned mid-run)', () => {
    const res = classifyScore(0.85, false);
    expect(res.tier).toBe('fail');
    expect(res.baseReward).toBe(FAIL_BASE_REWARD);
  });
});

describe('social-loop / rewardWithComment', () => {
  it('doubles the base reward when comment posted', () => {
    expect(rewardWithComment(100, true)).toBe(200);
    expect(rewardWithComment(300, true)).toBe(600);
  });

  it('returns base unchanged when comment skipped', () => {
    expect(rewardWithComment(100, false)).toBe(100);
    expect(rewardWithComment(400, false)).toBe(400);
  });

  it('uses the locked multiplier constant', () => {
    expect(COMMENT_REWARD_MULTIPLIER).toBe(2);
  });
});

describe('social-loop / buildCommentBody', () => {
  const baseSummary: PlaySummary = {
    visitor: 'tim',
    owner: 'alice',
    postId: 't3_abc',
    score: 12500,
    totalNotes: 100,
    notesHit: 87,
    maxCombo: 42,
    accuracy: 0.87,
    passed: true,
    tier: 'great',
    baseReward: 200,
  };

  it('includes score, accuracy %, notes hit, combo', () => {
    const body = buildCommentBody(baseSummary);
    expect(body).toContain('12,500');
    expect(body).toContain('87%');
    expect(body).toContain('87 / 100');
    expect(body).toContain('Combo: 42');
    expect(body).toContain('GREAT');
  });

  it('marks fails differently from passes', () => {
    const body = buildCommentBody({ ...baseSummary, tier: 'fail', passed: false });
    expect(body).toContain("DIDN'T PASS");
  });

  it('omits gift line when no gift sent', () => {
    const body = buildCommentBody(baseSummary);
    expect(body).not.toContain('gifted');
  });

  it('adds gift line when gift attached', () => {
    const body = buildCommentBody({
      ...baseSummary,
      gift: { coins: 100, itemInstanceIds: ['cos-1'] },
    });
    expect(body).toContain('🎁 gifted');
    expect(body).toContain('100 coins');
    expect(body).toContain('alice');
  });

  it('prepends free-text above the stats block', () => {
    const body = buildCommentBody(baseSummary, 'nice chart!');
    expect(body.indexOf('nice chart!')).toBeLessThan(body.indexOf('Score:'));
  });

  it('skips free-text divider when free-text is empty/whitespace', () => {
    const body = buildCommentBody(baseSummary, '   ');
    expect(body).not.toContain('---');
    expect(body.startsWith('Score:')).toBe(true);
  });
});

describe('social-loop / formatGift', () => {
  it('formats coin-only gift', () => {
    expect(formatGift({ coins: 250, itemInstanceIds: [] })).toBe('250 coins');
  });

  it('formats item-only gift singular', () => {
    expect(formatGift({ coins: 0, itemInstanceIds: ['a'] })).toBe('1 cosmetic');
  });

  it('formats item-only gift plural', () => {
    expect(formatGift({ coins: 0, itemInstanceIds: ['a', 'b', 'c'] })).toBe('3 cosmetics');
  });

  it('formats coins + items combined', () => {
    expect(formatGift({ coins: 100, itemInstanceIds: ['a', 'b'] })).toBe('100 coins + 2 cosmetics');
  });

  it('falls back to hi! for empty gift (defensive)', () => {
    expect(formatGift({ coins: 0, itemInstanceIds: [] })).toBe('a hi!');
  });
});

describe('social-loop / constants', () => {
  it('exposes the locked thresholds in descending order', () => {
    let lastMin = Infinity;
    for (const t of SCORE_TIER_THRESHOLDS) {
      expect(t.minAccuracy).toBeLessThanOrEqual(lastMin);
      lastMin = t.minAccuracy;
    }
  });

  it('thresholds map to 100/200/300/400 reward bucket', () => {
    expect(SCORE_TIER_THRESHOLDS.find((t) => t.tier === 'pass')?.baseReward).toBe(100);
    expect(SCORE_TIER_THRESHOLDS.find((t) => t.tier === 'great')?.baseReward).toBe(200);
    expect(SCORE_TIER_THRESHOLDS.find((t) => t.tier === 'perfect')?.baseReward).toBe(300);
    expect(SCORE_TIER_THRESHOLDS.find((t) => t.tier === 'flawless')?.baseReward).toBe(400);
  });

  it('leaderboard cap + inbox cap match the locked values', () => {
    expect(LEADERBOARD_TOP_N).toBe(10);
    expect(INBOX_MAX_EVENTS).toBe(100);
    expect(LEADERBOARD_MIN_ACCURACY).toBe(0.75);
  });

  it('GIFT_COIN_PRESETS are the expected 50/200/500 chips', () => {
    expect([...GIFT_COIN_PRESETS]).toEqual([50, 200, 500]);
  });
});
