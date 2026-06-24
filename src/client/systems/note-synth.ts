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
 * Miss buzz — short sawtooth in the buzzy mid-range so it reads as
 * "wrong" on any device. 120 Hz / 0.09 gain (the first attempt) was
 * inaudible on laptop speakers, which roll off hard below ~150 Hz;
 * 220 Hz puts the fundamental in the bass-guitar / kick-pluck range
 * that every speaker reproduces cleanly. Gain bumped to 0.30 so the
 * buzz registers without being abrasive. Sawtooth's harmonic stack
 * (220 / 440 / 660 / 880 …) means there's always something in any
 * speaker's bandwidth.
 */
const MISS_PRESET = {
  waveform: 'sawtooth' as OscillatorType,
  freqHz: 220,
  releaseSec: 0.2,
  peakGain: 0.3,
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
   * Fire the miss buzz. Single low sawtooth note, instant attack,
   * short exponential decay. Lane-independent — a miss is a miss.
   */
  playMiss(): void {
    if (this.destroyed || !this.ctx) return;
    if (this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    osc.type = MISS_PRESET.waveform;
    osc.frequency.value = MISS_PRESET.freqHz;

    const gain = this.ctx.createGain();
    // Instant peak (no attack ramp — same logic as the pulse, the buzz
    // should land on the moment of the missed tap, not 10ms after) then
    // exponential ride down.
    gain.gain.setValueAtTime(MISS_PRESET.peakGain, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + MISS_PRESET.releaseSec);

    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + MISS_PRESET.releaseSec + 0.05);
  }

  destroy(): void {
    this.destroyed = true;
    // Per-tap oscillators auto-cleanup when `osc.stop()` time elapses.
    // We hold no persistent audio nodes, so nothing else to tear down.
    this.ctx = null;
  }
}
