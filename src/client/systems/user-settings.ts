/**
 * Per-user playback preferences — effect intensity + audio. Lives in
 * localStorage (per-device, not synced across Reddit accounts because the
 * right volume / effect density depends on the player's actual hardware,
 * not their identity).
 *
 * - effectSizeMul: multiplier on burst + floating particle SIZE (1.0 = default)
 * - effectAlphaMul: multiplier on burst + floating particle ALPHA (1.0 = default)
 * - musicVolume: 0..1 master multiplier on backing + tap sounds
 * - muted: hard-overrides volume to 0 regardless of slider position
 *
 * cat-effects.ts and MusicSystem read getters on each emit / play so the
 * sliders take effect live without needing to rebuild anything.
 */

const STORAGE_KEY = 'meowcert.userSettings.v1';

export interface UserSettings {
  effectSizeMul: number;   // 0.3 .. 1.5
  effectAlphaMul: number;  // 0.0 .. 1.5
  musicVolume: number;     // 0 .. 1
  muted: boolean;
}

const DEFAULTS: UserSettings = {
  effectSizeMul: 1.0,
  effectAlphaMul: 1.0,
  musicVolume: 0.85,
  muted: false,
};

function loadFromStorage(): UserSettings {
  if (typeof window === 'undefined') return { ...DEFAULTS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<UserSettings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveToStorage(s: UserSettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // localStorage full / disabled — best-effort, settings stay in memory.
  }
}

let current: UserSettings = loadFromStorage();
const listeners = new Set<(s: UserSettings) => void>();

export function getUserSettings(): UserSettings {
  return current;
}

export function setUserSettings(partial: Partial<UserSettings>): void {
  current = { ...current, ...partial };
  saveToStorage(current);
  for (const fn of listeners) fn(current);
}

export function onUserSettingsChange(fn: (s: UserSettings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Effective music volume — 0 when muted, else musicVolume. Read by
 *  MusicSystem on each play (backing + taps) so the slider + toggle
 *  take effect live. */
export function getEffectiveMusicVolume(): number {
  return current.muted ? 0 : current.musicVolume;
}
