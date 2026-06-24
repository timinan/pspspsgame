import { Scene } from 'phaser';
import type { LaneId, BackingVibe } from '@/../shared/state';

/**
 * Web Audio runtime synthesizer. Replaces sampled meow stems with
 * per-vibe pitched tones — each lane tap fires a single oscillator
 * with an envelope tuned to fit the backing song's vibe.
 *
 * Pure Web Audio (no Tone.js dependency, no asset files). Uses the
 * Phaser sound manager's underlying AudioContext so the WebAudio
 * gesture unlock works exactly the same way the backing track does.
 *
 * Per-vibe presets (chosen to sit musically inside the backing track):
 *   upbeat   square      bright chiptune blip (C5 / E5 / G5 triad)
 *   melodic  triangle    soft mallet feel    (A4 / C5 / E5 triad)
 *   smooth   sine        clean piano-ish     (F4 / A4 / C5 triad)
 *
 * Lane mapping is consistent across vibes:
 *   lane 0 = low note, lane 1 = mid note, lane 2 = high note.
 *
 * Each tap is one oscillator + one gain envelope, scheduled on
 * `AudioContext.currentTime` so timing is sample-accurate and
 * independent of frame rate.
 */
export interface TapPreset {
  waveform: OscillatorType;
  /** Frequency in Hz for lane 0 / lane 1 / lane 2. */
  freqs: readonly [number, number, number];
  /** Attack time in seconds — gain ramp from silence to peak. */
  attackSec: number;
  /** Release time in seconds — exponential decay from peak to silence. */
  releaseSec: number;
  /** Peak gain (0–1) at the end of attack, before release starts. */
  peakGain: number;
}

const PRESETS: Record<BackingVibe, TapPreset> = {
  upbeat: {
    waveform: 'square',
    freqs: [523.25, 659.25, 783.99], // C5, E5, G5
    attackSec: 0.002,
    releaseSec: 0.12,
    peakGain: 0.1,
  },
  melodic: {
    waveform: 'triangle',
    freqs: [440.0, 523.25, 659.25], // A4, C5, E5
    attackSec: 0.005,
    releaseSec: 0.35,
    peakGain: 0.15,
  },
  smooth: {
    waveform: 'sine',
    freqs: [349.23, 440.0, 523.25], // F4, A4, C5
    attackSec: 0.02,
    releaseSec: 0.5,
    peakGain: 0.22,
  },
};

const DEFAULT_VIBE: BackingVibe = 'upbeat';

/**
 * Miss hum-buzz — two detuned sawtooth oscillators sharing a low-pass
 * filter and gliding down in pitch. Three cues stack to read as "error"
 * rather than "musical note":
 *
 *   1. Detune (110 Hz + 117 Hz) → ~7 Hz beating, a fast warble that
 *      classically reads as dissonance. Single low sine sounded too
 *      much like an intentional bass note.
 *   2. Downward pitch glide (every freq * 0.85 by end) → the universal
 *      "sad trombone" cue. Falling pitch tells the listener something
 *      collapsed; rising pitch would feel like success.
 *   3. Low-pass at 800 Hz → softens the highest harmonics but lets
 *      220 / 330 / 440 / 550 / 660 Hz through, keeping the buzz
 *      character. 500 Hz (the prior cutoff) over-filtered and the
 *      result blended into the song. 800 Hz keeps it obviously
 *      synthetic / non-musical.
 */
const MISS_PRESET = {
  waveform: 'sawtooth' as OscillatorType,
  freqAHz: 110,
  freqBHz: 117,            // ~1.06× freqAHz, beats at ~7 Hz
  glideRatio: 0.85,        // both freqs glide down to 85% by release end
  filterHz: 800,
  filterQ: 0.7,
  releaseSec: 0.28,
  peakGain: 0.32,          // halved-ish because two oscillators sum
};

