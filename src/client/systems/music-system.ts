import { Scene, Sound, Loader } from 'phaser';
import {
  BACKING_CATALOG,
  type Chart,
  type LaneId,
  type BackingTrack,
} from '@/../shared/state';
import { NoteSynth } from './note-synth';

/**
 * Audio runtime for one round. Owns:
 *   - One looping backing instrumental (BGM, scene-owned, ~0.85 volume).
 *   - A NoteSynth that fires pitched tap tones tuned to the chart's
 *     vibe (replaces the meow stem sampler — see note-synth.ts).
 *
 * Lifecycle:
 *   const music = new MusicSystem(scene, chart);
 *   music.start();                        // kick the backing
 *   music.playTapForLane(0);              // on each successful hit
 *   music.stop();                         // round end
 *   music.destroy();                      // scene shutdown
 */
const BACKING_VOLUME = 0.85;
// Per-song tap samples come from inside the song's own mix so they sit
// at the song's own level. ~0.4 reads as confident but not louder than
// the backing — tune in playtest. NoteSynth fallback handles its own
// gain inside the synth so this constant is sample-only.
const TAP_SAMPLE_VOLUME = 0.4;

// Backing pulse was removed after the synth-taps iteration. The short
// version of the design history: reactive amplification on tap fights
// audio output buffer latency (5-50ms), and pre-scheduled amplification
// aligned to the chart grid fights mismatch between chart beats and
// the song's actual rhythm (especially bad on lo-fi like Midnight
// Coffee which doesn't even have a strict beat grid). Neither approach
// produced a synced "punch". The per-song tap sample carries the
// impact on its own; if more oomph is needed it'll come from a
// standalone additive thump that doesn't depend on the song timing.

