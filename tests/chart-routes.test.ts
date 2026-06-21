import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { makeChartRouter } from '../src/server/routes/chart';
import { emptyChart } from '../src/shared/state';
import type { Chart } from '../src/shared/state';

// chart.ts exports a makeChartRouter(deps) factory that returns a Hono sub-router.
// In production, api.ts mounts it at '/chart'. In tests we wire it the same way
// with an in-memory store so we can test without Devvit's redis/reddit globals.

describe('chart routes', () => {
  function makeApp() {
    const store = new Map<string, unknown>();
    const router = makeChartRouter({
      getUsername: async () => 'alice',
      readState: async (u: string) => store.get(u),
      writeState: async (u: string, s: unknown) => { store.set(u, s); },
    });
    const app = new Hono();
    app.route('/chart', router);
    return { app, store };
  }

  it('POST /chart/save persists a valid chart', async () => {
    const { app, store } = makeApp();
    const c: Chart = emptyChart('alice', 'my beat');
    c.steps[0] = { lanes: [0] };
    const res = await app.request('/chart/save', {
      method: 'POST',
      body: JSON.stringify(c),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect((store.get('alice') as any).chart.title).toBe('my beat');
  });

  it('POST /chart/save rejects invalid bpm', async () => {
    const { app } = makeApp();
    const c: Chart = emptyChart('alice', 'x');
    c.bpm = 999;
    const res = await app.request('/chart/save', {
      method: 'POST',
      body: JSON.stringify(c),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it("GET /chart returns the requested user's chart", async () => {
    const { app, store } = makeApp();
    const c: Chart = emptyChart('bob', 'bob beat');
    store.set('bob', { chart: c });
    const res = await app.request('/chart?author=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe('bob beat');
  });
});
