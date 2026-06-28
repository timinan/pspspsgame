import { Hono } from 'hono';
import { redis, reddit } from '@devvit/web/server';
import {
  submitLeaderboardScore,
  fetchLeaderboard,
  pushInboxEvent,
  fetchInbox,
  markInboxSeen,
  transferGift,
  setPostOwner,
  incrementPlayCount,
  getPinnedCommentId,
  incrementPassCount,
  getPassCount,
  setFirstPasserIfUnset,
  getFirstPasser,
  fetchCombinedScore,
  type SocialRedis,
} from '../core/social';
import {
  classifyScore,
  formatStatsComment,
  formatPinnedSummary,
  type PlaySummary,
  type InboxEvent,
} from '../../shared/social-loop';
import { BACKING_CATALOG, type Chart } from '../../shared/state';

/**
 * Server routes for the social loop:
 *
 *   POST /api/social/play       — visitor reports a completed run; we
 *                                  write the leaderboard entry + push the
 *                                  appropriate inbox event(s) to the owner.
 *   GET  /api/social/leaderboard?postId=...
 *                                — top 10 + your-rank for the given post.
 *   GET  /api/social/inbox      — current player's inbox stream (newest first).
 *   POST /api/social/inbox/mark-read
 *                                — flip every event to seen=true.
 *   POST /api/social/gift       — atomic-ish coin + item transfer
 *                                  visitor → owner. Triggers a gift inbox event.
 *   POST /api/social/post-owner — explicitly record post → owner mapping
 *                                  (called by the post creation flow).
 */
export const social = new Hono();

// Devvit's redis client implements SocialRedis natively.
const r = redis as unknown as SocialRedis;

async function currentUsername(): Promise<string> {
  const u = await reddit.getCurrentUsername();
  return u ?? 'anonymous';
}

interface PlayBody {
  postId: string;
  owner: string;
  score: number;
  totalNotes: number;
  notesHit: number;
  maxCombo: number;
  accuracy: number;
  /** Free-text portion of the comment, if the visitor posted one.
   *  Empty string / omitted = no comment posted. */
  commentBody?: string;
  /** Optional gift sent alongside the play. */
  gift?: { coins: number; itemInstanceIds: string[] };
}

