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

// Backing pulse — when a hit registers we briefly amplify the song
// itself so the player gets a "bigger" momentary read of whatever was
// playing at that beat (drums hitting + synth + meow stem from the
// song, however it happens to land). Concurrent pulses extend the hold
// instead of stacking so rapid taps don't blow the meter past clipping.
const PULSE_PEAK_MULTIPLIER = 1.25;     // 1.0 = baseline, 1.25 = +25% boost
const PULSE_ATTACK_SEC = 0.015;         // ramp up to peak
const PULSE_HOLD_SEC = 0.03;            // sit at peak briefly
const PULSE_DECAY_SEC = 0.2;            // exponential ride back to baseline

export class MusicSystem {
  private backing: Sound.BaseSound | null = null;
  private noteSynth: NoteSynth;
  private destroyed = false;
  /** Cached promise for the in-flight backing download. Calling preload()
   *  more than once for the same round is cheap — subsequent calls reuse
   *  this promise so start() and an upfront preload() resolve together. */
  private loadPromise: Promise<void> | null = null;
  /** AudioContext time at which the current pulse's decay finishes.
   *  Concurrent pulses while we're still ramping down just push this
   *  out further instead of cancelling + restarting the envelope. */
  private pulseEndsAt = 0;

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
    const backing = this.pickBacking();
    if (backing) {
      const tapKey = `tap-${backing.id}-${lane}`;
      if (this.scene.cache.audio.exists(tapKey)) {
        this.scene.sound.play(tapKey, { volume: TAP_SAMPLE_VOLUME });
        return;
      }
    }
    this.noteSynth.play(this.chart.vibe, lane);
  }

  /**
   * Brief amplification pulse on the backing track for the "oomph" hit
   * feedback. Web Audio gain automation produces a click-free envelope:
   * 15 ms ramp up to +25% gain, 30 ms hold, 200 ms exponential decay
   * back to baseline. Concurrent calls during decay push the decay end
   * out instead of stacking — rapid taps can't drive the gain past peak.
   *
   * No-op if the backing's underlying GainNode isn't accessible (e.g.
   * sound hasn't started, or Phaser's internal API changes). Cheap to
   * call on every hit; safe to ignore failures.
   */
  pulseBacking(): void {
    if (this.destroyed || !this.backing) return;
    // Phaser's WebAudioSound exposes the per-sound GainNode as
    // `volumeNode`. Duck-typed access so a non-WebAudio path (HTML5
    // audio fallback on rare browsers) is just a no-op.
    const node = (this.backing as unknown as { volumeNode?: GainNode }).volumeNode;
    if (!node) return;
    const ctx = node.context;
    if (ctx.state !== 'running') return;

    const baseline = BACKING_VOLUME;
    const peak = baseline * PULSE_PEAK_MULTIPLIER;
    const now = ctx.currentTime;

    if (now < this.pulseEndsAt) {
      // Still pulsing from a recent hit — just extend the decay to
      // the new end. Keeps gain pinned near peak through rapid taps
      // instead of bouncing it down and re-attacking which would
      // produce an audible warble.
      const newEnd = now + PULSE_DECAY_SEC;
      if (newEnd > this.pulseEndsAt) {
        node.gain.cancelScheduledValues(now);
        node.gain.setValueAtTime(peak, now);
        node.gain.exponentialRampToValueAtTime(baseline, newEnd);
        this.pulseEndsAt = newEnd;
      }
      return;
    }

    const attackEnd = now + PULSE_ATTACK_SEC;
    const holdEnd = attackEnd + PULSE_HOLD_SEC;
    const decayEnd = holdEnd + PULSE_DECAY_SEC;

    node.gain.cancelScheduledValues(now);
    node.gain.setValueAtTime(baseline, now);
    node.gain.linearRampToValueAtTime(peak, attackEnd);
    node.gain.setValueAtTime(peak, holdEnd);
    node.gain.exponentialRampToValueAtTime(baseline, decayEnd);

    this.pulseEndsAt = decayEnd;
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
