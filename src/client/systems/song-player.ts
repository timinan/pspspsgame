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

/**
 * Find the first non-silent sample in a loaded Tone.Player's buffer and
 * return its time offset in seconds (with a 10 ms soft lead-in so the
 * attack doesn't click). Used to skip the dead air baked into the
 * prototype's lofi mp3 so the music starts the moment the round does.
 * Returns 0 when the buffer is empty or audible from sample 0.
 */
function detectLeadingSilenceSec(player: Tone.Player): number {
  const buf = player.buffer?.get();
  if (!buf) return 0;
  const data = buf.getChannelData(0);
  // Scan at most 10 s — anything past that probably isn't leading silence.
  const scanLen = Math.min(data.length, buf.sampleRate * 10);
  let peak = 0;
  for (let i = 0; i < scanLen; i++) {
    const v = Math.abs(data[i]!);
    if (v > peak) peak = v;
  }
  if (peak < 0.01) return 0;
  const threshold = peak * 0.05;
  let firstLoud = 0;
  for (let i = 0; i < scanLen; i++) {
    if (Math.abs(data[i]!) >= threshold) {
      firstLoud = i;
      break;
    }
  }
  const lead = Math.floor(0.01 * buf.sampleRate);
  return Math.max(0, (firstLoud - lead) / buf.sampleRate);
}

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

/**
 * Same data as buildSchedule but grouped: one entry per unique time, with
 * an array of every note that fires at that moment. A double-tap step
 * (two lanes in `step.lanes`) becomes `{ timeSec, notes: [A3, C4] }` so
 * the Part callback can fire both meows from a single event instead of
 * relying on Tone.Part's behavior with duplicate-time events. Exported
 * for tests.
 */
export function buildGroupedSchedule(
  chart: Chart,
): Array<{ timeSec: number; notes: MeowNote[] }> {
  const byTime = new Map<number, MeowNote[]>();
  for (const { timeSec, note } of buildSchedule(chart)) {
    const arr = byTime.get(timeSec);
    if (arr) arr.push(note);
    else byTime.set(timeSec, [note]);
  }
  return [...byTime.entries()]
    .sort(([a], [b]) => a - b)
    .map(([timeSec, notes]) => ({ timeSec, notes }));
}

export interface SongPlayerOpts {
  chart: Chart;
  /**
   * When `true` (default), SongPlayer schedules every chart step as a
   * pitched meow on Tone.Transport — good for chart playback / preview
   * where there's no live input. When `false`, the chart is loaded for
   * its BPM only and the caller drives meows via `playMeow(lane)` — used
   * by the Game scene so meows fire on the player's tap moment instead
   * of the chart's beat moment, killing the perceived input → audio
   * delay.
   */
  autoSchedule?: boolean;
  /**
   * Optional URL to a looping backing track. When null, only the meow
   * melody plays. The track should be in A minor or C major to harmonize
   * with the lane-to-note mapping. Loops cleanly via Tone.Player.
   */
  backingTrackUrl?: string;
  /**
   * Optional sample URLs keyed by musical note. When provided, a
   * Tone.Sampler plays the samples — gives a real meow voice. When
   * omitted, a procedural Tone.Synth fallback produces a meow-shaped
   * tone (rising glide + vibrato + short envelope) at the right pitch.
   *
   * Keys are any pitch the Sampler should treat the sample as. The
   * Sampler interpolates from the declared keys up/down to whatever
   * pitches the playback engine asks for. Declaring a single key well
   * outside the lane range (e.g. A4 when lanes ask for A3/C4/E4) is the
   * trick to push the meow voice into a lower register without
   * recording new samples.
   */
  meowSamples?: Record<string, string>;
  /** Master volume for the meow voice, in decibels. Defaults to -6. */
  meowVolumeDb?: number;
  /** Master volume for the backing track. Defaults to -10 dB. */
  backingVolumeDb?: number;
}

export class SongPlayer {
  private chart: Chart;
  private synth: Tone.PolySynth | null = null;
  private sampler: Tone.Sampler | null = null;
  private meowFilter: Tone.Filter | null = null;
  private backing: Tone.Player | null = null;
  private part: Tone.Part | null = null;
  private started = false;
  private unlocked = false;
  private destroyed = false;