social.post('/play', async (c) => {
  const visitor = await currentUsername();
  const body = (await c.req.json()) as PlayBody;
  if (!body.postId || !body.owner) {
    console.warn('[social/play] missing postId or owner', { postId: body.postId, owner: body.owner });
    return c.json({ ok: false, reason: 'postId + owner required' }, 400);
  }
  console.info('[social/play] POST', {
    visitor,
    owner: body.owner,
    postId: body.postId,
    score: body.score,
    accuracy: body.accuracy,
    isOwnerSelfPlay: visitor === body.owner,
  });
  const { tier, baseReward } = classifyScore(body.accuracy, body.accuracy >= 0.75);
  const passed = tier !== 'fail';
  const summary: PlaySummary = {
    visitor,
    owner: body.owner,
    postId: body.postId,
    score: body.score,
    totalNotes: body.totalNotes,
    notesHit: body.notesHit,
    maxCombo: body.maxCombo,
    accuracy: body.accuracy,
    passed,
    tier,
    baseReward,
    ...(body.gift ? { gift: body.gift } : {}),
  };
  // Total play counter — increments on EVERY submission (pass, fail,
  // PB, repeat, self-play — all count). Splash + VisitPost render this
  // as "X plays" so the host sees engagement traffic, not just unique
  // players. Distinct from the leaderboard zCard which is PB-only.
  // Wrapped defensively: a failure here (Devvit redis method drift,
  // quota, etc.) must NOT block the rest of the play pipeline (lb +
  // inbox + Reddit comment) — they're independently valuable.
  try {
    await incrementPlayCount(r, body.postId);
  } catch (err) {
    console.error('[social/play] incrementPlayCount failed (continuing)', err);
  }
  // Leaderboard: only passing runs land on it.
  await submitLeaderboardScore(r, summary);
  // Inbox: EVERY play, pass or fail (so the owner sees every visitor).
  // Only push if the visitor isn't the owner — playing your own preview
  // shouldn't fill the inbox. (Owner self-play is blocked elsewhere
  // anyway but we double-check here.)
  if (visitor !== body.owner) {
    const playEvent: InboxEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'play',
      at: Date.now(),
      visitor,
      postId: body.postId,
      data: {
        score: body.score,
        accuracy: body.accuracy,
        tier,
        passed,
      },
    };
    await pushInboxEvent(r, body.owner, playEvent);
    // Comment event — only if the visitor actually posted a comment.
    if (body.commentBody && body.commentBody.trim().length > 0) {
      const commentEvent: InboxEvent = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'comment_posted',
        at: Date.now(),
        visitor,
        postId: body.postId,
        data: {
          preview: body.commentBody.slice(0, 100),
        },
      };
      await pushInboxEvent(r, body.owner, commentEvent);
    }
  }
  // Reddit comment submission — OUTSIDE the self-play skip so the host
  // can comment on own posts (testing visibility + future use cases like
  // host welcomes / host responses). Inbox event above is still self-play
  // skipped because the owner shouldn't see their own runs as inbox items.
  if (body.commentBody && body.commentBody.trim().length > 0) {
    try {
      // Devvit's submitComment uses `id` (parent thing-id, t3_ or t1_) —
      // NOT `postId`. The reddit-api.mdx doc example shows `postId` but
      // it's outdated; every other doc (media-uploads.mdx, interactive-
      // posts, the API class reference) + the runtime API itself uses
      // `id`. Sending `postId` made `options.id` undefined on the server
      // side and surfaced as a `TypeError: "string" must be a string,
      // received undefined` from inside Devvit's submitComment.
      await reddit.submitComment({
        id: body.postId,
        text: body.commentBody,
        runAs: 'USER',
      });
      console.info('[social/play] reddit.submitComment OK', { postId: body.postId, visitor });
    } catch (err) {
      console.error('[social/play] reddit.submitComment failed (continuing)', err);
    }
  }

  // Pass-count + first-passer tracking — feeds the pinned-comment
  // summary. Owner plays count toward the pass counter (Tim's call for
  // overall stats) but NEVER qualify as first-passer (so the host
  // can't claim that badge on their own post).
  if (passed) {
    try { await incrementPassCount(r, body.postId); }
    catch (err) { console.error('[social/play] incrementPassCount failed (continuing)', err); }
    if (visitor !== body.owner) {
      try { await setFirstPasserIfUnset(r, body.postId, visitor); }
      catch (err) { console.error('[social/play] setFirstPasserIfUnset failed (continuing)', err); }
    }
  }

  // Auto-stats reply under the bot-pinned root — fires on EVERY play
  // (pass/fail/PB/repeat/self-play all post). Visitor-authored so the
  // comment shows in their account history (Nuzzle convention). Best-
  // effort: a failure here MUST NOT block the play submission — the
  // leaderboard write, inbox event, free-text comment, and play counter
  // already landed above. Skipped silently for posts with no pinned
  // root (pre-dates pinned-comment storage, or publish-time pin failed).
  const pinnedId = await getPinnedCommentId(r, body.postId);
  if (pinnedId) {
    try {
      const lb = await fetchLeaderboard(r, body.postId, visitor);
      const topIdx = lb.top.findIndex((e) => e.visitor === visitor);
      const rank = topIdx >= 0 ? topIdx + 1 : lb.yourRank;
      const totalPlayers = lb.top.length >= 10 ? lb.totalPlays : lb.top.length;
      const text = formatStatsComment(summary, rank, totalPlayers);
      await reddit.submitComment({
        id: pinnedId,
        text,
        runAs: 'USER',
      });
      console.info('[social/play] auto-stats reply posted under', pinnedId);
    } catch (err) {
      console.error('[social/play] auto-stats reply failed (continuing)', err);
    }

    // Refresh the pinned mod comment with the latest live stats —
    // fetch + format + edit. Owner-excluded top player + first passer
    // so the host can't self-rank as "best" or "first pass" on their
    // own post. Owner plays still count in totalPlays / passes /
    // combinedScore (overall engagement metrics). Best-effort — refresh
    // failure does not break the play submission.
    try {
      const lbForSummary = await fetchLeaderboard(r, body.postId, null);
      const nonOwnerTop = lbForSummary.top.find((e) => e.visitor !== body.owner);
      const topPlayer = nonOwnerTop
        ? { username: nonOwnerTop.visitor, score: nonOwnerTop.score }
        : null;
      const firstPasser = await getFirstPasser(r, body.postId);
      const passCount = await getPassCount(r, body.postId);
      const combinedScore = await fetchCombinedScore(r, body.postId);
      const postChartRaw = await r.get(`meowcert:post-chart:${body.postId}`);
      let chart: Chart | undefined;
      if (postChartRaw) {
        try { chart = JSON.parse(postChartRaw) as Chart; }
        catch { /* ignore parse fail, fall through to null fields */ }
      }
      const audioKey = chart?.audioKey;
      const songTitle = audioKey ? (BACKING_CATALOG[audioKey]?.displayName ?? null) : null;
      const summaryBody = formatPinnedSummary({
        ownerUsername: body.owner,
        difficulty: chart?.difficulty ?? null,
        songTitle,
        totalPlays: lbForSummary.totalPlays,
        passCount,
        combinedScore,
        topPlayer,
        firstPasser,
      });
      const comment = await reddit.getCommentById(pinnedId);
      await comment.edit({ text: summaryBody, runAs: 'APP' });
      console.info('[social/play] pinned summary refreshed for', pinnedId);
    } catch (err) {
      console.error('[social/play] pinned summary refresh failed (continuing)', err);
    }
  } else {
    console.info('[social/play] no pinned root for', body.postId, '— skipping auto-stats + summary refresh');
  }

  return c.json({
    ok: true,
    tier,
    baseReward,
    passed,
  });
});

