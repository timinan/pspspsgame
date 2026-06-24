#!/usr/bin/env node
/**
 * Auto-extract per-song tap samples for the rhythm taps.
 *
 * For every mp3 in `public/assets/audio/backings/` this slices one short
 * window from the song and writes 3 pitched variants — one for each lane
 * (lane 0 = -5 semitones, lane 1 = original, lane 2 = +5 semitones). The
 * pitched variants share the source moment so they feel like the same
 * instrument, just at low / mid / high positions; using a single capture
 * point keeps the three lanes harmonically related instead of randomly
 * drawn from unrelated bars.
 *
 * The samples are sliced + faded + pitch-shifted via ffmpeg's asetrate
 * trick (asetrate raises both pitch and speed; we then resample back to
 * 44.1 kHz to keep the file format consistent).
 *
 * Output: `public/assets/audio/taps/<song-id>-<lane>.wav`
 * Run:    node scripts/extract-tap-samples.mjs
 */

import { spawn } from 'node:child_process';
import { readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BACKINGS_DIR = join(ROOT, 'public', 'assets', 'audio', 'backings');
const TAPS_DIR = join(ROOT, 'public', 'assets', 'audio', 'taps');

// Where in the song we capture the source moment. 8s skips most intros
// without running into the round-cap cliff. Increase if a particular
// song has a quiet head; decrease if you want grittier intro material.
const CAPTURE_START_SEC = 8;
const CAPTURE_DUR_SEC = 0.35;

// Per-lane pitch shifts (semitones from the captured moment).
// -5 / 0 / +5 spans a tritone+ — wide enough to feel like three notes,
// narrow enough that the pitched extremes don't sound mangled.
const LANE_SEMITONES = [-5, 0, 5];

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

async function extractForSong(mp3Path, songId) {
  for (let lane = 0; lane < 3; lane++) {
    const semi = LANE_SEMITONES[lane];
    const rate = semitonesToRate(semi);
    const outPath = join(TAPS_DIR, `${songId}-${lane}.wav`);

    // After pitch-shift via asetrate, the playback duration shrinks /
    // expands by 1/rate. We fade out the last 80ms of the pitched clip.
    const pitchedDur = CAPTURE_DUR_SEC / rate;
    const fadeOutStart = Math.max(0, pitchedDur - 0.08);

    // Filter chain:
    //   asetrate=44100*rate       pitch + speed up/down together
    //   aresample=44100           bring rate back to 44.1 kHz (keeps the
    //                             pitched sound but normalises the file
    //                             header so downstream tools agree on
    //                             timing)
    //   afade=t=in:st=0:d=0.015   tiny attack so the tap doesn't click
    //   afade=t=out:st=X:d=0.08   gentle release so the tail doesn't snap
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
    process.stdout.write(`  lane ${lane} (${semi > 0 ? '+' : ''}${semi} st)\n`);
  }
}

async function main() {
  mkdirSync(TAPS_DIR, { recursive: true });
  const files = readdirSync(BACKINGS_DIR)
    .filter((f) => f.endsWith('.mp3'))
    .sort();
  if (files.length === 0) {
    console.error('no mp3 backings found in', BACKINGS_DIR);
    process.exit(1);
  }
  console.log(`extracting tap samples from ${files.length} backing(s)`);
  for (const file of files) {
    const songId = file.replace(/\.mp3$/, '');
    console.log(songId);
    await extractForSong(join(BACKINGS_DIR, file), songId);
  }
  console.log(`done — ${files.length * 3} samples in ${TAPS_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
