import { Scene, Sound } from 'phaser';
import {
  BACKING_CATALOG,
  MEOW_STEM_CATALOG,
  type Chart,
  type LaneId,
  type BackingTrack,
} from '@/../shared/state';

/**
 * Audio runtime for one round. Owns:
 *   - One looping backing instrumental (BGM, scene-owned, ~0.85 volume).
 *   - A pool of meow stems played as one-shots on lane taps (SFX, ~0.55).
 *
 * Replaces the Tone.js `SongPlayer`. No runtime pitch shifting, no
 * scheduled meow timeline — taps drive meow firing directly, the
 * backing carries the song.
 *
 * Lifecycle:
 *   const music = new MusicSystem(scene, chart);
 *   music.start();                        // kick the backing
 *   music.playMeowForLane(0);             // on each successful hit
 *   music.stop();                         // round end
 *   music.destroy();                      // scene shutdown
 *
 * Volumes were Tim's call (2026-06-22): backing forward, meows as
 * accents. Tune in playtest.
 */
const BACKING_VOLUME = 0.85;
// Meows pulled down to 0.2 — Tim wants them faint so they read as
// gentle confirmations on top of the song, not a vocal layer.
const MEOW_VOLUME = 0.2;

export class MusicSystem {
  private backing: Sound.BaseSound | null = null;
  private lastMeowKey: string | null = null;
  private destroyed = false;

  constructor(
    private readonly scene: Scene,
    private readonly chart: Chart,
  ) {}

  /**
   * Start the backing track for this round. Picks the backing by hashing
   * (authorId + bpm) so the same chart always sounds like the same song.
   * No-op if the chart's BPM has no matching backing in the catalog
   * (silent round; meow taps still fire).
   */
  start(): void {
    if (this.destroyed) return;
    const backing = this.pickBacking();
    if (!backing) return;
    if (!this.scene.cache.audio.exists(backing.audioKey)) {
      // Asset not loaded — defensive guard; Preloader should have it.
      console.warn(`[MusicSystem] backing audio key missing: ${backing.audioKey}`);
      return;
    }
    this.backing = this.scene.sound.add(backing.audioKey, {
      loop: true,
      volume: BACKING_VOLUME,
    });
    this.backing.play();
  }

  /**
   * Fire a meow stem in response to a successful lane tap. Filters
   * MEOW_STEM_CATALOG by lane first; if no per-lane stem exists yet,
   * falls back to any catalog entry so taps still feel responsive
   * during the catalog-growth phase. Re-rolls once if the same stem
   * key came up twice in a row to dodge audible repeats on rapid taps.
   */
  playMeowForLane(lane: LaneId): void {
    if (this.destroyed) return;
    const pool = this.poolForLane(lane);
    if (pool.length === 0) return;
    let pick = pool[Math.floor(Math.random() * pool.length)]!;
    if (pool.length > 1 && pick.audioKey === this.lastMeowKey) {
      pick = pool[Math.floor(Math.random() * pool.length)]!;
    }
    if (!this.scene.cache.audio.exists(pick.audioKey)) return;
    this.scene.sound.play(pick.audioKey, { volume: MEOW_VOLUME });
    this.lastMeowKey = pick.audioKey;
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
    this.lastMeowKey = null;
  }

  /** Pick the backing this chart should play. Stable per saved version
   *  of the chart — the hash includes `updatedAt`, so saving the chart
   *  again may roll a different backing. That gives creators a "save to
   *  shuffle" affordance during authoring while still keeping the same
   *  saved chart sounding identical to every visitor on every play. */
  private pickBacking(): BackingTrack | null {
    const candidates = Object.values(BACKING_CATALOG).filter(
      (b) => b.bpm === this.chart.bpm,
    );
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0]!;
    const hash = hashString(
      `${this.chart.authorId}:${this.chart.bpm}:${this.chart.updatedAt}`,
    );
    return candidates[hash % candidates.length]!;
  }

  private poolForLane(lane: LaneId) {
    const perLane = MEOW_STEM_CATALOG.filter((s) => s.lane === lane);
    return perLane.length > 0 ? perLane : MEOW_STEM_CATALOG;
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