social.get('/leaderboard', async (c) => {
  const postId = c.req.query('postId');
  if (!postId) {
    console.info('[social/lb] missing postId');
    return c.json({ ok: false, reason: 'postId required' }, 400);
  }
  const visitor = await currentUsername();
  console.info(`[social/lb] GET postId=${postId} visitor=${visitor}`);
  try {
    const result = await fetchLeaderboard(r, postId, visitor === 'anonymous' ? null : visitor);
    console.info(`[social/lb] returning top=${result.top.length} yourRank=${result.yourRank ?? '-'}`);
    return c.json({ ok: true, ...result });
  } catch (err) {
    console.error(`[social/lb] fetch threw for ${postId}:`, err);
    return c.json({ ok: false, reason: 'fetch failed' }, 500);
  }
});

social.get('/inbox', async (c) => {
  const owner = await currentUsername();
  const events = await fetchInbox(r, owner);
  return c.json({ ok: true, events });
});

social.post('/inbox/mark-read', async (c) => {
  const owner = await currentUsername();
  await markInboxSeen(r, owner);
  return c.json({ ok: true });
});

interface GiftBody {
  owner: string;
  postId: string;
  coins: number;
  itemInstanceIds: string[];
}

social.post('/gift', async (c) => {
  const visitor = await currentUsername();
  const body = (await c.req.json()) as GiftBody;
  if (!body.owner || !body.postId) {
    return c.json({ ok: false, reason: 'owner + postId required' }, 400);
  }
  const itemIds = body.itemInstanceIds ?? [];
  const result = await transferGift(r, visitor, body.owner, body.coins ?? 0, itemIds);
  if (!result.ok) return c.json(result, 400);
  // Inbox event for the owner — gift_received.
  if (visitor !== body.owner) {
    const event: InboxEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'gift_received',
      at: Date.now(),
      visitor,
      postId: body.postId,
      data: {
        coins: body.coins ?? 0,
        itemCount: itemIds.length,
      },
    };
    await pushInboxEvent(r, body.owner, event);
  }
  return c.json({ ok: true });
});

interface PostOwnerBody {
  postId: string;
  owner: string;
}

social.post('/post-owner', async (c) => {
  const body = (await c.req.json()) as PostOwnerBody;
  if (!body.postId || !body.owner) {
    return c.json({ ok: false, reason: 'postId + owner required' }, 400);
  }
  await setPostOwner(r, body.postId, body.owner);
  return c.json({ ok: true });
});
