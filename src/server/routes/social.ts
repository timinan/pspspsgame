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
  incrementCombinedScore,
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
  formatAutoStatsReply,
  formatPinnedSummary,
  LEADERBOARD_MIN_ACCURACY,
  type PlaySummary,
  type InboxEvent,
} from '../../shared/social-loop';
import { BACKING_CATALOG, rolloverEconomy, type Chart } from '../../shared/state';
import { loadOrInit, save } from '../core/player-state';
import { ECONOMY, computePlayReward, type Difficulty, type PlayRewardBreakdown, type PlayRewardInput } from '../../shared/economy';
import { applyPlayReward } from '../../shared/economy-apply';
import { milestonesEarned } from '../../shared/post-milestones';

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
  // Task 4 economy fields — optional until Task 5 client lands.
  // Absent = legacy mode (no credit, no 400).
  perfects?: number;
  misses?: number;
  difficulty?: Difficulty;
  playToken?: string;
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
  const { tier, baseReward } = classifyScore(body.accuracy, body.accuracy >= LEADERBOARD_MIN_ACCURACY);
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
  // Combined score counter — incrBy by this play's score on every
  // submission (matches the totalPlays counter pattern). Distinct from
  // sum-of-PBs which only counted each player's best run once. Same
  // defensive wrap as the play counter — failures must not block lb +
  // inbox + Reddit comment + pinned summary refresh.
  try {
    await incrementCombinedScore(r, body.postId, body.score);
  } catch (err) {
    console.error('[social/play] incrementCombinedScore failed (continuing)', err);
  }
  // Leaderboard: only passing runs land on it.
  await submitLeaderboardScore(r, summary);
  // Stats — a non-owner completed round bumps visitor.playsOnOthers +
  // host.playsReceived. Wrapped: stats-side failures MUST NOT block
  // the play pipeline (leaderboard + inbox + auto-comment). Owner
  // self-plays don't count on either side — they'd double-inflate as
  // "played my own show" AND "someone played my show", which is not
  // what the counters mean.
  if (visitor !== body.owner) {
    try {
      const v = await loadOrInit(redis, visitor);
      v.stats.playsOnOthers += 1;
      await save(redis, v);
    } catch (err) {
      console.error('[social/play] visitor stats bump failed (continuing)', err);
    }
    try {
      const h = await loadOrInit(redis, body.owner);
      h.stats.playsReceived += 1;
      await save(redis, h);
    } catch (err) {
      console.error('[social/play] host stats bump failed (continuing)', err);
    }
  }
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
  // (Old root-level free-text reddit.submitComment removed — Tim's call:
  // "there should be only 1 new post added under the mod post... right
  // now there is a bug that if you post a comment it adds two comments
  // under the mod post." Free-text now lives inside the single
  // nested-reply comment below, formatted via formatStatsComment with
  // the player's text appended as a blockquote.)

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

  // Auto-stats reply under the pinned mod — fires on EVERY /play (which
  // is once per round, triggered by endRound auto-submit). Stats-only,
  // no free-text. If the player ALSO taps POST + types something,
  // page-2 triggers /comment separately to post a root-level comment
  // on the post itself (different surface — root post vs nested under
  // mod). One mod reply per round + optional root comment if they
  // typed. Tim: "only add to the post under the mod post IF the player
  // didn't add a comment themselves" — but the mod reply still fires
  // for everyone since it's the structured stats anchor; the root
  // comment is what changes based on POST vs SKIP/no-action.
  const pinnedId = await getPinnedCommentId(r, body.postId);
  if (pinnedId) {
    try {
      // Compute rank + total players AFTER the leaderboard write above
      // so the visitor sees their fresh rank in the reply. yourRank is
      // null for visitors in the top N → derive from their index in
      // the top list. totalPlayers approx: top.length when not at cap,
      // else totalPlays for posts with > 10 unique players.
      const lb = await fetchLeaderboard(r, body.postId, visitor);
      const topIdx = lb.top.findIndex((e) => e.visitor === visitor);
      const rank = topIdx >= 0 ? topIdx + 1 : lb.yourRank;
      const totalPlayers = lb.top.length >= 10 ? lb.totalPlays : lb.top.length;
      const text = formatAutoStatsReply(summary, rank, totalPlayers);
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
      // Top player INCLUDES owner — creator is the default top until a
      // non-owner beats them. isCreator flags ownership so the formatter
      // appends '(creator)' to their name. Per Tim's call.
      const topEntry = lbForSummary.top[0];
      const topPlayer = topEntry
        ? { username: topEntry.visitor, score: topEntry.score, isCreator: topEntry.visitor === body.owner }
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
      console.info('[social/play] computing pinned summary', {
        pinnedId,
        totalPlays: lbForSummary.totalPlays,
        passCount,
        combinedScore,
        topPlayer,
        firstPasser,
        bodyLen: summaryBody.length,
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

  // Economy credit block — only fires when the client sends a playToken
  // (Task 5 client). Absent token = legacy mode: skip crediting entirely
  // so the live playtest keeps working mid-plan. Never 400 on missing token.
  let breakdown: PlayRewardBreakdown | undefined;
  let royalty: number | undefined;

  if (body.playToken) {
    const tokenKey = `meowcert:play-token:${body.playToken}`;
    try {
      // Idempotency: return cached result on repeat submissions (set-if-unset
      // pattern — same as setFirstPasserIfUnset in core/social.ts).
      const cached = await r.get(tokenKey);
      if (cached) {
        const result = JSON.parse(cached) as { breakdown: PlayRewardBreakdown; royalty: number };
        return c.json({
          ok: true,
          tier,
          baseReward,
          passed,
          breakdown: result.breakdown,
          royalty: result.royalty,
          alreadyCredited: true,
        });
      }
    } catch (err) {
      console.error('[social/play] token cache read failed (continuing)', err);
    }

    const isoToday = new Date().toISOString().slice(0, 10);
    try {
      const v = await loadOrInit(redis, visitor);
      const isOwner = visitor === body.owner;
      const h = isOwner ? v : await loadOrInit(redis, body.owner);

      const input: PlayRewardInput = {
        accuracyPct: body.accuracy * 100,
        maxCombo: body.maxCombo,
        perfects: body.perfects ?? 0,
        misses: body.misses ?? 0,
        totalNotes: body.totalNotes,
        difficulty: body.difficulty ?? 'easy',
        isOwnShow: isOwner,
        chartPlaysToday: v.economy.daily.chartPlays[body.postId] ?? 0,
        playIncomeToday: v.economy.daily.playIncome,
      };

      const bd = computePlayReward(input);
      const result = applyPlayReward(v, h, bd, body.postId, isoToday);
      breakdown = result.breakdown;
      royalty = result.royalty;

      // Per-post milestones — visitor ≠ owner only. Both counters are
      // atomic (incrBy returns the new value) so no TOCTOU race. The
      // milestone play counter uses a dedicated key distinct from the
      // incrementPlayCount counter (which runs outside this block on
      // every submission regardless of credit eligibility).
      if (!isOwner) {
        try {
          const newPlays = await r.incrBy('meowcert:post-plays:' + body.postId, 1);
          const passClaims = passed
            ? await r.incrBy('meowcert:first-pass-claimed:' + body.postId, 1)
            : 0;
          const isFirstPass = passClaims === 1;
          const { coins: mCoins, labels } = milestonesEarned(newPlays - 1, newPlays, isFirstPass);
          if (mCoins > 0) {
            h.economy.pendingCollect += mCoins;
            console.info('[social/play] milestones credited to host pot', {
              postId: body.postId,
              coins: mCoins,
              labels,
              owner: body.owner,
            });
          }
        } catch (err) {
          console.error('[social/play] milestone credit failed (continuing)', err);
        }
      }

      // Save owner first, then visitor
      if (!isOwner) await save(redis, h);
      await save(redis, v);

      // Cache token so repeat submissions return the identical breakdown
      await r.set(tokenKey, JSON.stringify({ breakdown, royalty }));
    } catch (err) {
      console.error('[social/play] economy credit failed (continuing)', err);
    }
  }

  return c.json({
    ok: true,
    tier,
    baseReward,
    passed,
    ...(breakdown !== undefined ? { breakdown, royalty } : {}),
  });
});

interface CommentBody {
  postId: string;
  owner: string;
  /** Play summary the client already built — passed in so /comment
   *  doesn't need to recompute or refetch. */
  summary: PlaySummary;
  /** Visitor's free-text. Empty / omitted = SKIP path (stats only). */
  commentBody?: string;
}

/**
 * POST /comment — fires a ROOT-LEVEL comment on the post itself (NOT
 * nested under the mod-pinned root). Used only by page-2 POST when
 * the player typed something. The mod-pinned reply (stats-only) is
 * handled by /play's auto-stats path; /comment is the user-content
 * surface — their text big on top, stats as a smaller footer caption.
 *
 * Tim: "when i do comment its still going under the mod post rather
 * than the post itself" — clarifying that the typed comment belongs
 * on the root post, not under the mod thread. The mod thread is for
 * the structured per-play stats; the post root is for user voice.
 *
 * Page-2 SKIP does NOT call this — there's no text to post.
 */
social.post('/comment', async (c) => {
  const visitor = await currentUsername();
  const body = (await c.req.json()) as CommentBody;
  if (!body.postId || !body.owner || !body.summary) {
    return c.json({ ok: false, reason: 'postId + owner + summary required' }, 400);
  }
  try {
    const text = formatStatsComment(body.summary, body.commentBody ?? '');
    await reddit.submitComment({
      id: body.postId,  // ROOT-LEVEL — not nested under pinned
      text,
      runAs: 'USER',
    });
    console.info('[social/comment] root-level comment posted on', body.postId, { visitor });
  } catch (err) {
    console.error('[social/comment] comment failed', err);
    return c.json({ ok: false, reason: 'reddit submitComment failed' }, 500);
  }

  // First-comment-per-post bonus — wrapped so redis hiccup never fails the post
  let commentBonus = 0;
  if (visitor !== body.owner) {
    try {
      const claims = await r.incrBy(`meowcert:commented:${body.postId}:${visitor}`, 1);
      if (claims === 1) {
        const isoToday = new Date().toISOString().slice(0, 10);
        const player = await loadOrInit(visitor);
        rolloverEconomy(player, isoToday);
        player.coins += ECONOMY.commentBonus;
        player.stats.coinsEarnedLifetime += ECONOMY.commentBonus;
        await save(visitor, player);
        commentBonus = ECONOMY.commentBonus;
      }
    } catch (err) {
      console.error('[social/comment] bonus credit failed (continuing)', err);
    }
  }

  return c.json({ ok: true, posted: true, commentBonus });
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
