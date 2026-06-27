import { Hono } from 'hono';
import { redis, reddit } from '@devvit/web/server';
import { loadOrInit } from '../core/player-state';

/**
 * Visitor-splash data endpoint. Mounted at /api/visit.
 *
 * GET /api/visit?postId=<id> — given a Reddit post id, returns the
 * owner's stage configuration (seated cats + active background) so the
 * VisitPost scene can render the owner's stage as the splash backdrop.
 * Returns 404 when the post has no owner mapping (i.e. wasn't created
 * by our publish flow).
 *
 * The chart + leaderboard live on their own endpoints (/api/chart and
 * /api/social/leaderboard) so the client can fire all three in
 * parallel and paint the splash as each resolves.
 */
export const visit = new Hono();

visit.get('/', async (c) => {
  const postId = c.req.query('postId');
  if (!postId) return c.json({ error: 'missing postId' }, 400);

  const ownerUsername = await redis.get(`meowcert:post-owner:${postId}`);
  if (!ownerUsername) {
    return c.json({ error: 'post has no owner mapping' }, 404);
  }

  // Prefer the per-post stage snapshot (written by publish.ts at
  // publish time) so the visitor sees the cats / bg / cosmetics the
  // author had set when they posted, not whatever drifted since.
  // Falls back to the owner's current state for legacy posts that
  // predate per-post storage. Tim: "the cats and backgrounds that i
  // set for the show are not showing up" — was the same drift issue
  // we already fixed for the per-post chart.
  let stage: {
    seatedCats: Record<string, string | null>;
    activeBackground: string;
    ownedCats: unknown[];
    equippedCosmetics: Record<string, Record<string, string>>;
    equippedCosmeticTypes: Record<string, Record<string, string>>;
  } | null = null;

  const postStageRaw = await redis.get(`meowcert:post-stage:${postId}`);
  if (postStageRaw) {
    try { stage = JSON.parse(postStageRaw); }
    catch (err) { console.warn(`[visit] post-stage parse fail for ${postId}:`, err); }
  }

  if (!stage) {
    // Legacy fallback — owner's current state.
    const ownerState = await loadOrInit(redis, ownerUsername);
    const seatedInstanceIds = new Set(
      Object.values(ownerState.seatedCats ?? {}).filter((v): v is string => typeof v === 'string'),
    );
    const seatedOwnedCats = (ownerState.ownedCats ?? []).filter((c) => seatedInstanceIds.has(c.id));
    const equippedSlice: Record<string, Record<string, string>> = {};
    for (const id of seatedInstanceIds) {
      const slots = ownerState.equippedCosmetics?.[id];
      if (slots) equippedSlice[id] = slots;
    }
    const equippedTypesSlice: Record<string, Record<string, string>> = {};
    for (const id of seatedInstanceIds) {
      const types = ownerState.equippedCosmeticTypes?.[id];
      if (types) equippedTypesSlice[id] = types;
    }
    stage = {
      seatedCats: (ownerState.seatedCats ?? {}) as Record<string, string | null>,
      activeBackground: ownerState.activeBackground ?? 'stage',
      ownedCats: seatedOwnedCats,
      equippedCosmetics: equippedSlice,
      equippedCosmeticTypes: equippedTypesSlice,
    };
  }

  // Whether the requester IS the owner — lets the client suppress
  // visitor-mode UI when an owner navigates to their own post URL.
  const currentUsername = (await reddit.getCurrentUsername()) ?? 'anonymous';
  const isOwner = currentUsername === ownerUsername;

  return c.json({
    postId,
    ownerUsername,
    isOwner,
    stage,
  });
});
