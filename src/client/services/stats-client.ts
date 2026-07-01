import type { PlayerState, RoundStatsDelta } from '../../shared/state';

/** POST /api/stats/round — folds the round's counters into
 *  PlayerStats server-side. Fire-and-forget from the caller's POV;
 *  the return type surfaces the updated state so callers that need
 *  to refresh a stats view (dressing-room profile, future user-mgmt
 *  tool) can pick up the new values without a follow-up /state fetch.
 *
 *  Failure surfacing: any network / server error is caught and
 *  logged. Stats aren't critical-path — a dropped delta is worth less
 *  than blocking the round-end UX. */
export async function submitRoundStats(
  delta: RoundStatsDelta,
): Promise<{ ok: boolean; state?: PlayerState }> {
  try {
    const r = await fetch('/api/stats/round', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(delta),
    });
    if (!r.ok) {
      console.warn('[stats-client] round submit failed:', r.status);
      return { ok: false };
    }
    const body = (await r.json()) as { ok?: boolean; state?: PlayerState };
    return { ok: body.ok === true, state: body.state };
  } catch (err) {
    console.warn('[stats-client] round submit threw:', err);
    return { ok: false };
  }
}