export class NoteSynth {
  private ctx: AudioContext | null = null;
  private destroyed = false;

  constructor(scene: Scene) {
    // Phaser's WebAudioSoundManager exposes `context: AudioContext`.
    // Duck-typed so we work cleanly across Phaser 3/4 typings without
    // pulling in the WebAudioSoundManager type.
    const mgr = scene.sound as unknown as { context?: AudioContext };
    if (mgr.context) this.ctx = mgr.context;
  }

  /**
   * Fire one tap note for the given lane in the given vibe. No-op if
   * the audio context hasn't been unlocked yet (no user gesture).
   * Cheap — one oscillator + one gain node, scheduled on the audio
   * clock and self-cleaning after release.
   */
  play(vibe: BackingVibe | undefined, lane: LaneId): void {
    if (this.destroyed || !this.ctx) return;
    if (this.ctx.state !== 'running') return;
    const preset = PRESETS[vibe ?? DEFAULT_VIBE];
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    osc.type = preset.waveform;
    osc.frequency.value = preset.freqs[lane];

    const gain = this.ctx.createGain();
    // Start near-silent (exponentialRampToValueAtTime can't reach 0).
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(preset.peakGain, now + preset.attackSec);
    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      now + preset.attackSec + preset.releaseSec,
    );

    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    // Stop slightly after release ends so the tail finishes cleanly.
    osc.stop(now + preset.attackSec + preset.releaseSec + 0.05);
  }

  /**
   * Sub-bass kick — content-independent thump that gives every hit
   * consistent impact regardless of what the backing is doing.
   * Classic 808-style design: sine wave with a downward pitch glide
   * (160 Hz → 50 Hz over 60 ms) provides the "thump" character; brief
   * exponential gain decay (120 ms) makes it tight rather than droney.
   *
   * Sub-bass frequency range means it adds low-end presence without
   * competing with the per-song tap sample's melodic content — the
   * two layers sum constructively. Fires alongside playTapForLane on
   * every successful hit; quiet song moments still feel punchy.
   */
  playKick(): void {
    if (this.destroyed || !this.ctx) return;
    if (this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160, now);
    osc.frequency.exponentialRampToValueAtTime(50, now + 0.06);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.45, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.15);
  }

  /**
   * Fire the miss hum-buzz. Two detuned sawtooth oscillators → shared
   * low-pass → gain → output. Both oscillators glide down in pitch
   * over the decay so the sound visibly "deflates". Instant peak gain.
   */
  playMiss(): void {
    if (this.destroyed || !this.ctx) return;
    if (this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const endTime = now + MISS_PRESET.releaseSec;

    const oscA = this.ctx.createOscillator();
    oscA.type = MISS_PRESET.waveform;
    oscA.frequency.setValueAtTime(MISS_PRESET.freqAHz, now);
    oscA.frequency.exponentialRampToValueAtTime(
      MISS_PRESET.freqAHz * MISS_PRESET.glideRatio,
      endTime,
    );

    const oscB = this.ctx.createOscillator();
    oscB.type = MISS_PRESET.waveform;
    oscB.frequency.setValueAtTime(MISS_PRESET.freqBHz, now);
    oscB.frequency.exponentialRampToValueAtTime(
      MISS_PRESET.freqBHz * MISS_PRESET.glideRatio,
      endTime,
    );

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = MISS_PRESET.filterHz;
    filter.Q.value = MISS_PRESET.filterQ;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(MISS_PRESET.peakGain, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, endTime);

    oscA.connect(filter);
    oscB.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);
    oscA.start(now);
    oscB.start(now);
    oscA.stop(endTime + 0.05);
    oscB.stop(endTime + 0.05);
  }

  destroy(): void {
    this.destroyed = true;
    // Per-tap oscillators auto-cleanup when `osc.stop()` time elapses.
    // We hold no persistent audio nodes, so nothing else to tear down.
    this.ctx = null;
  }
}
