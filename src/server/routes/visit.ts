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

  const ownerState = await loadOrInit(redis, ownerUsername);

  // Trim ownedCats to just the ones in seated slots — the visitor
  // doesn't need the owner's whole collection, only the cats showing
  // on their stage. Keeps the payload small (~3 entries vs dozens).
  const seatedInstanceIds = new Set(
    Object.values(ownerState.seatedCats ?? {}).filter((v): v is string => typeof v === 'string'),
  );
  const seatedOwnedCats = (ownerState.ownedCats ?? []).filter((c) => seatedInstanceIds.has(c.id));

  // Per-cat equipped cosmetics are also load-bearing for the render
  // (the splash should mirror exactly what the owner sees in Decorate).
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

  // Whether the requester IS the owner — lets the client suppress
  // visitor-mode UI when an owner navigates to their own post URL.
  const currentUsername = (await reddit.getCurrentUsername()) ?? 'anonymous';
  const isOwner = currentUsername === ownerUsername;

  return c.json({
    postId,
    ownerUsername,
    isOwner,
    stage: {
      seatedCats: ownerState.seatedCats ?? {},
      activeBackground: ownerState.activeBackground ?? 'stage',
      ownedCats: seatedOwnedCats,
      equippedCosmetics: equippedSlice,
      equippedCosmeticTypes: equippedTypesSlice,
    },
  });
});
