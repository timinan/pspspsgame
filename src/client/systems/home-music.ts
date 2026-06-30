import { Scene, Sound } from 'phaser';
import { AssetKeys } from '@/constants/assets';

/**
 * Cross-scene music manager for the menu + tutorial soundtrack.
 *
 * Tim's spec: a single backing track ("Lantern Tutorial") loops under
 * every menu scene + tutorial beat. The play-tutorial insane phase
 * swaps to "Steel Phase Loop" for the joke run. When a player attends
 * someone else's post (VisitPost / Game-visitor-mode), the post's own
 * chart song takes over via MusicSystem and home music gets out of the
 * way.
 *
 * Singleton on the Phaser global sound manager so the track survives
 * scene transitions without restarting mid-loop. Calling start() with
 * the same key is a no-op; switching keys cross-fades.
 */

const FADE_MS = 240;
const VOLUME = 0.65;

let activeKey: string | null = null;
let activeSound: Sound.BaseSound | null = null;

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
 *  the active track. Cross-fades when switching keys. */
export function startHomeMusic(scene: Scene, key: string): void {
  if (activeKey === key && activeSound && activeSound.isPlaying) return;
  if (activeSound) {
    const prev = activeSound;
    activeSound = null;
    activeKey = null;
    fadeOutAndStop(scene, prev, () => spawn(scene, key));
    return;
  }
  spawn(scene, key);
}

function spawn(scene: Scene, key: string): void {
  if (!scene.cache.audio.exists(key)) {
    console.warn(`[home-music] missing audio key ${key} — skipping`);
    return;
  }
  const sound = scene.sound.add(key, { loop: true, volume: 0 });
  sound.play();
  activeSound = sound;
  activeKey = key;
  fadeIn(scene, sound);
}

/** Stop the home track (used when a player enters someone else's post
 *  so the post's chart song can take over without competing audio). */
export function stopHomeMusic(scene: Scene): void {
  if (!activeSound) return;
  const prev = activeSound;
  activeSound = null;
  activeKey = null;
  fadeOutAndStop(scene, prev);
}

/** Convenience — Lantern Tutorial loops under menus + tutorial beats. */
export function playTutorialMusic(scene: Scene): void {
  startHomeMusic(scene, AssetKeys.Audio.TutorialMusic);
}

/** Convenience — Steel Phase Loop plays under the play-tutorial insane
 *  joke run. */
export function playInsaneMusic(scene: Scene): void {
  startHomeMusic(scene, AssetKeys.Audio.InsaneMusic);
}
