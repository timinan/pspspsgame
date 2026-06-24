#!/usr/bin/env node
/**
 * Bulk regeneration of per-song tap samples. Walks every mp3 in
 * `public/assets/audio/backings/` and writes 3 pitched tap WAVs per
 * song into `public/assets/audio/taps/`. The shared
 * `scripts/lib/extract-taps-for-song.mjs` module does the per-song
 * heavy lifting and is also called from `tools/server.mjs` on every
 * calibrator upload — so this script is mostly for occasional
 * recompute (e.g. after dropping mp3s in manually outside the
 * calibrator, or tuning the CAPTURE_START_SEC constant).
 *
 * Run:  node scripts/extract-tap-samples.mjs
 */

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractTapsForSong } from './lib/extract-taps-for-song.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BACKINGS_DIR = join(ROOT, 'public', 'assets', 'audio', 'backings');
const TAPS_DIR = join(ROOT, 'public', 'assets', 'audio', 'taps');

async function main() {
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
    await extractTapsForSong(join(BACKINGS_DIR, file), TAPS_DIR, songId);
  }
  console.log(`done — ${files.length * 3} samples in ${TAPS_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
