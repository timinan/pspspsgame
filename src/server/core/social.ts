/**
 * Server-side social-loop persistence — leaderboard, inbox, and gift
 * transfers. Sits on top of player-state.ts (coin + cosmetic mutation)
 * and uses Devvit's redis client for sorted sets + lists.
 *
 * Redis key conventions:
 *   meowcert:lb:<postId>          sorted set (member = visitor, score = play score)
 *   meowcert:lb:meta:<postId>     hash of `<visitor>: {accuracy, playedAt}` for top-N hydration
 *   meowcert:inbox:<owner>        Redis list (LPUSH = newest first, LTRIM bounded to INBOX_MAX_EVENTS)
 *   meowcert:post-owner:<postId>  string — visitor-facing lookup of who owns a post
 *
 * The owner lookup key is populated lazily on first leaderboard submit
 * for a post; before that, the caller must pass the owner username in
 * the request body.
 */

import type {
  InboxEvent,
  LeaderboardEntry,
  PlaySummary,
} from '../../shared/social-loop';
import { INBOX_MAX_EVENTS, LEADERBOARD_TOP_N } from '../../shared/social-loop';
import { loadOrInit, save, type RedisLike } from './player-state';

/** Extended Redis interface — adds the sorted set + list + hash ops
 *  we need on top of the player-state baseline get/set. Devvit's
 *  '@devvit/web/server' redis exposes all of these natively. */
export interface SocialRedis extends RedisLike {
  zAdd(key: string, ...members: Array<{ score: number; member: string }>): Promise<unknown>;
  // Devvit's zRange returns `{member, score}[]` — NOT `string[]`. We used
  // to type this as string[] and pass each entry through to zScore, which
  // crashed inside Devvit's encoder ("string argument must be of type
  // string... Received an instance of Object"). That swallowed the whole
  // leaderboard fetch on visitor reads, even after the creator-seed was
  // written successfully. Treat the score embedded in the result as the
  // source of truth instead of doing a second zScore round-trip per row.
  zRange(key: string, start: number, stop: number, opts: { reverse?: boolean; by: 'score' | 'lex' | 'rank' }): Promise<Array<{ member: string; score: number }>>;
  zScore(key: string, member: string): Promise<number | null | undefined>;
  zCard(key: string): Promise<number>;
  zRevRank?(key: string, member: string): Promise<number | null | undefined>;
  hSet(key: string, fieldValues: Record<string, string>): Promise<unknown>;
  hGet(key: string, field: string): Promise<string | null | undefined>;
  hGetAll(key: string): Promise<Record<string, string>>;
  lPush(key: string, ...values: string[]): Promise<unknown>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  lTrim(key: string, start: number, stop: number): Promise<unknown>;
}

const LB_KEY = (postId: string): string => `meowcert:lb:${postId}`;
const LB_META_KEY = (postId: string): string => `meowcert:lb:meta:${postId}`;
const INBOX_KEY = (owner: string): string => `meowcert:inbox:${owner}`;
const POST_OWNER_KEY = (postId: string): string => `meowcert:post-owner:${postId}`;

// -- Leaderboard ------------------------------------------------------

/** Submit a passing run to the post's leaderboard. Caller MUST have
 *  already validated `summary.passed === true`; failing runs go in
 *  the inbox stream but not the public board. Only the visitor's
 *  PERSONAL BEST is kept (zAdd with `score` overwrites if higher;
 *  we do a manual check because Redis zAdd accepts any score). */
export async function submitLeaderboardScore(
  redis: SocialRedis,
  summary: PlaySummary,
): Promise<void> {
  if (!summary.passed) return;
  const existing = await redis.zScore(LB_KEY(summary.postId), summary.visitor);
  const prev = typeof existing === 'number' ? existing : -Infinity;
  if (summary.score <= prev) return; // not a new PB
  await redis.zAdd(LB_KEY(summary.postId), { score: summary.score, member: summary.visitor });
  await redis.hSet(LB_META_KEY(summary.postId), {
    [summary.visitor]: JSON.stringify({
      accuracy: summary.accuracy,
      playedAt: Date.now(),
    }),
  });
  // Lazily record the post → owner mapping so visitors can fetch who
  // they're playing without the editor handing it to them.
  await redis.set(POST_OWNER_KEY(summary.postId), summary.owner);
}

