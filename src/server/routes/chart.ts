import { Hono } from 'hono';
import { redis, reddit } from '@devvit/web/server';
import { loadOrInit, save } from '../core/player-state';
import { validateChart } from '../../shared/state';
import type { Chart } from '../../shared/state';

// -- Dependency-injection interface ------------------------------------
// Allows the router to be tested without Devvit globals.

export interface ChartDeps {
  getUsername: () => Promise<string>;
  readState: (username: string) => Promise<unknown>;
  writeState: (username: string, state: unknown) => Promise<void>;
}

/**
 * Factory that returns a Hono sub-router wired to the given deps.
 * In production, api.ts calls makeChartRouter(devvitDeps).
 * In tests, a lightweight in-memory store is injected instead.
 *
 * Routes (mounted under /chart by the parent router):
 *   POST /save   — host saves their authored chart
 *   GET  /       — visitor fetches the host's chart (?author=<username>)
 */
export function makeChartRouter(deps: ChartDeps): Hono {
  const r = new Hono();

  /** POST /chart/save — validate, stamp server-side fields, persist. */
  r.post('/save', async (c) => {
    const username = await deps.getUsername();
    const chart = (await c.req.json()) as Chart;

    // Validate before touching any server-authoritative fields.
    const v = validateChart(chart);
    if (!v.ok) return c.json({ error: v.reason }, 400);

    // Override client-supplied identity fields — server is authoritative.
    chart.authorId = username;
    chart.updatedAt = Date.now();

    const state = ((await deps.readState(username)) as Record<string, unknown>) ?? {};
    state.chart = chart;
    await deps.writeState(username, state);
    return c.json({ ok: true });
  });

  /** GET /chart?author=<username> — return the author's saved chart. */
  r.get('/', async (c) => {
    const author = c.req.query('author');
    if (!author) return c.json({ error: 'missing author' }, 400);

    const state = (await deps.readState(author)) as { chart?: Chart } | undefined;
    if (!state?.chart) return c.json({ error: 'no chart' }, 404);
    return c.json(state.chart);
  });

  return r;
}

// -- Production sub-router wired to Devvit globals -------------------

async function currentUsername(): Promise<string> {
  const username = await reddit.getCurrentUsername();
  return username ?? 'anonymous';
}

export const chart = makeChartRouter({
  getUsername: currentUsername,
  readState: async (username) => {
    const player = await loadOrInit(redis, username);
    return player;
  },
  writeState: async (_username, state) => {
    // state here is the full PlayerState — save it back.
    await save(redis, state as Parameters<typeof save>[1]);
  },
});
