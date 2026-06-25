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
  type SocialRedis,
} from '../core/social';
import { classifyScore, type PlaySummary, type InboxEvent } from '../../shared/social-loop';

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
    return c.json({ ok: false, reason: 'postId + owner required' }, 400);
  }
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
  return c.json({
    ok: true,
    tier,
    baseReward,
    passed,
  });
});

social.get('/leaderboard', async (c) => {
  const postId = c.req.query('postId');
  if (!postId) return c.json({ ok: false, reason: 'postId required' }, 400);
  const visitor = await currentUsername();
  const result = await fetchLeaderboard(r, postId, visitor === 'anonymous' ? null : visitor);
  return c.json({ ok: true, ...result });
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
