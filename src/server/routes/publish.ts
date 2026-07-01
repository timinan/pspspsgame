import { Hono } from 'hono';
import { redis, reddit, context } from '@devvit/web/server';
import { loadOrInit, save } from '../core/player-state';
import {
  setPostOwner,
  submitLeaderboardScore,
  setPinnedCommentId,
  incrementPlayCount,
  incrementCombinedScore,
  incrementPassCount,
  getPassCount,
  getFirstPasser,
  fetchCombinedScore,
  fetchLeaderboard,
} from '../core/social';
import { classifyScore, formatPinnedSummary } from '../../shared/social-loop';
import { BACKING_CATALOG } from '../../shared/state';

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
      // `entry` was missing from every submitCustomPost call we shipped
      // today — every example in Devvit docs passes it, and the docs
      // explicitly say "the entry parameter references one of these
      // keys" (referring to devvit.json's entrypoints). Without `entry`
      // Devvit may be creating a post whose entrypoint binding is
      // incomplete, which would explain navigateTo not being able to
      // route to it. 'default' is our splash entrypoint per devvit.json.
      entry: 'default',
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

    // Stats — count the show. Best-effort: a stats bump failure MUST
    // NOT unwind the publish (post already exists on Reddit). Re-load
    // the state so we don't stomp any concurrent writes from other
    // routes with the older `state` snapshot from line 40.
    try {
      const author = await loadOrInit(redis, username);
      author.stats.showsPosted += 1;
      await save(redis, author);
    } catch (err) {
      console.error('[publish] author stats bump failed (continuing)', err);
    }

    // Bot-pinned root comment — the anchor that auto-stats comments
    // nest under on every play (Nuzzle-style social loop). Posted as
    // APP + distinguished as mod + stickied. Best-effort: failure
    // here MUST NOT block the publish — post still ships, the /play
    // handler just skips the auto-stats reply for this post (its
    // `getPinnedCommentId` returns null). App is auto-mod in the
    // installed sub so distinguish(true) works without extra perms.
    try {
      const pinned = await reddit.submitComment({
        id: post.id,
        text:
          '🏆 **Champions Who Played This Show**\n\n' +
          '*Stats from every play land below. Tap the post to play and your run gets auto-posted here.*',
        runAs: 'APP',
      });
      await pinned.distinguish(true); // makeSticky = true
      await setPinnedCommentId(redis, post.id, pinned.id);
      console.info(`[publish] pinned root comment ${pinned.id} for ${post.id}`);
    } catch (err) {
      console.error('[publish] pinned root comment creation failed (continuing publish)', err);
    }

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

    // Per-post STAGE snapshot — same idea as per-post chart: visitor
    // should see the cats + bg + cosmetics the author had set at
    // publish time, not whatever the author's current Decorate state
    // drifted to since. Tim: "the cats and backgrounds that i set for
    // the show are not showing up". Stored under
    // meowcert:post-stage:<postId>; consumed by visit.ts with the
    // ownerState fallback for legacy posts.
    try {
      // Trim ownedCats to just the seated ones — visitor doesn't need
      // the whole collection. Same trim visit.ts does on the fallback
      // path.
      const seatedInstanceIds = new Set(
        Object.values(state.seatedCats ?? {}).filter((v): v is string => typeof v === 'string'),
      );
      const seatedOwnedCats = (state.ownedCats ?? []).filter((c) => seatedInstanceIds.has(c.id));
      const equippedSlice: Record<string, Record<string, string>> = {};
      for (const id of seatedInstanceIds) {
        const slots = state.equippedCosmetics?.[id];
        if (slots) equippedSlice[id] = slots;
      }
      // equippedCosmeticTypes is a FLAT map: cosInstanceId → typeId
      // (per PlayerState in shared/state.ts:581). Previous code indexed
      // by catInstanceId which always returned undefined and saved an
      // empty types slice — that's why Tim's visitor splash showed
      // naked cats. Trim to only the cosmetic instances equipped on
      // seated cats so the snapshot stays small.
      const equippedCosInstanceIds = new Set<string>();
      for (const id of seatedInstanceIds) {
        const slots = state.equippedCosmetics?.[id];
        if (!slots) continue;
        for (const cosId of Object.values(slots)) {
          if (cosId) equippedCosInstanceIds.add(cosId);
        }
      }
      const equippedTypesSlice: Record<string, string> = {};
      for (const cosId of equippedCosInstanceIds) {
        const typeId = state.equippedCosmeticTypes?.[cosId];
        if (typeId) equippedTypesSlice[cosId] = typeId;
      }
      const stageSnapshot = {
        seatedCats: state.seatedCats ?? {},
        activeBackground: state.activeBackground ?? 'stage',
        ownedCats: seatedOwnedCats,
        equippedCosmetics: equippedSlice,
        equippedCosmeticTypes: equippedTypesSlice,
      };
      await redis.set(`meowcert:post-stage:${post.id}`, JSON.stringify(stageSnapshot));
      console.info(`[publish] stored per-post stage for ${post.id} (bg=${stageSnapshot.activeBackground}, seatedCount=${seatedInstanceIds.size})`);
    } catch (err) {
      console.warn('[publish] per-post stage write failed:', err);
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
      // Also count the seed as a play in the post-stats counters so the
      // pinned summary shows "1 play" right after publish (and "1 pass"
      // when the creator rehearsed at >= 75% accuracy). Owner self-plays
      // count toward overall stats per Tim's call. Best-effort — pinned
      // summary tolerates missing counters.
      try { await incrementPlayCount(redis, post.id); }
      catch (err) { console.warn('[publish] seed incrementPlayCount failed (continuing)', err); }
      try { await incrementCombinedScore(redis, post.id, creatorScore); }
      catch (err) { console.warn('[publish] seed incrementCombinedScore failed (continuing)', err); }
      if (creatorAccuracy >= 0.75) {
        try { await incrementPassCount(redis, post.id); }
        catch (err) { console.warn('[publish] seed incrementPassCount failed (continuing)', err); }
      }
    } else {
      console.info(`[publish] skipped creator seed — score=${creatorScore} acc=${creatorAccuracy}`);
    }

    // Initial pinned mod comment refresh — replace the static welcome
    // text written at pin-time with the live stats summary so the very
    // first thing a visitor sees on a freshly-published post is the
    // dashboard. Subsequent plays refresh it again from /play.
    // Best-effort: failure leaves the pinned comment with the static
    // welcome text (still functional, just not yet showing live stats).
    try {
      const pinnedId = await redis.get(`meowcert:post-pinned-comment:${post.id}`);
      if (pinnedId) {
        const lb = await fetchLeaderboard(redis, post.id, null);
        // Top INCLUDES owner — creator is default top until a non-owner
        // beats them. isCreator drives the '(creator)' suffix in the
        // formatter. Per Tim's call.
        const topEntry = lb.top[0];
        const topPlayer = topEntry
          ? { username: topEntry.visitor, score: topEntry.score, isCreator: topEntry.visitor === username }
          : null;
        const firstPasser = await getFirstPasser(redis, post.id);
        const passCount = await getPassCount(redis, post.id);
        const combinedScore = await fetchCombinedScore(redis, post.id);
        const audioKey = chart.audioKey;
        const songTitle = audioKey ? (BACKING_CATALOG[audioKey]?.displayName ?? null) : null;
        const summaryBody = formatPinnedSummary({
          ownerUsername: username,
          difficulty: chart.difficulty ?? null,
          songTitle,
          totalPlays: lb.totalPlays,
          passCount,
          combinedScore,
          topPlayer,
          firstPasser,
        });
        console.info('[publish] computing pinned summary', {
          pinnedId,
          totalPlays: lb.totalPlays,
          passCount,
          combinedScore,
          topPlayer,
          firstPasser,
          bodyLen: summaryBody.length,
        });
        const comment = await reddit.getCommentById(pinnedId);
        await comment.edit({ text: summaryBody, runAs: 'APP' });
        console.info(`[publish] initial pinned summary refresh for ${post.id}`);
      }
    } catch (err) {
      console.error('[publish] initial pinned summary refresh failed (continuing)', err);
    }

    // Long form `https://reddit.com${post.permalink}` — proven to work
    // alongside the entry:'default' fix in 9e409ee. The short form
    // `https://reddit.com/comments/<id>/` (Discord-respondent
    // suggestion, shipped briefly in 589add6) regressed OPEN POST per
    // Tim's testing — reverted here. entry:'default' was the actual
    // missing piece, not the URL form.
    const url = `https://reddit.com${post.permalink}`;
    console.info('[publish] returning ok', {
      postId: post.id,
      authorName: post.authorName,
      subredditName: post.subredditName,
      url,
      'post.url': post.url,
      'post.permalink': post.permalink,
      runAs: 'USER',
      entry: 'default',
    });
    return c.json({ ok: true, postId: post.id, url, permalink: post.permalink });
  } catch (err) {
    console.error('[publish] failed to create post:', err);
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, reason: `reddit error: ${msg.slice(0, 80)}` }, 500);
  }
});
