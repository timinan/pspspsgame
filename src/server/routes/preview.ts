import { Hono } from 'hono';
import { redis } from '@devvit/web/server';
import { loadOrInit } from '../core/player-state';

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

  const ownerUsername = await redis.get(`meowcert:post-owner:${postId}`);
  if (!ownerUsername) {
    return c.json({ error: 'post has no owner mapping' }, 404);
  }

  // Per-post preview image — captured by Game's onPostFromTestClicked
  // at publish time. Each post has its own stage snapshot, so a player
  // who publishes multiple shows gets a distinct preview per post
  // (vs the old per-player image which made every post look the same).
  const previewImage = await redis.get(`meowcert:post-preview:${postId}`);

  // Chart metadata for the song-line on the splash. Pull title + vibe
  // + difficulty from the owner's current state. This DOES use the
  // owner's latest chart (not snapshot at publish time) — if the
  // owner edits their chart after publish, the splash song-line will
  // update. Trade-off vs storing chart-at-publish, picked latest.
  const ownerState = await loadOrInit(redis, ownerUsername);
  const chart = ownerState.chart;
  const title = chart?.title ?? 'a rhythm show';
  const vibe = chart?.vibe;
  const difficulty = chart?.difficulty;

  return c.json({
    postId,
    ownerUsername,
    previewImage: previewImage ?? null,
    song: { title, vibe, difficulty },
  });
});