export class MusicSystem {
  private backing: Sound.BaseSound | null = null;
  private noteSynth: NoteSynth;
  private destroyed = false;
  /** Cached promise for the in-flight backing download. Calling preload()
   *  more than once for the same round is cheap — subsequent calls reuse
   *  this promise so start() and an upfront preload() resolve together. */
  private loadPromise: Promise<void> | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly chart: Chart,
  ) {
    this.noteSynth = new NoteSynth(scene);
  }

  /**
   * Begin downloading the resolved backing track for this round. Idempotent
   * — call once from Game.create() to kick off the download in parallel
   * with scene setup, then start() awaits the same promise. Resolves
   * immediately if the asset is already cached.
   *
   * Errors are swallowed (resolves anyway) so a failed download produces
   * a silent round rather than a stuck modal.
   */
  preload(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    const backing = this.pickBacking();
    if (!backing) {
      this.loadPromise = Promise.resolve();
      return this.loadPromise;
    }
    const tapKeys: [string, string, string] = [
      `tap-${backing.id}-0`,
      `tap-${backing.id}-1`,
      `tap-${backing.id}-2`,
    ];
    const cache = this.scene.cache.audio;
    const needsBacking = !cache.exists(backing.audioKey);
    const needsTaps = tapKeys.some((k) => !cache.exists(k));
    if (!needsBacking && !needsTaps) {
      this.loadPromise = Promise.resolve();
      return this.loadPromise;
    }
    this.loadPromise = new Promise<void>((resolve) => {
      const loader = this.scene.load;
      const onComplete = () => {
        loader.off('loaderror', onError);
        resolve();
      };
      // Tap-sample load failures are silent — MusicSystem falls back to
      // NoteSynth for any lane whose sample didn't load. Only a backing
      // failure logs a warning since the round goes silent without it.
      const onError = (file: { key: string }) => {
        if (file.key === backing.audioKey) {
          console.warn(`[MusicSystem] backing load failed: ${backing.audioKey}`);
        }
      };
      if (needsBacking) {
        loader.audio(backing.audioKey, `assets/audio/backings/${backing.id}.mp3`);
      }
      for (let lane = 0; lane < 3; lane++) {
        if (!cache.exists(tapKeys[lane]!)) {
          loader.audio(tapKeys[lane]!, `assets/audio/taps/${backing.id}-${lane}.wav`);
        }
      }
      loader.once(Loader.Events.COMPLETE, onComplete);
      loader.on('loaderror', onError);
      if (!loader.isLoading()) loader.start();
    });
    return this.loadPromise;
  }

  /**
   * Start the backing track for this round. Awaits the lazy load if
   * needed — typically a no-op because Game.create kicked preload off
   * earlier and the file's already in cache by the time the player
   * taps PLAY on the Ready modal.
   *
   * No-op if the chart's BPM has no matching backing in the catalog
   * (silent round; meow taps still fire).
   */
  async start(): Promise<void> {
    if (this.destroyed) return;
    await this.preload();
    if (this.destroyed) return;
    const backing = this.pickBacking();
    if (!backing) return;
    if (!this.scene.cache.audio.exists(backing.audioKey)) return;
    this.backing = this.scene.sound.add(backing.audioKey, {
      loop: true,
      volume: BACKING_VOLUME,
    });
    this.backing.play();
  }

  /**
   * Fire a tap sound in response to a successful lane tap. Two layers:
   *
   *   1. If the song has per-lane sample WAVs in cache (preloaded
   *      alongside the backing), play that — the sample is sliced from
   *      the song itself so its timbre matches the backing exactly.
   *   2. Otherwise fall back to NoteSynth's per-vibe synthesized tone.
   *
   * Songs without samples still feel coherent because the synth chooses
   * a waveform + envelope matched to the chart's vibe.
   */
  playTapForLane(lane: LaneId): void {
    if (this.destroyed) return;
    // Layer 1: per-lane melodic content. Per-song sample when loaded,
    // else per-vibe synth tone.
    const backing = this.pickBacking();
    let played = false;
    if (backing) {
      const tapKey = `tap-${backing.id}-${lane}`;
      if (this.scene.cache.audio.exists(tapKey)) {
        this.scene.sound.play(tapKey, { volume: TAP_SAMPLE_VOLUME });
        played = true;
      }
    }
    if (!played) {
      this.noteSynth.play(this.chart.vibe, lane);
    }
    // Layer 2: sub-bass kick. Content-independent thump so the hit
    // always lands with impact, even when the song is in a quiet
    // passage where the per-song sample sounds disconnected from the
    // current backing content.
    this.noteSynth.playKick();
  }

  /**
   * Miss feedback — a brief low buzz so the player knows they missed
   * without the song losing momentum. Lane-independent; never uses
   * the per-song sample (would feel too rewarding for a miss).
   */
  playMiss(): void {
    if (this.destroyed) return;
    this.noteSynth.playMiss();
  }


  /** Stop the backing track immediately. Pending meow one-shots will
   *  finish playing — they're cheap and brief, no need to interrupt. */
  stop(): void {
    if (this.backing) {
      this.backing.stop();
    }
  }

  /** Full teardown — call from the scene's SHUTDOWN handler. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.backing) {
      this.backing.stop();
      this.backing.destroy();
      this.backing = null;
    }
    this.noteSynth.destroy();
  }

  /** Pick the backing this chart should play. Filters by tempo AND
   *  player-picked vibe; falls back to "any vibe at this tempo" if the
   *  chart has no vibe yet (old saves) or the chosen vibe has no
   *  catalog entries. Stable per saved version of the chart — the hash
   *  includes `updatedAt`, so saving again may roll a different
   *  backing within the same tempo+vibe bucket. */
  private pickBacking(): BackingTrack | null {
    const sameTempo = Object.values(BACKING_CATALOG).filter(
      (b) => b.bpm === this.chart.bpm,
    );
    if (sameTempo.length === 0) return null;
    let candidates = sameTempo;
    if (this.chart.vibe) {
      const sameVibe = sameTempo.filter((b) => b.vibe === this.chart.vibe);
      if (sameVibe.length > 0) candidates = sameVibe;
    }
    if (candidates.length === 1) return candidates[0]!;
    const hash = hashString(
      `${this.chart.authorId}:${this.chart.bpm}:${this.chart.vibe ?? ''}:${this.chart.updatedAt}`,
    );
    return candidates[hash % candidates.length]!;
  }

}

/** Tiny deterministic string hash. Good enough for picking-a-bucket
 *  use cases — never use for security. */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
