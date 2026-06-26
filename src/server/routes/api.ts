import { Hono } from 'hono';
import { context, redis, reddit } from '@devvit/web/server';
import type {
  DecrementResponse,
  IncrementResponse,
  InitResponse,
} from '../../shared/api';
import { state } from './state';
import { chart } from './chart';
import { social } from './social';
import { publish } from './publish';
import { visit } from './visit';
import { preview } from './preview';

type ErrorResponse = {
  status: 'error';
  message: string;
};

export const api = new Hono();

// Phase 2 player-state routes: /api/state, /api/box/open, /api/coins/sync,
// /api/cosmetic/equip, /api/onboarding/complete.
api.route('/', state);

// Phase 5 chart routes: /api/chart/save, /api/chart?author=<username>.
api.route('/chart', chart);

// Phase 6 social-loop routes: /api/social/play, /leaderboard, /inbox,
// /gift, /post-owner. See routes/social.ts for the full surface.
api.route('/social', social);

// Publish flow — POST /api/publish/chart turns the author's saved chart
// into a live Reddit post + wires post-owner mapping in one call.
api.route('/publish', publish);

// Visitor splash — GET /api/visit?postId=X returns the owner's stage
// (seated cats + bg + per-cat cosmetics) so the VisitPost scene can
// render the owner's stage as the splash backdrop.
api.route('/visit', visit);

// Preview-image endpoints — POST /api/preview-image stores the
// caller's cat-stage snapshot, GET /api/preview-image?postId=X returns
// the post owner's stored image + chart metadata so splash.html can
// render the owner's actual stage as the feed-preview backdrop.
api.route('/preview-image', preview);

// Per-post chart snapshot — `meowcert:post-chart:<postId>` written by
// publish.ts. VisitPost reads this in place of /chart?author=<username>
// so the splash always renders the chart that was actually published
// (instead of whatever the author is editing now).
api.get('/post-chart', async (c) => {
  const postId = c.req.query('postId');
  if (!postId) return c.json({ ok: false, reason: 'missing postId' }, 400);
  const raw = await redis.get(`meowcert:post-chart:${postId}`);
  if (!raw) return c.json({ ok: false, reason: 'no per-post chart' }, 404);
  try {
    const chart = JSON.parse(raw) as unknown;
    return c.json({ ok: true, chart });
  } catch {
    return c.json({ ok: false, reason: 'corrupt' }, 500);
  }
});

api.get('/init', async (c) => {
  const { postId } = context;

  if (!postId) {
    console.error('API Init Error: postId not found in devvit context');
    return c.json<ErrorResponse>(
      {
        status: 'error',
        message: 'postId is required but missing from context',
      },
      400
    );
  }

  try {
    const [count, username] = await Promise.all([
      redis.get('count'),
      reddit.getCurrentUsername(),
    ]);

    return c.json<InitResponse>({
      type: 'init',
      postId: postId,
      count: count ? parseInt(count) : 0,
      username: username ?? 'anonymous',
    });
  } catch (error) {
    console.error(`API Init Error for post ${postId}:`, error);
    let errorMessage = 'Unknown error during initialization';
    if (error instanceof Error) {
      errorMessage = `Initialization failed: ${error.message}`;
    }
    return c.json<ErrorResponse>(
      { status: 'error', message: errorMessage },
      400
    );
  }
});

api.post('/increment', async (c) => {
  const { postId } = context;
  if (!postId) {
    return c.json<ErrorResponse>(
      {
        status: 'error',
        message: 'postId is required',
      },
      400
    );
  }

  const count = await redis.incrBy('count', 1);
  return c.json<IncrementResponse>({
    count,
    postId,
    type: 'increment',
  });
});

api.post('/decrement', async (c) => {
  const { postId } = context;
  if (!postId) {
    return c.json<ErrorResponse>(
      {
        status: 'error',
        message: 'postId is required',
      },
      400
    );
  }

  const count = await redis.incrBy('count', -1);
  return c.json<DecrementResponse>({
    count,
    postId,
    type: 'decrement',
  });
});