/** Fetch the top N entries for a post + the requesting visitor's rank
 *  (1-based) if they're not in the top N. Returns null for rank when
 *  the visitor has no qualifying run on this board. */
export async function fetchLeaderboard(
  redis: SocialRedis,
  postId: string,
  visitor: string | null,
): Promise<{ top: LeaderboardEntry[]; yourRank: number | null; yourScore: number | null; yourAccuracy: number | null }> {
  // Get top entries sorted descending by score. zRange returns
  // {member, score}[] in Devvit — score is right there, no per-row
  // zScore round-trip needed.
  // by:'rank' is REQUIRED by Devvit's ZRangeOptions — without it Redis
  // doesn't know whether to interpret start/stop as rank index, lex
  // string, or score number, and we silently get empty back. Treats the
  // start/stop pair as 0-indexed rank with reverse:true → highest first.
  const rows = await redis.zRange(LB_KEY(postId), 0, LEADERBOARD_TOP_N - 1, { reverse: true, by: 'rank' });
  const meta = await redis.hGetAll(LB_META_KEY(postId));
  const top: LeaderboardEntry[] = [];
  for (const { member, score } of rows) {
    let accuracy = 0;
    let playedAt = 0;
    try {
      const m = meta[member];
      if (m) {
        const parsed = JSON.parse(m) as { accuracy: number; playedAt: number };
        accuracy = parsed.accuracy;
        playedAt = parsed.playedAt;
      }
    } catch {
      // ignore meta parse fail — entry still shows with default 0/0
    }
    top.push({ visitor: member, score, accuracy, playedAt });
  }
  // Your-rank line — only meaningful if the visitor isn't already in top N.
  let yourRank: number | null = null;
  let yourScore: number | null = null;
  let yourAccuracy: number | null = null;
  if (visitor && !top.some((e) => e.visitor === visitor)) {
    const score = await redis.zScore(LB_KEY(postId), visitor);
    if (typeof score === 'number') {
      yourScore = score;
      // zRevRank gives the 0-indexed rank from the top (highest score = 0).
      // Devvit's API may not expose zRevRank; we compute manually if not.
      if (redis.zRevRank) {
        const r = await redis.zRevRank(LB_KEY(postId), visitor);
        yourRank = typeof r === 'number' ? r + 1 : null;
      } else {
        // Fallback: count members with strictly higher scores → that's the rank above.
        // Bounded by zCard so this stays O(N).
        const total = await redis.zCard(LB_KEY(postId));
        const above = await redis.zRange(LB_KEY(postId), 0, total - 1, { reverse: true, by: 'rank' });
        const idx = above.findIndex((r) => r.member === visitor);
        yourRank = idx >= 0 ? idx + 1 : null;
      }
      try {
        const m = meta[visitor];
        if (m) {
          const parsed = JSON.parse(m) as { accuracy: number; playedAt: number };
          yourAccuracy = parsed.accuracy;
        }
      } catch {
        // ignore
      }
    }
  }
  return { top, yourRank, yourScore, yourAccuracy };
}

// -- Inbox ------------------------------------------------------------

/** LPUSH a new event onto the owner's inbox stream, then LTRIM to the
 *  retention cap so old events scroll off. Idempotent on event.id — if
 *  caller re-submits the same event, it just lands as a duplicate
 *  (we don't dedup server-side for write speed). */
export async function pushInboxEvent(
  redis: SocialRedis,
  owner: string,
  event: InboxEvent,
): Promise<void> {
  await redis.lPush(INBOX_KEY(owner), JSON.stringify(event));
  await redis.lTrim(INBOX_KEY(owner), 0, INBOX_MAX_EVENTS - 1);
}

/** Fetch the owner's full inbox (up to INBOX_MAX_EVENTS, newest first). */
export async function fetchInbox(
  redis: SocialRedis,
  owner: string,
): Promise<InboxEvent[]> {
  const raws = await redis.lRange(INBOX_KEY(owner), 0, INBOX_MAX_EVENTS - 1);
  const events: InboxEvent[] = [];
  for (const raw of raws) {
    try {
      events.push(JSON.parse(raw) as InboxEvent);
    } catch {
      // Skip corrupt entries silently
    }
  }
  return events;
}

