/**
 * Shared per-song tap-sample extraction. Used by:
 *
 *   - `scripts/extract-tap-samples.mjs` for bulk regeneration
 *   - `tools/server.mjs` for automatic extraction on calibrator upload
 *
 * For one source mp3 we write three pitched tap WAVs:
 *   <songId>-0.wav  source pitched -5 semitones (lane 0, low)
 *   <songId>-1.wav  source at original pitch    (lane 1, mid)
 *   <songId>-2.wav  source pitched +5 semitones (lane 2, high)
 *
 * The pitched variants share the same source moment so the three lanes
 * feel harmonically related instead of randomly drawn.
 */

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** When in the song the source moment is captured (seconds). 8s skips
 *  most intros without hitting the round-cap cliff. */
export const CAPTURE_START_SEC = 8;
/** Captured slice duration (seconds) before pitch shifting. */
export const CAPTURE_DUR_SEC = 0.35;
/** Semitone offsets applied per lane via ffmpeg asetrate+aresample. */
export const LANE_SEMITONES = [-5, 0, 5];

function semitonesToRate(semi) {
  return Math.pow(2, semi / 12);
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (b) => { stderr += b.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.trim().slice(-300)}`));
    });
  });
}

/**
 * Slice + pitch-shift + fade one lane's tap WAV from `mp3Path`.
 * Writes to `<tapsDir>/<songId>-<lane>.wav`. Throws on failure.
 */
async function extractLane(mp3Path, tapsDir, songId, lane) {
  const semi = LANE_SEMITONES[lane];
  const rate = semitonesToRate(semi);
  const outPath = join(tapsDir, `${songId}-${lane}.wav`);
  // asetrate raises pitch AND playback speed; resample back to 44.1 kHz
  // so the file header stays consistent (the pitched sound stays, only
  // the metadata normalises). Then fades guard the slice boundaries.
  const pitchedDur = CAPTURE_DUR_SEC / rate;
  const fadeOutStart = Math.max(0, pitchedDur - 0.08);
  const filter = [
    `asetrate=44100*${rate.toFixed(6)}`,
    'aresample=44100',
    'afade=t=in:st=0:d=0.015',
    `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.08`,
  ].join(',');
  await runFFmpeg([
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', String(CAPTURE_START_SEC),
    '-t', String(CAPTURE_DUR_SEC),
    '-i', mp3Path,
    '-af', filter,
    '-ac', '1',
    '-ar', '44100',
    outPath,
  ]);
}

/**
 * Extract all 3 tap samples for one song. Creates `tapsDir` if needed.
 *
 * @param {string} mp3Path   absolute path to the source backing mp3
 * @param {string} tapsDir   directory where `<songId>-<lane>.wav` files are written
 * @param {string} songId    catalog id used for output filenames
 */
export async function extractTapsForSong(mp3Path, tapsDir, songId) {
  await mkdir(tapsDir, { recursive: true });
  // mkdir on a nested path also ensures the parent exists, so re-running
  // for arbitrary songIds is safe even with relative paths.
  void dirname; // placeholder reference so the import survives tree-shake checks
  for (let lane = 0; lane < 3; lane++) {
    await extractLane(mp3Path, tapsDir, songId, lane);
  }
}
