import Phaser, { Scene, Sound } from 'phaser';
import { AssetKeys } from '@/constants/assets';

/**
 * Cross-scene music manager for the menu + tutorial soundtrack.
 *
 * Tim's spec (locked 2026-06-30): Cozy plays EVERYWHERE — menus,
 * ChartEditor, every tutorial beat. The play-tutorial insane phase
 * lazy-loads + swaps to "Steel Phase Loop" for the joke run, then
 * swaps back to Cozy when Butters says "just kidding". When a player
 * attends someone else's post (VisitPost / Game-visitor-mode), the
 * post's own chart song takes over via MusicSystem and home music
 * gets out of the way (stopHomeMusic).
 *
 * Singleton on the Phaser global sound manager so the track survives
 * scene transitions without restarting mid-loop. Calling start() with
 * the same key is a no-op; switching keys CROSS-FADES — the new track
 * loads first, then both tracks play briefly while the new fades in
 * and the old fades out. No silent gap during lazy-load.
 *
 * ThemeCozyMusic is preloaded in Preloader so it's always instant.
 * Steel Phase Loop lazy-loads (~600 KB) on first request — Cozy keeps
 * playing UNDER the load so the player never hears silence.
 */

const FADE_MS = 240;
const VOLUME = 0.65;

const ASSET_PATHS: Record<string, string> = {
  [AssetKeys.Audio.InsaneMusic]: 'assets/audio/backings/steel-phase-loop.mp3',
};

let activeKey: string | null = null;
let activeSound: Sound.BaseSound | null = null;
let pendingKey: string | null = null;

function fadeIn(scene: Scene, sound: Sound.BaseSound): void {
  // The web-audio sound type exposes a writable `volume` getter/setter.
  // HTML5 falls back to setVolume. Cast through both shapes to keep types
  // happy across Phaser's two implementations.
  const s = sound as Sound.BaseSound & { volume?: number; setVolume?: (v: number) => void };
  if (typeof s.setVolume === 'function') s.setVolume(0);
  else s.volume = 0;
  scene.tweens.add({
    targets: { v: 0 },
    v: VOLUME,
    duration: FADE_MS,
    onUpdate: (tween) => {
      const v = (tween.getValue() as number | undefined) ?? 0;
      if (typeof s.setVolume === 'function') s.setVolume(v);
      else s.volume = v;
    },
  });
}

function fadeOutAndStop(scene: Scene, sound: Sound.BaseSound, onDone?: () => void): void {
  const s = sound as Sound.BaseSound & { volume?: number; setVolume?: (v: number) => void };
  const startV = (s.volume ?? VOLUME);
  scene.tweens.add({
    targets: { v: startV },
    v: 0,
    duration: FADE_MS,
    onUpdate: (tween) => {
      const v = (tween.getValue() as number | undefined) ?? 0;
      if (typeof s.setVolume === 'function') s.setVolume(v);
      else s.volume = v;
    },
    onComplete: () => {
      sound.stop();
      sound.destroy();
      onDone?.();
    },
  });
}

/** Start (or keep playing) the given audio key. No-op if it's already
 *  the active track. Cross-fades when switching keys — old track keeps
 *  playing while the new one lazy-loads, then both play briefly during
 *  the 240 ms cross-fade. No silent gap. */
export function startHomeMusic(scene: Scene, key: string): void {
  if (activeKey === key && activeSound && activeSound.isPlaying) return;
  pendingKey = key;
  if (scene.cache.audio.exists(key)) {
    swapTo(scene, key);
    return;
  }
  // Lazy-load — DO NOT touch activeSound yet. Old track keeps playing.
  const path = ASSET_PATHS[key];
  if (!path) {
    console.warn(`[home-music] missing audio key ${key} — skipping`);
    return;
  }
  const loader = scene.load;
  loader.audio(key, path);
  loader.once(Phaser.Loader.Events.COMPLETE, () => {
    // Bail if a different key took over while loading.
    if (pendingKey !== key) return;
    swapTo(scene, key);
  });
  loader.once(`loaderror`, (file: { key: string }) => {
    if (file.key === key) console.warn(`[home-music] load failed for ${key}`);
  });
  loader.start();
}

function swapTo(scene: Scene, key: string): void {
  const newSound = scene.sound.add(key, { loop: true, volume: 0 });
  newSound.play();
  fadeIn(scene, newSound);
  // Cross-fade — keep the old sound playing while the new one fades in,
  // then stop it. No silent gap between tracks.
  if (activeSound) fadeOutAndStop(scene, activeSound);
  activeSound = newSound;
  activeKey = key;
  pendingKey = null;
}

/** Stop the home track (used when a player enters someone else's post
 *  so the post's chart song can take over without competing audio). */
export function stopHomeMusic(scene: Scene): void {
  pendingKey = null;
  if (!activeSound) return;
  const prev = activeSound;
  activeSound = null;
  activeKey = null;
  fadeOutAndStop(scene, prev);
}

/** Convenience — Steel Phase Loop plays under the play-tutorial insane
 *  joke run. Lazy-loaded on first call; Cozy keeps playing during the
 *  load so there's no silent gap. */
export function playInsaneMusic(scene: Scene): void {
  startHomeMusic(scene, AssetKeys.Audio.InsaneMusic);
}

/** Kick off the Steel Phase Loop download WITHOUT swapping tracks.
 *  Called as early as the tutorial Game scene boots so the file is in
 *  cache by the time the player taps Yes on the insane pre-roll gate
 *  — without this, `playInsaneMusic` lazy-loads after the tap and the
 *  swap audibly delays the joke beat. Idempotent — repeat calls after
 *  the file is cached are no-ops. */
export function preloadInsaneMusic(scene: Scene): void {
  const key = AssetKeys.Audio.InsaneMusic;
  if (scene.cache.audio.exists(key)) return;
  const path = ASSET_PATHS[key];
  if (!path) return;
  const loader = scene.load;
  loader.audio(key, path);
  loader.once(`loaderror`, (file: { key: string }) => {
    if (file.key === key) console.warn(`[home-music] preload failed for ${key}`);
  });
  loader.start();
}

/** Cozy theme — plays EVERYWHERE per Tim's spec: menus, ChartEditor,
 *  every tutorial beat. ThemeCozyMusic is preloaded in Preloader so
 *  every swap into Cozy is instant. */
export function playCozyMusic(scene: Scene): void {
  startHomeMusic(scene, AssetKeys.Audio.ThemeCozyMusic);
}
