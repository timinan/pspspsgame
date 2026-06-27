import { Hono } from 'hono';
import { redis, reddit, context } from '@devvit/web/server';
import { loadOrInit } from '../core/player-state';
import { setPostOwner, submitLeaderboardScore } from '../core/social';
import { classifyScore } from '../../shared/social-loop';

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

    // Optional cat-stage snapshot + creator's rehearsal score from
    // the client. Image stored per-post so splash shows THIS show's
    // stage. Score seeded as the post's first leaderboard entry so
    // visitors see something to beat.
    let previewImage: string | undefined;
    let creatorScore: number | undefined;
    let creatorAccuracy: number | undefined;
    try {
      const body = (await c.req.json()) as {
        previewImage?: string | null;
        creatorScore?: number | null;
        creatorAccuracy?: number | null;
      };
      if (body?.previewImage && typeof body.previewImage === 'string'
          && body.previewImage.startsWith('data:image/')
          && body.previewImage.length < 300_000) {
        previewImage = body.previewImage;
      }
      if (typeof body?.creatorScore === 'number' && body.creatorScore > 0) {
        creatorScore = body.creatorScore;
      }
      if (typeof body?.creatorAccuracy === 'number'
          && body.creatorAccuracy >= 0 && body.creatorAccuracy <= 1) {
        creatorAccuracy = body.creatorAccuracy;
      }
    } catch {
      // body might not be JSON — fine, just no extras
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

    // Snapshot the chart at publish time under a per-post key so the
    // VisitPost splash always serves the exact chart that was posted.
    // Previously we loaded the OWNER's state.chart at visit time, which
    // drifts as the author edits new charts — visitors then saw whatever
    // half-built next chart the author was working on instead of the
    // published one (Tim: "u/timmymmit's set" placeholder appearing on
    // the splash because the latest state.chart had no audioKey + no
    // notes). Stored as JSON; consumed by /api/post-chart.
    try {
      await redis.set(`meowcert:post-chart:${post.id}`, JSON.stringify(chart));
      console.info(`[publish] stored per-post chart for ${post.id} (audioKey=${chart.audioKey ?? '-'}, steps=${chart.steps?.length ?? 0})`);
    } catch (err) {
      console.warn('[publish] per-post chart write failed:', err);
    }

    // Store the cat-stage snapshot keyed by post id so splash.html
    // can fetch the right preview for each post (vs the player's
    // current Decorate state which would mean every post they ever
    // make shows the same stage).
    if (previewImage) {
      await redis.set(`meowcert:post-preview:${post.id}`, previewImage);
      console.info(`[publish] stored preview image (${previewImage.length} bytes) for ${post.id}`);
    } else {
      console.info(`[publish] no preview image supplied for ${post.id}`);
    }

    // Seed the leaderboard with the creator's rehearsal score so
    // visitors land on a non-empty board (Tim: "should at least have
    // 1 play and score from the creator"). The 75% accuracy gate
    // visitors face does NOT apply to the creator's own seed — even a
    // sloppy rehearsal on a hard chart should count as the opening
    // score, otherwise visitors land on an empty board with no
    // benchmark. Force passed:true so submitLeaderboardScore lets it
    // through.
    if (creatorScore !== undefined && creatorAccuracy !== undefined && creatorScore > 0) {
      const { tier, baseReward } = classifyScore(creatorAccuracy, true);
      await submitLeaderboardScore(redis, {
        visitor: username,
        owner: username,
        postId: post.id,
        score: creatorScore,
        totalNotes: 0,
        notesHit: 0,
        maxCombo: 0,
        accuracy: creatorAccuracy,
        passed: true,
        tier,
        baseReward,
      });
      console.info(`[publish] seeded creator leaderboard entry: ${username} → ${creatorScore} (acc=${creatorAccuracy.toFixed(2)})`);
    } else {
      console.info(`[publish] skipped creator seed — score=${creatorScore} acc=${creatorAccuracy}`);
    }

    // Reverted to the EXACT shape from f4d9bbf (the version Tim
    // confirmed worked yesterday): plain `https://reddit.com${permalink}`
    // string. Today's 1c8f90e tried Devvit's `{url, permalink}` resolver
    // form using post.url — Tim flagged that as a regression. Sticking
    // to the known-good behavior + logging both fields so the next
    // failure has enough signal to diagnose without guessing.
    const url = `https://reddit.com${post.permalink}`;
    console.info('[publish] returning ok url:', url, 'post.url:', post.url, 'post.permalink:', post.permalink);
    return c.json({ ok: true, postId: post.id, url, permalink: post.permalink });
  } catch (err) {
    console.error('[publish] failed to create post:', err);
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, reason: `reddit error: ${msg.slice(0, 80)}` }, 500);
  }
});