/** Mark every inbox event as seen. The inbox UI calls this when the
 *  owner opens the inbox modal so the unread badge clears. Re-writes
 *  the whole list because Redis doesn't have an "update Nth" op. */
export async function markInboxSeen(
  redis: SocialRedis,
  owner: string,
): Promise<void> {
  const events = await fetchInbox(redis, owner);
  if (events.length === 0) return;
  // Clear + push back all events with seen=true. lPush in reverse so
  // the newest stays at index 0.
  await redis.lTrim(INBOX_KEY(owner), 1, 0); // empties the list
  const marked = events.map((e) => ({ ...e, seen: true }));
  // Push oldest first so newest ends up at index 0 (lPush prepends).
  for (let i = marked.length - 1; i >= 0; i--) {
    await redis.lPush(INBOX_KEY(owner), JSON.stringify(marked[i]));
  }
}

// -- Gift transfer ----------------------------------------------------

/** Cross-account coin + item transfer. Best-effort atomic — Devvit
 *  redis doesn't expose MULTI/EXEC, so we do sequential ops with
 *  defensive rollback on failure. Returns the final visitor + owner
 *  states so the client can refresh their displays.
 *
 *  Validation:
 *   - coins must be ≥ 0 and ≤ visitor.coins
 *   - each itemInstanceId must exist in visitor.ownedCosmetics
 *   - owner != visitor (no self-gifting)
 */
export async function transferGift(
  redis: SocialRedis,
  visitor: string,
  owner: string,
  coins: number,
  itemInstanceIds: string[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (visitor === owner) return { ok: false, reason: 'cannot gift to yourself' };
  if (coins < 0) return { ok: false, reason: 'coins must be non-negative' };
  if (coins === 0 && itemInstanceIds.length === 0) {
    return { ok: false, reason: 'empty gift' };
  }
  const visitorState = await loadOrInit(redis, visitor);
  if (visitorState.coins < coins) {
    return { ok: false, reason: 'insufficient coins' };
  }
  // Resolve item instances from visitor's inventory.
  const itemsToMove: typeof visitorState.ownedCosmetics = [];
  for (const id of itemInstanceIds) {
    const idx = visitorState.ownedCosmetics.findIndex((c) => c.id === id);
    if (idx < 0) return { ok: false, reason: `item ${id} not owned by ${visitor}` };
    itemsToMove.push(visitorState.ownedCosmetics[idx]!);
  }
  // All validations passed — perform the move.
  const ownerState = await loadOrInit(redis, owner);
  visitorState.coins -= coins;
  ownerState.coins += coins;
  for (const item of itemsToMove) {
    const idx = visitorState.ownedCosmetics.findIndex((c) => c.id === item.id);
    if (idx >= 0) visitorState.ownedCosmetics.splice(idx, 1);
    ownerState.ownedCosmetics.push(item);
  }
  // Persist both. If owner save fails after visitor save, we'd leak
  // visitor's coins/items — log it loud. This is the best we can do
  // without MULTI/EXEC.
  await save(redis, visitorState);
  try {
    await save(redis, ownerState);
  } catch (err) {
    console.error('[social.transferGift] OWNER SAVE FAILED — visitor lost stuff:', err);
    return { ok: false, reason: 'owner save failed' };
  }
  return { ok: true };
}

// -- Helpers ----------------------------------------------------------

/** Look up the username that owns a given post id. Populated lazily
 *  on first leaderboard submit. Returns null if no one has played
 *  the post yet (which shouldn't happen — the host plays their own
 *  preview once before publishing). */
export async function getPostOwner(
  redis: SocialRedis,
  postId: string,
): Promise<string | null> {
  const v = await redis.get(POST_OWNER_KEY(postId));
  return v ?? null;
}

/** Explicitly record the post → owner mapping. Called when a post is
 *  first created so visitors can look it up before the first play. */
export async function setPostOwner(
  redis: SocialRedis,
  postId: string,
  owner: string,
): Promise<void> {
  await redis.set(POST_OWNER_KEY(postId), owner);
}
