/**
 * Client wrapper for the publish flow. Single endpoint right now —
 * POST /api/publish/chart — that takes the caller's saved chart +
 * (optionally) a cat-stage snapshot and creates a Reddit post for it.
 * Returns the post id + permalink so the caller can show "your show
 * is live" with a tappable URL.
 *
 * previewImage is a base64 data URL of the cat-stage band captured
 * right before publish — Tim's call (capture timing makes more sense
 * at publish moment than on every Decorate leave, plus catches the
 * happy-cat celebration animation from the round just finished). The
 * server stores it keyed by the new post's id so splash.html can
 * fetch it as the per-post preview backdrop.
 */

export type PublishResult =
  | { ok: true; postId: string; url: string }
  | { ok: false; reason: string };

export async function publishChart(opts: {
  previewImage?: string;
  /** Score from the rehearsal run that's being published. Seeded as
   *  the post's first leaderboard entry server-side so visitors see
   *  the creator's score waiting to be beaten instead of an empty
   *  leaderboard. */
  creatorScore?: number;
  creatorAccuracy?: number;
} = {}): Promise<PublishResult> {
  try {
    const res = await fetch('/api/publish/chart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previewImage: opts.previewImage ?? null,
        creatorScore: opts.creatorScore ?? null,
        creatorAccuracy: opts.creatorAccuracy ?? null,
      }),
    });
    const data = (await res.json()) as { ok?: boolean; reason?: string; postId?: string; url?: string };
    if (!res.ok || data.ok !== true || !data.postId || !data.url) {
      return { ok: false, reason: data.reason ?? `HTTP ${res.status}` };
    }
    return { ok: true, postId: data.postId, url: data.url };
  } catch (err) {
    console.error('[publishChart] threw:', err);
    return { ok: false, reason: 'network error' };
  }
}
