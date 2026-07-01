import { Hono } from 'hono';
import { redis } from '@devvit/web/server';
import { loadOrInit } from '../core/player-state';
import { BACKING_CATALOG } from '../../shared/state';
import type { Chart } from '../../shared/state';

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

  // Per-post stage's activeBackground — used by the splash to render
  // the host's bg as the page background under the cat-stage snapshot,
  // so the inline preview reads like the in-game stage (bg fills the
  // whole splash, not just the captured band).
  let activeBackground: string | null = null;
  const postStageRaw = await redis.get(`meowcert:post-stage:${postId}`);
  if (postStageRaw) {
    try {
      const parsed = JSON.parse(postStageRaw) as { activeBackground?: string };
      activeBackground = parsed.activeBackground ?? null;
    } catch (err) {
      console.warn(`[preview] post-stage parse fail for ${postId}:`, err);
    }
  }

  // Song line uses the BACKING song's displayName (recognizable thing
  // like "Mahalia - I Wish I Missed My Ex"), NOT chart.title (which is
  // hardcoded 'My Beat' or 'Rehearsal' from the generator). Resolved
  // via BACKING_CATALOG[audioKey].
  //
  // Chart source priority: per-post snapshot (the chart that was
  // ACTUALLY published) > owner's current state.chart (legacy fallback
  // for posts created before per-post snapshots existed). Without this
  // gate, the splash showed whatever next chart the author was working
  // on, not the chart they posted.
  const postChartRaw = await redis.get(`meowcert:post-chart:${postId}`);
  let chart: Chart | undefined;
  if (postChartRaw) {
    try { chart = JSON.parse(postChartRaw) as Chart; }
    catch (err) { console.warn(`[preview] post-chart parse fail for ${postId}:`, err); }
  }
  if (!chart) {
    const ownerState = await loadOrInit(redis, ownerUsername);
    chart = ownerState.chart;
  }
  const audioKey = chart?.audioKey;
  const backing = audioKey ? BACKING_CATALOG[audioKey] : undefined;
  const title = backing?.displayName ?? chart?.title ?? 'a rhythm show';
  const vibe = chart?.vibe;
  const difficulty = chart?.difficulty;

  // The default subreddit-seeded post + any accidental empty-chart posts
  // have zero taps + zero holds + zero slides. splash.ts flips to the
  // loading-screen composition (V21 logo + PLAY NOW, no plays banner
  // or info panel) when this is false — matches the empty-chart branch
  // in VisitPost.ts so both surfaces read the same.
  const hasChart =
    !!chart &&
    (chart.steps.some((s) => s.lanes.length > 0) ||
      (chart.holds ?? []).length > 0 ||
      (chart.slides ?? []).length > 0 ||
      (chart.slideReturns ?? []).length > 0);

  return c.json({
    postId,
    ownerUsername,
    previewImage: previewImage ?? null,
    activeBackground,
    song: { title, vibe, difficulty },
    hasChart,
  });
});
