import type { GenDifficulty } from '@/../shared/chart-generator';

/**
 * Local-only personal-best store for rehearsal — replaces the social
 * leaderboard inside the single-player practice loop. Stored under one
 * localStorage key as a JSON map of `"${audioKey}:${difficulty}"` →
 * highest score the player has hit on that exact chart.
 *
 * Why localStorage: rehearsal is intentionally a private "practice room"
 * — zero rewards, zero social signal, just a number you're trying to
 * beat. Persisting it server-side would invite cross-device sync work
 * for a feature that has no shared surface.
 */

const STORAGE_KEY = 'meowcert:rehearsal-best';

type BestMap = Record<string, number>;

function readMap(): BestMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as BestMap;
    return {};
  } catch {
    return {};
  }
}

function writeMap(map: BestMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Quota / private-mode failure — silently no-op. Best score is a
    // nice-to-have, not load-bearing.
  }
}

function keyFor(audioKey: string, difficulty: GenDifficulty): string {
  return `${audioKey}:${difficulty}`;
}

/** Highest score the player has hit on this chart. Returns 0 if never
 *  played (caller treats 0 as "no best yet" — fine because a real run
 *  always scores > 0 if any notes were hit). */
export function getBest(audioKey: string, difficulty: GenDifficulty): number {
  const map = readMap();
  return map[keyFor(audioKey, difficulty)] ?? 0;
}

/** Write `score` if it beats the stored best. Returns true when a new
 *  best was recorded so the caller can flash a "NEW BEST!" badge. */
export function setBestIfHigher(
  audioKey: string,
  difficulty: GenDifficulty,
  score: number,
): boolean {
  const map = readMap();
  const k = keyFor(audioKey, difficulty);
  const prev = map[k] ?? 0;
  if (score <= prev) return false;
  map[k] = score;
  writeMap(map);
  return true;
}
