/**
 * Client-side wrappers for /api/social/* — typed fetch helpers used by
 * the Game scene, the comment modal, the inbox modal, and the gift
 * modal. All return Promises with explicit `ok` flags so callers can
 * fall back on UI errors without try/catch noise.
 */

import type {
  InboxEvent,
  LeaderboardEntry,
  ScoreTier,
} from '../../shared/social-loop';
import type { Difficulty, PlayRewardBreakdown } from '../../shared/economy';

interface SubmitPlayArgs {
  postId: string;
  owner: string;
  score: number;
  totalNotes: number;
  notesHit: number;
  maxCombo: number;
  accuracy: number;
  /** Free-text portion of the comment if the player posted one. The
   *  server only checks for non-empty; comment text body is built
   *  client-side via buildCommentBody() before reaching here. */
  commentBody?: string;
  gift?: { coins: number; itemInstanceIds: string[] };
  /** Perfect-grade hit count this round (feeds skill-bonus scoring). */
  perfects?: number;
  /** Missed notes this round (gates full-combo / full-perfect bonuses). */
  misses?: number;
  /** Chart difficulty — drives the reward multiplier server-side. */
  difficulty?: Difficulty;
  /** Idempotency + credit token. When present the server credits coins
   *  once for this token and returns the reward `breakdown` + `royalty`.
   *  Absent = legacy submit (leaderboard/inbox only, no coin credit). */
  playToken?: string;
}

export interface SubmitPlayResult {
  ok: true;
  tier: ScoreTier | 'fail';
  baseReward: number;
  passed: boolean;
  /** Present only when a `playToken` was sent — the full coin-reward
   *  breakdown the summary UI renders (tier base, bonuses, decay,
   *  budget, own-show). */
  breakdown?: PlayRewardBreakdown;
  /** Coins routed to the host's pending-collect pot for this play. */
  royalty?: number;
  /** True when this token was already credited (repeat submit) — the
   *  breakdown still reflects the original award. */
  alreadyCredited?: boolean;
}

export async function submitPlay(args: SubmitPlayArgs): Promise<SubmitPlayResult | { ok: false; reason: string }> {
  const r = await fetch('/api/social/play', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!r.ok) return { ok: false, reason: `submitPlay ${r.status}` };
  return (await r.json()) as SubmitPlayResult;
}

/** Args for POST /api/social/comment — fired by page-2 POST/SKIP to
 *  post the auto-stats reply under the mod-pinned root. Distinct from
 *  submitPlay (which only persists). */
export interface SubmitCommentArgs {
  postId: string;
  owner: string;
  summary: PlaySummary;
  /** Visitor's free-text. Empty / omitted = SKIP path (stats only). */
  commentBody?: string;
}

export async function submitComment(args: SubmitCommentArgs): Promise<{ ok: true; posted: boolean; commentBonus?: number } | { ok: false; reason: string }> {
  const r = await fetch('/api/social/comment', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!r.ok) return { ok: false, reason: `submitComment ${r.status}` };
  return (await r.json()) as { ok: true; posted: boolean; commentBonus?: number };
}

export interface FetchLeaderboardResult {
  ok: true;
  top: LeaderboardEntry[];
  yourRank: number | null;
  yourScore: number | null;
  yourAccuracy: number | null;
  /** Total play submissions for this post (NOT unique players —
   *  same player playing 100 times = 100, even though the leaderboard
   *  only stores their PB). */
  totalPlays: number;
}

export async function fetchLeaderboard(postId: string): Promise<FetchLeaderboardResult | { ok: false; reason: string }> {
  const r = await fetch(`/api/social/leaderboard?postId=${encodeURIComponent(postId)}`);
  if (!r.ok) return { ok: false, reason: `fetchLeaderboard ${r.status}` };
  return (await r.json()) as FetchLeaderboardResult;
}

export interface FetchInboxResult {
  ok: true;
  events: InboxEvent[];
}

export async function fetchInbox(): Promise<FetchInboxResult | { ok: false; reason: string }> {
  const r = await fetch('/api/social/inbox');
  if (!r.ok) return { ok: false, reason: `fetchInbox ${r.status}` };
  return (await r.json()) as FetchInboxResult;
}

export async function markInboxRead(): Promise<{ ok: boolean }> {
  const r = await fetch('/api/social/inbox/mark-read', { method: 'POST' });
  return { ok: r.ok };
}

interface SendGiftArgs {
  postId: string;
  owner: string;
  coins: number;
  itemInstanceIds: string[];
}

export async function sendGift(args: SendGiftArgs): Promise<{ ok: true } | { ok: false; reason: string }> {
  const r = await fetch('/api/social/gift', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const json = (await r.json()) as { ok: true } | { ok: false; reason: string };
  return json;
}
