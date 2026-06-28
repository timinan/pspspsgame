/**
 * Shared types + pure functions for the social loop spec (locked
 * 2026-06-25). Everything here is dependency-free so it can be reused
 * from server endpoints, client UI, and tests.
 *
 * The social loop:
 *   1. Visitor opens a post → sees host's stage + leaderboard + PLAY button
 *   2. Visitor plays the host's chart → end of round
 *   3. Reward screen shows the tier + base coins
 *   4. Comment composition (pre-filled stats + editable free-text)
 *      OPTIONAL: post comment → rewards DOUBLE
 *   5. Optional gift (coins + items) flows from visitor → host
 *   6. Owner's inbox accumulates the play event (always, pass or fail)
 *   7. Leaderboard shows top 10 passing runs (≥75% accuracy) per post
 */

import type { LaneId } from './state';

// -- Score tier classification ----------------------------------------

export type ScoreTier = 'pass' | 'great' | 'perfect' | 'flawless';

/** Locked thresholds — same shape as `passAccuracyPct` in Balance, but
 *  with finer-grained tiers for reward bucketing. Tim's rule:
 *  rewards are 100 / 200 / 300 / 400 — linear, no big leaps. */
export const SCORE_TIER_THRESHOLDS: ReadonlyArray<{ tier: ScoreTier; minAccuracy: number; baseReward: number }> = [
  { tier: 'flawless', minAccuracy: 0.99, baseReward: 400 },
  { tier: 'perfect',  minAccuracy: 0.90, baseReward: 300 },
  { tier: 'great',    minAccuracy: 0.75, baseReward: 200 },
  { tier: 'pass',     minAccuracy: 0.0,  baseReward: 100 },
];

/** Minimum accuracy required to land on a leaderboard. Matches the
 *  rehearsal pass gate (Balance.passAccuracyPct / 100). */
export const LEADERBOARD_MIN_ACCURACY = 0.75;

/** Base reward (pre-comment-multiplier) for a fail run that ended early
 *  or hit < pass threshold. Always shown so the player doesn't feel
 *  punished for trying — small pity payout. */
export const FAIL_BASE_REWARD = 25;

/** Multiplier applied when the player posts the auto-stats comment. */
export const COMMENT_REWARD_MULTIPLIER = 2;

/** Classify a run's accuracy into a tier + base coin amount. accuracy
 *  is a 0..1 fraction (NOT percent). Returns 'pass' as the floor for
 *  any passing run; fails (below LEADERBOARD_MIN_ACCURACY) get the
 *  pity payout but no tier. */
export function classifyScore(accuracy: number, passed: boolean): {
  tier: ScoreTier | 'fail';
  baseReward: number;
} {
  if (!passed) return { tier: 'fail', baseReward: FAIL_BASE_REWARD };
  for (const entry of SCORE_TIER_THRESHOLDS) {
    if (accuracy >= entry.minAccuracy) {
      return { tier: entry.tier, baseReward: entry.baseReward };
    }
  }
  return { tier: 'pass', baseReward: 100 };
}

/** Compute final reward given base + whether the comment was posted. */
export function rewardWithComment(baseReward: number, commentPosted: boolean): number {
  return commentPosted ? baseReward * COMMENT_REWARD_MULTIPLIER : baseReward;
}

// -- Play summary (what each play produces) ---------------------------

export interface PlaySummary {
  /** Visitor's Reddit username (the one who played). */
  visitor: string;
  /** Reddit username of the post owner whose chart was played. */
  owner: string;
  /** Devvit post id this play happened on. */
  postId: string;
  /** Score number (combo-aware total, same number the leaderboard sorts by). */
  score: number;
  /** Total notes the chart had (taps + holds + slides + slide-returns).
   *  Comment template + tier classifier both read this for "X / Y notes". */
  totalNotes: number;
  /** Notes the player landed (perfect + great, not misses). */
  notesHit: number;
  /** Highest combo achieved during the round. */
  maxCombo: number;
  /** Round accuracy as a 0..1 fraction. */
  accuracy: number;
  /** True if accuracy >= LEADERBOARD_MIN_ACCURACY. */
  passed: boolean;
  /** Tier classification — see classifyScore(). */
  tier: ScoreTier | 'fail';
  /** Coins the visitor earns BEFORE comment multiplier. */
  baseReward: number;
  /** Optional gift the visitor sent the owner along with the play. */
  gift?: GiftPayload;
}

// -- Comment template builder -----------------------------------------

/** Build the pre-filled comment body the visitor posts back to the
 *  Reddit post. Stats block is RIGID (always the same shape so the
 *  prize-hook auto-data surface stays uniform). Optional `freeText`
 *  is the visitor's own line above the stats. Empty string is fine —
 *  one-tap commit without typing is the friction-free default. */
