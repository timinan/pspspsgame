#!/usr/bin/env node
/**
 * gen-thumbs.mjs
 *
 * Generate small picker-sized thumbnails for every theme background in
 * `public/assets/themes/`. Output: `public/assets/themes/thumbs/<id>-thumb.png`
 * at 200x360 (preserves the 1024x1856 source aspect ratio, ~16:29 = game
 * canvas aspect).
 *
 * Why: the lazy-load fix (3f84508) cut cold load from ~119MB to ~5MB by
 * deferring full bgs until equipped, but the Decorate picker shows a
 * grey placeholder until you tap each one. ~10KB thumbs eager-loaded by
 * the Preloader give the picker real previews without bringing back the
 * cold-load problem.
 *
 * Idempotent: skips ids that already have a thumb unless `--force`.
 *
 * Usage:
 *   node tools/gen-thumbs.mjs              # backfill missing
 *   node tools/gen-thumbs.mjs --force      # rebuild every thumb
 *   node tools/gen-thumbs.mjs <theme-id>   # one specific theme
 */
import { readdir, mkdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import sharp from 'sharp';

const THEMES_DIR = new URL('../public/assets/themes/', import.meta.url).pathname;
const THUMBS_DIR = join(THEMES_DIR, 'thumbs');
const THUMB_W = 200;
const THUMB_H = 360;

const args = process.argv.slice(2);
const force = args.includes('--force');
const positional = args.filter((a) => !a.startsWith('--'));
const onlyId = positional[0];

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function main() {
  await mkdir(THUMBS_DIR, { recursive: true });

  const entries = await readdir(THEMES_DIR);
  const bgFiles = entries.filter((f) => f.endsWith('-bg.png'));

  let written = 0;
  let skipped = 0;
  let errored = 0;

  for (const f of bgFiles) {
    const id = basename(f, '-bg.png');
    if (onlyId && id !== onlyId) continue;

    const src = join(THEMES_DIR, f);
    const dst = join(THUMBS_DIR, `${id}-thumb.png`);

    if (!force && await exists(dst)) {
      skipped += 1;
      continue;
    }

    try {
      // cover-fit: scale source so the thumb is fully covered, then
      // crop the centre. The source PNGs are all roughly the same
      // portrait aspect already, so this is essentially just a resize.
      // PNG palette mode + 8-bit alpha keeps the file under ~15KB.
      // Palette-quantized PNG with 128 colors + max compression. The
      // theme bgs are illustrated, not photo, so 128 colours preserves
      // the look while cutting the file size roughly in half vs a 256-
      // colour palette. Target ~10-20 KB per thumb.
      await sharp(src)
        .resize(THUMB_W, THUMB_H, { fit: 'cover', position: 'centre' })
        .png({ palette: true, colours: 128, quality: 80, compressionLevel: 9, effort: 10 })
        .toFile(dst);
      written += 1;
      if (written % 10 === 0) console.log(`  ... ${written} thumbs written`);
    } catch (err) {
      errored += 1;
      console.error(`  ✗ ${id}: ${err.message}`);
    }
  }

  console.log('');
  console.log(`✅ done — ${written} written, ${skipped} skipped, ${errored} errored`);
  console.log(`   output: ${THUMBS_DIR}`);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
