import { Hono } from 'hono';
import { redis } from '@devvit/web/server';
import { loadOrInit } from '../core/player-state';
import { BACKING_CATALOG } from '../../shared/state';

/**
 * Preview-image endpoint. Mounted at /api/preview-image.
 *
 *   GET /?postId=X  — splash.html fetches the post-owner's stored
 *                     image (captured at publish time in Game) + chart
 *                     metadata so the inline feed preview can render
 *                     as a VisitPost mirror in one fetch.
 *
 * The POST endpoint that used to live here (Decorate-leave capture)
 * is gone — Tim's call to capture at publish time instead. Image is
 * now keyed per-post under meowcert:post-preview:<postId>, written by
 * publish.ts when the player taps PUT ON A SHOW.
 */
export const preview = new Hono();

preview.get('/', async (c) => {
  const postId = c.req.query('postId');
  if (!postId) return c.json({ error: 'missing postId' }, 400);

  console.info(`[preview] GET postId=${postId}`);

  const ownerUsername = await redis.get(`meowcert:post-owner:${postId}`);
  if (!ownerUsername) {
    console.info(`[preview] no owner mapping for ${postId}`);
    return c.json({ error: 'post has no owner mapping' }, 404);
  }

  // Per-post preview image — captured by Game's onPostFromTestClicked
  // at publish time. Each post has its own stage snapshot, so a player
  // who publishes multiple shows gets a distinct preview per post.
  const previewImage = await redis.get(`meowcert:post-preview:${postId}`);
  console.info(`[preview] owner=${ownerUsername} hasImage=${!!previewImage}`);

  // Song line uses the BACKING song's displayName (recognizable thing
  // like "Mahalia - I Wish I Missed My Ex"), NOT chart.title (which is
  // hardcoded 'My Beat' or 'Rehearsal' from the generator). Resolved
  // via BACKING_CATALOG[audioKey].
  const ownerState = await loadOrInit(redis, ownerUsername);
  const chart = ownerState.chart;
  const audioKey = chart?.audioKey;
  const backing = audioKey ? BACKING_CATALOG[audioKey] : undefined;
  const title = backing?.displayName ?? chart?.title ?? 'a rhythm show';
  const vibe = chart?.vibe;
  const difficulty = chart?.difficulty;

  return c.json({
    postId,
    ownerUsername,
    previewImage: previewImage ?? null,
    song: { title, vibe, difficulty },
  });
});