  constructor(private opts: SongPlayerOpts) {
    this.chart = opts.chart;
  }

  /** Tone.start() requires a user gesture (tap / click / key press). The
   *  Game scene calls this from the FIRST lane tap, before any meow is
   *  scheduled to fire. Safe to call repeatedly.
   *
   *  Also tightens lookAhead from Tone's 100ms default down to 30ms —
   *  every scheduled event normally fires lookAhead ms in the future for
   *  safety. 100ms is the dominant source of perceived input → meow
   *  delay and bg-music-start delay. 30ms is the sweet spot for tight
   *  rhythm games without underrun risk on a busy main thread. */
  async unlock(): Promise<void> {
    if (this.unlocked || this.destroyed) return;
    Tone.context.lookAhead = 0.03;
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

    const meowVol = this.opts.meowVolumeDb ?? -14;
    const backingVol = this.opts.backingVolumeDb ?? -12;

    if (this.opts.meowSamples && Object.keys(this.opts.meowSamples).length > 0) {
      // Real cat audio path — Tim drops WAVs into public/assets/audio/meows/
      // and the sampler picks them up via Preloader. release=0.15 softens
      // the tail; routing through a low-pass filter at 2.2 kHz rolls off
      // the harsh high end of the source clip so the meow reads as soft
      // chirps rather than sharp shrieks.
      this.meowFilter = new Tone.Filter({
        type: 'lowpass',
        frequency: 2200,
        Q: 0.7,
      }).toDestination();
      this.sampler = new Tone.Sampler({
        urls: this.opts.meowSamples,
        release: 0.15,
      }).connect(this.meowFilter);
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

    // Wrap the chart in a Tone.Part so it loops as long as Transport
    // runs. Transport.schedule fires each callback once — that left
    // SongPlayer silent after the first chart pass (~8s) while
    // ChartPlayer kept looping the visual notes 80 times for the full
    // round. Tone.Part with loopEnd = chart duration re-fires every step
    // on every loop. Skipped entirely when `autoSchedule: false` so the
    // caller drives meows via playMeow() on input instead.
    if (this.opts.autoSchedule !== false) {
      const grouped = buildGroupedSchedule(this.chart);
      const msPerStep = 60000 / (this.chart.bpm * 2);
      const chartDurSec = (msPerStep * this.chart.steps.length) / 1000;
      this.part = new Tone.Part(
        (time, value: { notes: MeowNote[] }) => {
          for (const note of value.notes) {
            this.triggerMeow(note, time);
          }
        },
        grouped.map(({ timeSec, notes }) => ({ time: timeSec, notes })),
      );
      this.part.loop = true;
      this.part.loopEnd = chartDurSec;
      this.part.start(0);
    }

    // Sync the backing track to Transport so play/pause stays locked.
    // Detect any leading silence in the buffer (the prototype lofi mp3
    // has ~1.2 s of dead air before the first hit) and offset start +
    // loopStart past it so the music kicks in immediately on round
    // start and every loop iteration.
    if (this.backing) {
      const startOffset = detectLeadingSilenceSec(this.backing);
      if (startOffset > 0.05) {
        this.backing.loopStart = startOffset;
      }
      this.backing.sync().start(0, startOffset);
    }
    Tone.Transport.start();
  }

  /**
   * Fire a meow on the given lane RIGHT NOW (Tone.now()). Game scene
   * calls this from its tap handler so meows track the player's input
   * instead of the chart's scheduled beat. Safe to call before
   * unlock/start — silently no-ops if the sampler isn't ready yet.
   */
  playMeow(laneId: LaneId): void {
    if (this.destroyed) return;
    this.triggerMeow(noteForLane(laneId), Tone.now());
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

  /** Stop Transport, unwind the chart Part, leave the audio nodes alive
   *  for a potential future start() (round restart). Use destroy() for
   *  full teardown. */
  stop(): void {
    if (!this.started) return;
    Tone.Transport.stop();
    Tone.Transport.cancel();
    this.part?.stop();
    this.part?.dispose();
    this.part = null;
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
    this.meowFilter?.dispose();
    this.synth?.dispose();
    this.backing?.dispose();
    this.sampler = null;
    this.meowFilter = null;
    this.synth = null;
    this.backing = null;
  }
}
