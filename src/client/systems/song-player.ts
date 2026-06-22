import * as Tone from 'tone';
import type { Chart, LaneId } from '@/../shared/state';

/**
 * SongPlayer — turns a chart into a meow-melody synced to an optional
 * looping backing track.
 *
 *   chart step (i, lane) → meow note at time t = i × msPerStep
 *   lane 0 → A3 (root)
 *   lane 1 → C4 (minor third)
 *   lane 2 → E4 (perfect fifth)
 *
 * A minor triad sits nicely against most lofi loops (which are typically
 * in A minor or C major). Keeping the three notes within a 7-semitone
 * range also means a sample registered at C4 only needs to pitch-shift
 * ±4 semitones — close enough to sound natural without chipmunk artifacts.
 * Stacking lanes in one step plays a chord.
 *
 * Mobile / iframe gotcha: WebAudio cannot start without a user gesture.
 * Call `unlock()` from the FIRST tap (Game's lane tap handler is the
 * natural place), then `start()` to begin playback.
 */

/** Lane → musical note. Index by LaneId (0/1/2). */
const LANE_TO_NOTE = ['A3', 'C4', 'E4'] as const;

export type MeowNote = (typeof LANE_TO_NOTE)[number];

/** Compute the musical note for a given lane. Exported for tests. */
export function noteForLane(lane: LaneId): MeowNote {
  return LANE_TO_NOTE[lane]!;
}

/**
 * Compute the schedule of (time-in-seconds, note) pairs for an entire
 * chart. One entry per active (step × lane). Time is measured from
 * Transport position 0. Exported for tests.
 */
export function buildSchedule(chart: Chart): Array<{ timeSec: number; note: MeowNote }> {
  const msPerStep = 60000 / (chart.bpm * 2);
  const out: Array<{ timeSec: number; note: MeowNote }> = [];
  for (let i = 0; i < chart.steps.length; i++) {
    const tSec = (i * msPerStep) / 1000;
    const step = chart.steps[i]!;
    for (const lane of step.lanes) {
      out.push({ timeSec: tSec, note: noteForLane(lane) });
    }
  }
  return out;
}

export interface SongPlayerOpts {
  chart: Chart;
  /**
   * Optional URL to a looping backing track. When null, only the meow
   * melody plays. The track should be in C major to harmonize with the
   * lane-to-note mapping. Loops cleanly via Tone.Player.
   */
  backingTrackUrl?: string;
  /**
   * Optional sample URLs keyed by musical note. When provided, a
   * Tone.Sampler plays the samples — gives a real meow voice. When
   * omitted, a procedural Tone.Synth fallback produces a meow-shaped
   * tone (rising glide + vibrato + short envelope) at the right pitch.
   */
  meowSamples?: Partial<Record<MeowNote, string>>;
  /** Master volume for the meow voice, in decibels. Defaults to -6. */
  meowVolumeDb?: number;
  /** Master volume for the backing track. Defaults to -10 dB. */
  backingVolumeDb?: number;
}

export class SongPlayer {
  private chart: Chart;
  private synth: Tone.PolySynth | null = null;
  private sampler: Tone.Sampler | null = null;
  private backing: Tone.Player | null = null;
  private scheduledIds: number[] = [];
  private started = false;
  private unlocked = false;
  private destroyed = false;

  constructor(private opts: SongPlayerOpts) {
    this.chart = opts.chart;
  }

  /** Tone.start() requires a user gesture (tap / click / key press). The
   *  Game scene calls this from the FIRST lane tap, before any meow is
   *  scheduled to fire. Safe to call repeatedly. */
  async unlock(): Promise<void> {
    if (this.unlocked || this.destroyed) return;
    await Tone.start();
    this.unlocked = true;
  }

  /** Spin up the meow voice (sampler or synth fallback) and the backing
   *  track, then schedule every (step × lane) tap as a meow at the right
   *  Transport time, then start Transport. Safe to call before unlock —
   *  the actual audio engine just won't tick until unlock resolves. */
  async start(): Promise<void> {
    if (this.started || this.destroyed) return;
    this.started = true;

    const meowVol = this.opts.meowVolumeDb ?? -6;
    const backingVol = this.opts.backingVolumeDb ?? -10;

    if (this.opts.meowSamples && Object.keys(this.opts.meowSamples).length > 0) {
      // Real cat audio path — Tim drops WAVs into public/assets/audio/meows/
      // and the sampler picks them up via Preloader. release=0.1 trims the
      // tail of the source clip so meows land as punctuation, not 1s drones.
      this.sampler = new Tone.Sampler({
        urls: this.opts.meowSamples,
        release: 0.1,
      }).toDestination();
      this.sampler.volume.value = meowVol;
    } else {
      // Procedural meow placeholder — a "mreee" shaped synth note that's
      // pitched to whichever lane the chart hits. Sounds like a chiptune
      // cat, not a real meow, but proves the loop end-to-end so Tim can
      // hear sync working tonight.
      this.synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'sawtooth' },
        envelope: {
          attack: 0.04,
          decay: 0.18,
          sustain: 0,
          release: 0.12,
        },
        portamento: 0.04, // tiny pitch glide gives a "mre-ow" feel
      }).toDestination();
      this.synth.volume.value = meowVol;
    }

    if (this.opts.backingTrackUrl) {
      this.backing = new Tone.Player({
        url: this.opts.backingTrackUrl,
        loop: true,
        autostart: false,
      }).toDestination();
      this.backing.volume.value = backingVol;
    }

    Tone.Transport.bpm.value = this.chart.bpm;

    // Wait for all newly-created buffers (the meow sample + the backing
    // MP3) to actually finish loading before we kick Transport. Without
    // this, a Tone.Player.start(0) on an unloaded buffer is a silent
    // no-op — the backing track never plays even though everything
    // looks wired up.
    await Tone.loaded();

    // Schedule every active meow in advance. Transport runs the callbacks
    // at sample-accurate times — far tighter than scene.time delays.
    const schedule = buildSchedule(this.chart);
    for (const { timeSec, note } of schedule) {
      const id = Tone.Transport.schedule((time) => {
        this.triggerMeow(note, time);
      }, timeSec);
      this.scheduledIds.push(id);
    }

    // Sync the backing track to Transport so play/pause stays locked.
    if (this.backing) {
      this.backing.sync().start(0);
    }
    Tone.Transport.start();
  }

  private triggerMeow(note: MeowNote, time: number): void {
    if (this.sampler) {
      // triggerAttackRelease + a short release (set on the Sampler) clips
      // the source meow to ~250ms instead of letting the full 1–2s
      // sample drone over the next beat.
      this.sampler.triggerAttackRelease(note, '8n', time);
    } else if (this.synth) {
      // Short note — meows are punctuation, not sustained pads.
      this.synth.triggerAttackRelease(note, '8n', time);
    }
  }

  /** Stop Transport, unwind every scheduled meow, leave the audio nodes
   *  alive for a potential future start() (round restart). Use destroy()
   *  for full teardown. */
  stop(): void {
    if (!this.started) return;
    Tone.Transport.stop();
    Tone.Transport.cancel();
    this.scheduledIds = [];
    this.backing?.stop();
    this.started = false;
  }

  /** Full teardown — kill scheduled events, dispose audio nodes. Safe to
   *  call from a scene SHUTDOWN handler. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    this.sampler?.dispose();
    this.synth?.dispose();
    this.backing?.dispose();
    this.sampler = null;
    this.synth = null;
    this.backing = null;
  }
}
