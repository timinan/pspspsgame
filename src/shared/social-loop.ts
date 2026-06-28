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

/** ONE comment posted as an auto-reply under the post's bot-pinned
 *  root on every play. Replaces what was previously two separate
 *  comments (root-level free-text from the visitor + nested stats
 *  reply) — Tim's call: "there should be only 1 new post added under
 *  the mod post... if they do post a comment what their comment
 *  should look like... stats... tipped x gold or gifted gifts... then
 *  their comment at the bottom".
 *
 *  Layout (compact, score+accuracy only — Tim: "thats it"):
 *    🏆 **I completed this show!**   (or ❌ **I didn't pass this show**)
 *    🎯 Score: **X** · ✨ Accuracy: Y%
 *    🎁 Tipped Z gold   (only if gift in summary)
 *    > [player's typed text]   (only if freeText)
 */
export function formatStatsComment(
  summary: PlaySummary,
  freeText: string = '',
): string {
  const passed = summary.tier !== 'fail';
  const headerLabel = passed ? '🏆 I completed this show!' : '❌ I didn\'t pass this show';
  const accPct = Math.round(summary.accuracy * 100);
  // Stats line uses italics + horizontal rule above to read as a small
  // footer below the player's typed text — Tim: "the comment text
  // should be the big text on top and the stats line smaller at the
  // bottom". Reddit markdown lacks a true "smaller font" but italics
  // after an hr is the conventional "footer caption" pattern.
  const statsLine = `*${headerLabel} · 🎯 Score: ${summary.score.toLocaleString()} · ✨ Accuracy: ${accPct}%*`;
  const giftStr = summary.gift
    ? [
        summary.gift.coins > 0 ? `Tipped ${summary.gift.coins.toLocaleString()} gold` : '',
        summary.gift.itemInstanceIds.length > 0
          ? `Gifted ${summary.gift.itemInstanceIds.length} cosmetic${summary.gift.itemInstanceIds.length === 1 ? '' : 's'}`
          : '',
      ].filter((s) => s.length > 0).join(' · ')
    : '';
  const giftLine = giftStr.length > 0 ? `*🎁 ${giftStr}*` : '';
  const trimmedText = freeText.trim();
  if (trimmedText.length === 0) {
    // SKIP path — no free text. Just the stats, full strength (drop
    // italics + leading hr since there's nothing to be secondary to).
    const skipHeader = `**${headerLabel}**`;
    const skipStats = `🎯 Score: **${summary.score.toLocaleString()}** · ✨ Accuracy: ${accPct}%`;
    return [skipHeader, skipStats, giftLine.replace(/\*/g, '')].filter((s) => s.length > 0).join('\n\n');
  }
  // POST path — player text big on top, horizontal rule, italic
  // stats + gift as a footer-style caption underneath.
  return [trimmedText, '---', statsLine, giftLine]
    .filter((s) => s.length > 0)
    .join('\n\n');
}

/** Stats payload for the per-post pinned mod comment. Server reads
 *  everything Redis-side and passes a structured object to the
 *  formatter — keeps the markdown shape in one place (testable from
 *  shared) and the data fetches in routes. */
export interface PinnedSummaryStats {
  ownerUsername: string;
  difficulty: string | null;
  songTitle: string | null;
  totalPlays: number;
  passCount: number;
  combinedScore: number;
  /** Highest-PB entry on the leaderboard, INCLUDING the owner. Owner
   *  is the default top until a non-owner beats them. `isCreator` is
   *  set true when topPlayer.username === ownerUsername so the
   *  formatter can render '(creator)' beside their name. */
  topPlayer: { username: string; score: number; isCreator: boolean } | null;
  /** First non-owner visitor who passed — null until a non-owner
   *  passes. Owner self-passes never qualify. */
  firstPasser: string | null;
}

/** Markdown body for the per-post pinned mod comment. Rendered + posted
 *  via reddit.submitComment(runAs:APP) at publish; re-rendered + edited
 *  via Comment.edit() on every play. Owner-friendly degradation —
 *  topPlayer / firstPasser fall back to '—' when only the owner has
 *  played, so the format stays consistent through the post's lifecycle. */
export function formatPinnedSummary(s: PinnedSummaryStats): string {
  const diffEmoji: Record<string, string> = {
    easy: '🟢',
    medium: '🟡',
    spicy: '🟠',
    hard: '🔴',
    insane: '💀',
  };
  const diffLabel = s.difficulty
    ? `${diffEmoji[s.difficulty] ?? '⭐'} ${s.difficulty.toUpperCase()}`
    : '';
  const songLine = s.songTitle ? ` · 🎵 ${s.songTitle}` : '';
  const passPct = s.totalPlays > 0
    ? Math.round((s.passCount / s.totalPlays) * 100)
    : 0;
  const topLine = s.topPlayer
    ? `🥇 Top player: u/${s.topPlayer.username}${s.topPlayer.isCreator ? ' (creator)' : ''} — **${s.topPlayer.score.toLocaleString()}**`
    : '🥇 Top player: —';
  const firstLine = s.firstPasser
    ? `🐱 First pass: u/${s.firstPasser}`
    : '🐱 First pass: —';
  return (
    `🏆 **u/${s.ownerUsername}'s show**${diffLabel ? ' · ' + diffLabel : ''}${songLine}\n\n` +
    `📊 **${s.totalPlays.toLocaleString()} plays** · ✅ ${s.passCount.toLocaleString()} passes (${passPct}%)\n` +
    `🎯 Combined score: **${s.combinedScore.toLocaleString()}**\n\n` +
    `${topLine}\n` +
    `${firstLine}\n\n` +
    `*Tap the post above to play. Stats refresh after every run.*`
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