export function buildCommentBody(summary: PlaySummary, freeText: string = ''): string {
  const tierLabel = summary.tier === 'fail' ? '❌ DIDN\'T PASS' : `🐱 ${summary.tier.toUpperCase()}`;
  const accPct = Math.round(summary.accuracy * 100);
  const giftLine = summary.gift
    ? `🎁 gifted ${formatGift(summary.gift)} to u/${summary.owner}\n`
    : '';
  const stats =
    `Score: **${summary.score.toLocaleString()}** — ${tierLabel}\n` +
    `${summary.notesHit} / ${summary.totalNotes} notes (${accPct}% accuracy)\n` +
    `Combo: ${summary.maxCombo}\n` +
    giftLine +
    `\n*Played via Meowcert · /r/meowcert_dev*`;
  return freeText.trim().length > 0
    ? `${freeText.trim()}\n\n---\n\n${stats}`
    : stats;
}

/** Markdown stats block posted as an auto-reply under the post's
 *  bot-pinned root comment on every play. Distinct from
 *  buildCommentBody (which is the free-text + stats body of the
 *  visitor's root-level comment). Format mirrors the Nuzzle convention
 *  Tim referenced — table-style for clean alignment under a stickied
 *  thread, headline emoji + tier badge so it scans fast in a feed. */
export function formatStatsComment(
  summary: PlaySummary,
  rank: number | null,
  totalPlayers: number,
): string {
  const tierLabel = summary.tier === 'fail' ? 'DIDN\'T PASS' : summary.tier.toUpperCase();
  const accPct = Math.round(summary.accuracy * 100);
  const rankCell = rank != null && totalPlayers > 0
    ? `#${rank} of ${totalPlayers}`
    : '—';
  return (
    `🏆 **I played this show!**\n\n` +
    `| Stat | Value |\n` +
    `|---|---|\n` +
    `| 🎯 Score | **${summary.score.toLocaleString()}** |\n` +
    `| ✨ Accuracy | ${accPct}% |\n` +
    `| 🔥 Max Combo | x${summary.maxCombo} |\n` +
    `| 🏅 Tier | ${tierLabel} |\n` +
    `| 📊 Rank | ${rankCell} |\n`
  );
}

// -- Gift payload + transfer model ------------------------------------

export interface GiftPayload {
  /** Coins moved visitor → owner. 0 if just an item gift. */
  coins: number;
  /** Optional cosmetic item instance ids the visitor is giving away.
   *  Must be in visitor's ownedCosmetics or it's rejected. */
  itemInstanceIds: string[];
}

/** Friendly summary used inside the comment template. */
export function formatGift(g: GiftPayload): string {
  const parts: string[] = [];
  if (g.coins > 0) parts.push(`${g.coins.toLocaleString()} coins`);
  if (g.itemInstanceIds.length === 1) parts.push('1 cosmetic');
  else if (g.itemInstanceIds.length > 1) parts.push(`${g.itemInstanceIds.length} cosmetics`);
  if (parts.length === 0) return 'a hi!';
  return parts.join(' + ');
}

/** Suggested coin preset chips for the gift slider UI. */
export const GIFT_COIN_PRESETS: readonly number[] = [50, 200, 500];
/** Slider min / max for the gift coin input. */
export const GIFT_COIN_MIN = 0;
export const GIFT_COIN_MAX = 5000;

// -- Leaderboard entry ------------------------------------------------

export interface LeaderboardEntry {
  visitor: string;
  score: number;
  accuracy: number;
  /** ms-since-epoch when the score was submitted. */
  playedAt: number;
}

/** Maximum top-N rows shown in the public leaderboard widget. */
export const LEADERBOARD_TOP_N = 10;

// -- Inbox event ------------------------------------------------------

export type InboxEventKind =
  | 'play'           // someone played your chart
  | 'gift_received'  // someone sent you a gift
  | 'comment_posted'; // someone commented (visitor used the 2x bonus path)

export interface InboxEvent {
  /** Stable id within the owner's inbox stream (Date.now() + rng nonce). */
  id: string;
  kind: InboxEventKind;
  /** ms-since-epoch when the event happened. */
  at: number;
  /** Visitor whose action produced this event. */
  visitor: string;
  /** Devvit post id this happened on. */
  postId: string;
  /** Summary blob for the inbox UI to render. Shape depends on kind. */
  data: PlayEventData | GiftEventData | CommentEventData;
  /** Set true after the owner has seen the event in their inbox UI. */
  seen?: boolean;
}

export interface PlayEventData {
  score: number;
  accuracy: number;
  tier: ScoreTier | 'fail';
  passed: boolean;
}

export interface GiftEventData {
  coins: number;
  itemCount: number;
}

export interface CommentEventData {
  /** Truncated preview (first ~100 chars) of the comment body. */
  preview: string;
}

/** Max inbox events kept per owner — older events scroll off the bottom. */
export const INBOX_MAX_EVENTS = 100;

// -- Lane → meow stem affinity (for future use) -----------------------

/** Convenience re-export — keeps social-loop self-contained without
 *  consumers needing to import from state.ts for the LaneId type
 *  inside InboxEvent extensions. */
export type { LaneId };
