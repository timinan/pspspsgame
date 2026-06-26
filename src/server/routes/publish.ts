import { Hono } from 'hono';
import { redis, reddit, context } from '@devvit/web/server';
import { loadOrInit } from '../core/player-state';
import { setPostOwner } from '../core/social';

/**
 * Publish flow — turn an authored chart into a live Reddit post that
 * other players can visit and play. Mounted at /api/publish.
 *
 * POST /chart — create a new Reddit post for the caller's saved chart.
 *   Returns { ok: true, postId, url } on success or { ok: false, reason }
 *   on validation/Devvit failure. Always wires the post-owner mapping
 *   into Redis so the social-loop endpoints can route leaderboard +
 *   inbox entries to the right author when visitors play.
 */
export const publish = new Hono();

publish.post('/chart', async (c) => {
  console.info('[publish] POST /chart received');
  try {
    const username = (await reddit.getCurrentUsername()) ?? 'anonymous';
    console.info('[publish] username:', username);
    if (username === 'anonymous') {
      return c.json({ ok: false, reason: 'sign in to post a show' }, 401);
    }

    const state = await loadOrInit(redis, username);
    const chart = state.chart;
    const hasNotes = chart?.steps?.some((s) => s.lanes.length > 0);
    console.info('[publish] chart present:', !!chart, 'has notes:', hasNotes);
    if (!chart || !hasNotes) {
      return c.json(
        { ok: false, reason: 'save a chart with at least one note before posting' },
        400,
      );
    }

    // Devvit creates the post + returns its id. Title carries the
    // author's name so the feed reads as "playing alice's show".
    // runAs: 'USER' makes the post show up as authored by the player
    // instead of the app's bot account — Tim's call ("posts are being
    // posted by the subreddit rather than the user"). Pair with
    // userGeneratedContent (required by Devvit when runAs is USER) +
    // textFallback (shown if the custom-post embed can't render).
    // Requires permissions.reddit.asUser: ['SUBMIT_POST'] in devvit.json.
    console.info('[publish] calling reddit.submitCustomPost (runAs USER)...');
    const subredditName = context.subredditName;
    if (!subredditName) {
      return c.json({ ok: false, reason: 'missing subreddit context' }, 500);
    }
    const post = await reddit.submitCustomPost({
      title: `🎵 ${username}'s show`,
      subredditName,
      runAs: 'USER',
      userGeneratedContent: {
        text: `A new Meowcert show from ${username} — tap to play.`,
      },
      textFallback: {
        text: `${username} dropped a new Meowcert show. Open the post in the Reddit app to play it.`,
      },
    });
    console.info('[publish] post created, id:', post.id, 'permalink:', post.permalink);

    // Wire the post → owner mapping immediately so submitPlay /
    // leaderboard / inbox endpoints can route to the right author the
    // first time a visitor opens the post.
    await setPostOwner(redis, post.id, username);

    // Use post.permalink for the URL — post.id is a T3 string with a
    // 't3_' prefix which Reddit's URL routing chokes on. The permalink
    // is the canonical path Reddit uses internally.
    const url = `https://reddit.com${post.permalink}`;
    console.info('[publish] returning ok with url:', url);
    return c.json({ ok: true, postId: post.id, url });
  } catch (err) {
    console.error('[publish] failed to create post:', err);
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, reason: `reddit error: ${msg.slice(0, 80)}` }, 500);
  }
});
