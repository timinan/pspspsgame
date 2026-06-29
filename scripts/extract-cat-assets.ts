/*
 * Extracts source GIF animations into Phaser-friendly atlases:
 *   - public/assets/atlas/cats.png + cats.json        (cat sprites only)
 *   - public/assets/atlas/cosmetics.png + cosmetics.json  (cosmetic sprites only)
 *   - public/assets/sounds/*.mp3                       (background + sfx)
 *   - public/assets/images/*.png                       (HUD bits)
 *
 * Sources:
 *   Cats:      <prototype>/src/assets/cat<N>/*.gif
 *   Cosmetics: assets-raw/cosmetic/<id>/*.gif         (auto-discovered)
 *
 * Animations are normalised to the canonical names listed in
 * CANONICAL_ANIM. Anything matching a known typo (idlet/idlegif/lickt/
 * lickgif) is mapped back to its canonical form. Unknown suffixes are
 * skipped with a warning.
 *
 * Cosmetic folders are auto-discovered — drop assets-raw/cosmetic/c44/
 * with whatever GIFs you have and rerun: no code change needed.
 *
 * Run with: npm run extract:assets
 */

import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import gifFrames from 'gif-frames';
import { glob } from 'glob';

const PROTOTYPE_ASSETS = '/Users/timnan/Documents/GitHub/pspsadopt/src/assets';
const PROTOTYPE_SOUNDS = '/Users/timnan/Documents/GitHub/pspsadopt/src/sounds';
const PROTOTYPE_FONTS = '/Users/timnan/Documents/GitHub/pspsadopt/src/fonts';
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const OUT_RAW = path.join(PROJECT_ROOT, 'assets-raw');
const OUT_PUBLIC = path.join(PROJECT_ROOT, 'public', 'assets');
const OUT_ATLAS_DIR = path.join(OUT_PUBLIC, 'atlas');
const OUT_SOUNDS = path.join(OUT_PUBLIC, 'sounds');
const OUT_IMAGES = path.join(OUT_PUBLIC, 'images');
const OUT_FONTS = path.join(OUT_PUBLIC, 'fonts');

const BREEDS = ['cat1', 'cat2', 'cat3', 'cat4', 'cat5', 'cat6'] as const;

// Where the user drops new cosmetic GIFs. Each subfolder named `c<N>` is
// treated as a cosmetic; its GIFs are mapped to animations by suffix.
const COSMETIC_RAW_DIR = path.join(PROJECT_ROOT, 'assets-raw', 'cosmetic');

// Canonical animation set — front-facing only. sleep / sleep_alt /
// stretch shipped in the source pack but show the cat curled on its
// side, which makes cosmetics look detached (the accessory was painted
// for the upright pose). Skip them at extract time.
const CANONICAL_ANIM = [
  'idle',
  'lick',
  'meow',
  'hiss',
  'happy',
] as const;
type CanonicalAnim = (typeof CANONICAL_ANIM)[number];

// Cat animation suffix -> canonical name. sleep_left/sleep_right/
// stretch_* intentionally absent — anything not listed drops at extract.
const CAT_ANIM_MAP: Record<string, CanonicalAnim> = {
  idle: 'idle',
  lick: 'lick',
  meow: 'meow',
  hiss: 'hiss',
  happy: 'happy',
};

// Cosmetic animation suffix -> canonical name. Handles the typos that
// shipped in the source pack: idlet/idlegif → idle, lickt/lickgif → lick.
// sleep, sleep_r, stretch are dropped to match the cat side; cosmetic
// overlays only need to track the front-facing poses.
const COSMETIC_ANIM_MAP: Record<string, CanonicalAnim> = {
  idle: 'idle',
  idlet: 'idle',
  idlegif: 'idle',
  lick: 'lick',
  lickt: 'lick',
  lickgif: 'lick',
  hiss: 'hiss',
  happy: 'happy',
};

interface ExtractedFrame {
  breed: string;
  animation: string;
  frameIndex: number;
  srcPath: string;
}

async function ensureDirs(): Promise<void> {
  for (const d of [OUT_RAW, OUT_PUBLIC, OUT_ATLAS_DIR, OUT_SOUNDS, OUT_IMAGES, OUT_FONTS]) {
    await fs.mkdir(d, { recursive: true });
  }
}

async function extractGif(
  gifPath: string,
  outDir: string,
  filenamePrefix: string,
): Promise<string[]> {
  const frames = await gifFrames({ url: gifPath, frames: 'all', outputType: 'png' });
  const written: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    const outPath = path.join(outDir, `${filenamePrefix}_${String(i).padStart(2, '0')}.png`);
    await new Promise<void>((resolve, reject) => {
      const stream = frames[i].getImage();
      const ws = createWriteStream(outPath);
      stream.pipe(ws);
      ws.on('finish', () => resolve());
      ws.on('error', reject);
    });
    written.push(outPath);
  }
  return written;
}

async function extractCatGifs(): Promise<ExtractedFrame[]> {
  const all: ExtractedFrame[] = [];
  for (const breed of BREEDS) {
    const breedSrcDir = path.join(PROTOTYPE_ASSETS, breed);
    const breedOutDir = path.join(OUT_RAW, breed);
    await fs.mkdir(breedOutDir, { recursive: true });

    const gifs = await glob(`${breedSrcDir}/*.gif`);
    for (const gifPath of gifs) {
      const base = path.basename(gifPath, '.gif');
      const suffix = base.replace(`${breed}_`, '');
      const animation = CAT_ANIM_MAP[suffix];
      if (!animation) {
        console.warn(`[skip unknown cat anim] ${gifPath}`);
        continue;
      }

      // De-dup: two prototype gifs (sleep_left + sleep_right) collapse to 'sleep'.
      // Keep the first one we see for each (breed, animation) pair.
      const alreadyHave = all.some(
        (f) => f.breed === breed && f.animation === animation,
      );
      if (alreadyHave) continue;

      const written = await extractGif(gifPath, breedOutDir, `${breed}_${animation}`);
      for (let i = 0; i < written.length; i++) {
        all.push({ breed, animation, frameIndex: i, srcPath: written[i]! });
      }
    }
  }

  // Auto-discover additional cat<N>/ folders in assets-raw/ — these are
  // typically Color Repick variants (cat7, cat8, ...) where the server
  // has dropped recolored frame PNGs directly using the same naming
  // convention the prototype-GIF flow produces (`cat<N>_<anim>_<NN>.png`).
  // No GIF processing here — the PNGs ARE the source.
  const rawEntries = await fs.readdir(OUT_RAW).catch(() => [] as string[]);
  const extraBreeds = rawEntries
    .filter((e) => /^cat\d+$/.test(e) && !(BREEDS as readonly string[]).includes(e))
    .sort((a, b) => parseInt(a.slice(3), 10) - parseInt(b.slice(3), 10));

  for (const breed of extraBreeds) {
    const dir = path.join(OUT_RAW, breed);
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const pngs = await glob(`${dir}/*.png`);
    const frameRe = new RegExp(`^${breed}_(.+)_(\\d+)$`);
    type Bucket = { animation: CanonicalAnim; idx: number; srcPath: string };
    const buckets: Bucket[] = [];
    for (const pngPath of pngs) {
      const base = path.basename(pngPath, '.png');
      const m = frameRe.exec(base);
      if (!m) continue;
      const suffix = m[1]!;
      const idx = parseInt(m[2]!, 10);
      const animation = CAT_ANIM_MAP[suffix];
      if (!animation) continue;
      buckets.push({ animation, idx, srcPath: pngPath });
    }
    buckets.sort((a, b) =>
      a.animation === b.animation ? a.idx - b.idx : a.animation.localeCompare(b.animation),
    );
    for (const b of buckets) {
      all.push({ breed, animation: b.animation, frameIndex: b.idx, srcPath: b.srcPath });
    }
  }

  return all;
}

/**
 * Walks assets-raw/cosmetic/ and extracts every GIF in every cN/ folder.
 * Auto-discovery: any directory matching /^c\d+$/ is treated as a
 * cosmetic. Animation names are normalised via COSMETIC_ANIM_MAP so the
 * typo'd source filenames (idlet/idlegif, lickt/lickgif) all collapse
 * back to canonical animation names (idle, lick, …).
 *
 * Adding a new cosmetic: drop assets-raw/cosmetic/c44/ with its GIFs and
 * re-run. No code change.
 */
async function extractCosmeticGifs(): Promise<ExtractedFrame[]> {
  const all: ExtractedFrame[] = [];
  const entries = await fs.readdir(COSMETIC_RAW_DIR).catch(() => [] as string[]);
  const folders = entries.filter((e) => /^c\d+$/.test(e)).sort(byCNumber);

  for (const cos of folders) {
    const srcDir = path.join(COSMETIC_RAW_DIR, cos);
    const stat = await fs.stat(srcDir).catch(() => null);
    if (!stat?.isDirectory()) continue;

    const outDir = srcDir; // Co-locate intermediate PNGs with their source GIFs
    // PNGs sit alongside GIFs in the same folder. A static cosmetic
    // uploaded via the calibrator lands as `c<N>_idle.png` (one frame);
    // the existing hand-animated cosmetics use `c<N>_<anim>.gif` (many
    // frames). GIFs get priority so a folder with both keeps the
    // hand-animated version for that animation.
    const gifs = await glob(`${srcDir}/*.gif`);
    const pngs = await glob(`${srcDir}/*.png`);
    // Sort 'idle' first so it wins de-dup ties if multiple suffixes map
    // to the same canonical animation.
    const sortIdleFirst = (a: string, b: string) => {
      const ai = path.basename(a).includes('idle') ? 0 : 1;
      const bi = path.basename(b).includes('idle') ? 0 : 1;
      return ai - bi;
    };
    gifs.sort(sortIdleFirst);
    pngs.sort(sortIdleFirst);

    // Track which animations we already extracted (intermediate frame
    // PNGs from a prior gif-frames pass are named `cosmetic_<cos>_<anim>_NN.png`
    // and live in the same folder — those are NOT source PNGs and must
    // not be re-treated as standalone sources.
    const isExtractedIntermediate = (p: string) =>
      path.basename(p).startsWith(`cosmetic_${cos}_`);

    for (const gifPath of gifs) {
      const base = path.basename(gifPath, '.gif');
      // Tolerate prefix typos (cc18_sleep.gif) by deriving the animation
      // from the suffix tokens instead of the literal cN_ prefix. Try the
      // last-2 tokens first (sleep_r), then the last 1 token (sleep).
      const tokens = base.split('_');
      let suffix = tokens.slice(-2).join('_');
      let animation = COSMETIC_ANIM_MAP[suffix];
      if (!animation && tokens.length >= 1) {
        suffix = tokens[tokens.length - 1]!;
        animation = COSMETIC_ANIM_MAP[suffix];
      }
      if (!animation) {
        console.warn(`[skip unknown cosmetic anim] ${gifPath}`);
        continue;
      }

      const alreadyHave = all.some(
        (f) => f.breed === `cosmetic_${cos}` && f.animation === animation,
      );
      if (alreadyHave) continue;

      const written = await extractGif(gifPath, outDir, `cosmetic_${cos}_${animation}`);
      for (let i = 0; i < written.length; i++) {
        all.push({
          breed: `cosmetic_${cos}`,
          animation,
          frameIndex: i,
          srcPath: written[i]!,
        });
      }
    }

    // Source PNGs come in two shapes:
    //   - Single-frame static: `c<N>_<anim>.png` (Quick Add uploads land here)
    //   - Multi-frame variant: `c<N>_<anim>_<NN>.png` (Color Repick variants
    //     of an animated source — server-side recolored intermediates)
    // We bucket all source PNGs by animation first so multi-frame sets pack
    // into a single ExtractedFrame list per animation. A GIF on the same
    // animation always wins (extracted in the loop above).
    type ParsedFrame = { pngPath: string; animation: CanonicalAnim; frameIdx: number };
    const buckets = new Map<CanonicalAnim, ParsedFrame[]>();
    for (const pngPath of pngs) {
      if (isExtractedIntermediate(pngPath)) continue;
      const parsed = parseCosmeticPngSource(pngPath);
      if (!parsed) {
        console.warn(`[skip unknown cosmetic anim png] ${pngPath}`);
        continue;
      }
      let arr = buckets.get(parsed.animation);
      if (!arr) {
        arr = [];
        buckets.set(parsed.animation, arr);
      }
      arr.push({ pngPath, ...parsed });
    }

    for (const [animation, frames] of buckets) {
      // GIF already covered this animation — skip the PNG bucket.
      const gifCovered = all.some(
        (f) => f.breed === `cosmetic_${cos}` && f.animation === animation,
      );
      if (gifCovered) continue;

      frames.sort((a, b) => a.frameIdx - b.frameIdx);
      for (const { pngPath, frameIdx } of frames) {
        const outPath = path.join(
          outDir,
          `cosmetic_${cos}_${animation}_${String(frameIdx).padStart(2, '0')}.png`,
        );
        if (path.resolve(pngPath) !== path.resolve(outPath)) {
          await fs.copyFile(pngPath, outPath);
        }
        all.push({
          breed: `cosmetic_${cos}`,
          animation,
          frameIndex: frameIdx,
          srcPath: outPath,
        });
      }
    }
  }
  return all;
}

/** Parse a cosmetic source PNG filename into animation + frame index.
 *  Supports both `c44_idle.png` (single frame, idx 0) and
 *  `c44_idle_00.png` (numbered multi-frame). Returns null when the
 *  animation suffix isn't recognized. */
function parseCosmeticPngSource(
  pngPath: string,
): { animation: CanonicalAnim; frameIdx: number } | null {
  const base = path.basename(pngPath, '.png');
  const tokens = base.split('_');
  if (tokens.length < 2) return null;

  // Multi-frame: last token numeric, e.g. ['c44', 'idle', '00'].
  const last = tokens[tokens.length - 1]!;
  if (/^\d+$/.test(last) && tokens.length >= 3) {
    const frameIdx = parseInt(last, 10);
    // The 2-token animation suffix (e.g. 'sleep_r') sits before the index.
    let suffix = tokens.slice(-3, -1).join('_');
    let animation = COSMETIC_ANIM_MAP[suffix];
    if (!animation) {
      suffix = tokens[tokens.length - 2]!;
      animation = COSMETIC_ANIM_MAP[suffix];
    }
    if (animation) return { animation, frameIdx };
  }

  // Single-frame: ['c44', 'idle'] or with a 2-token suffix ['c44', 'sleep', 'r'].
  let suffix = tokens.slice(-2).join('_');
  let animation = COSMETIC_ANIM_MAP[suffix];
  if (!animation) {
    suffix = tokens[tokens.length - 1]!;
    animation = COSMETIC_ANIM_MAP[suffix];
  }
  if (animation) return { animation, frameIdx: 0 };

  return null;
}

function byCNumber(a: string, b: string): number {
  return parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10);
}

interface AtlasFrame {
  filename: string;
  frame: { x: number; y: number; w: number; h: number };
  rotated: false;
  trimmed: boolean;
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
}

async function packAtlas(frames: ExtractedFrame[], atlasName: string): Promise<void> {
  if (frames.length === 0) {
    console.warn(`[atlas:${atlasName}] no frames — skipping`);
    return;
  }

  // Read pixel data and compute the painted bounds of every frame so we
  // can pack the trimmed crop instead of 91×64 canvases full of empty
  // pixels (cosmetic frames are ~4-5% opaque, cat frames ~27%). Trimming
  // shrinks the cosmetic atlas from ~13000 to under 1000px tall.
  const sized = await Promise.all(
    frames.map(async (f) => {
      const { data, info } = await sharp(f.srcPath)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const w = info.width;
      const h = info.height;
      let minX = w;
      let minY = h;
      let maxX = -1;
      let maxY = -1;
      const rowPixelCount = new Array<number>(h).fill(0);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (data[(y * w + x) * 4 + 3]! > 0) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            rowPixelCount[y]!++;
          }
        }
      }
      // Fully-transparent frame: skip (no visible pixels = nothing to pack)
      if (maxX < minX || maxY < minY) return null;
      // "Thick top" — first row with enough painted pixels to be real
      // structure, not a stray brush mark or sparkle artifact. Used by
      // the offset pass below to anchor the head crown stably; the regular
      // minY (which the atlas frame stores) can be hijacked by a single
      // stray pixel and cause a 10+ px head jump in just one frame.
      // 3 pixels = empirical threshold (smallest legitimate ear/whisker
      // detail is ~3-5 wide). Falls back to minY if no thick row found.
      let thickTopY = minY;
      for (let y = minY; y <= maxY; y++) {
        if (rowPixelCount[y]! >= 3) {
          thickTopY = y;
          break;
        }
      }
      return {
        ...f,
        origW: w,
        origH: h,
        trimX: minX,
        trimY: minY,
        trimW: maxX - minX + 1,
        trimH: maxY - minY + 1,
        thickTopY,
      };
    }),
  );
  const trimmed = sized.filter((f): f is NonNullable<typeof f> => f !== null);

  // Shelf packing with per-shelf height (next-fit-decreasing-height). Sort
  // frames by trimmed height desc so each new shelf gets the height of
  // its first, tallest frame — drastically tighter than a single global
  // shelf height.
  trimmed.sort((a, b) => b.trimH - a.trimH);

  // Padding (gutter) between frames in the atlas. Without it, GPU
  // texel-sampling at frame edges can read into the neighbouring frame
  // and produce visible bleed — black lines and stray colored pixels
  // floating beside sprites. 2px is the conventional minimum.
  const ATLAS_WIDTH = 2048;
  const PAD = 2;
  let x = PAD;
  let y = PAD;
  let shelfHeight = trimmed[0]?.trimH ?? 0;

  const placements: AtlasFrame[] = [];
  const composites: sharp.OverlayOptions[] = [];

  for (const f of trimmed) {
    if (x + f.trimW + PAD > ATLAS_WIDTH) {
      x = PAD;
      y += shelfHeight + PAD;
      shelfHeight = f.trimH;
    }
    const filename = `${f.breed}_${f.animation}_${String(f.frameIndex).padStart(2, '0')}`;
    placements.push({
      filename,
      frame: { x, y, w: f.trimW, h: f.trimH },
      rotated: false,
      trimmed: true,
      spriteSourceSize: { x: f.trimX, y: f.trimY, w: f.trimW, h: f.trimH },
      sourceSize: { w: f.origW, h: f.origH },
      // Custom field — only consumed by the per-frame offset pass below.
      // Phaser ignores unknown fields when loading the atlas, so this is
      // safe. See the rowPixelCount comment for why we carry this.
      _thickTopY: f.thickTopY,
    });
    // Crop the source image to its painted bounds for the composite.
    const cropped = await sharp(f.srcPath)
      .extract({ left: f.trimX, top: f.trimY, width: f.trimW, height: f.trimH })
      .toBuffer();
    composites.push({ input: cropped, left: x, top: y });
    x += f.trimW + PAD;
  }

  const ATLAS_HEIGHT = y + shelfHeight + PAD;

  const atlasPngBuffer = await sharp({
    create: {
      width: ATLAS_WIDTH,
      height: ATLAS_HEIGHT,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();

  const atlasPngPath = path.join(OUT_ATLAS_DIR, `${atlasName}.png`);
  const atlasJsonPath = path.join(OUT_ATLAS_DIR, `${atlasName}.json`);
  await fs.writeFile(atlasPngPath, atlasPngBuffer);

  const atlasJson = {
    frames: placements,
    meta: {
      app: 'meowcert-extractor',
      version: '1',
      image: `${atlasName}.png`,
      format: 'RGBA8888',
      size: { w: ATLAS_WIDTH, h: ATLAS_HEIGHT },
      scale: '1',
    },
  };
  await fs.writeFile(atlasJsonPath, JSON.stringify(atlasJson, null, 2));

  console.log(
    `[atlas:${atlasName}] ${ATLAS_WIDTH}x${ATLAS_HEIGHT}, ${placements.length} frames -> ${path.relative(PROJECT_ROOT, atlasPngPath)}`,
  );
}

async function copyFile(srcAbs: string, dstAbs: string): Promise<void> {
  await fs.copyFile(srcAbs, dstAbs);
  console.log(`[copy] ${path.basename(dstAbs)}`);
}

/**
 * Splits PSElement.png (a fuzzy ball with white "PS" letters baked on top)
 * into two derived sprites so we can recolor the ball without touching the
 * letters:
 *   - PSElement_ball.png    : ball-only (the white letter pixels are erased)
 *   - PSElement_letters.png : letters-only (everything that wasn't whitish is erased)
 */
async function splitPsElementIntoBallAndLetters(): Promise<void> {
  const srcPath = path.join(PROTOTYPE_ASSETS, 'PSElement.png');
  const { data, info } = await sharp(srcPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const ballData = Buffer.from(data);
  const lettersData = Buffer.alloc(data.length);

  // Pixels that read clearly "white" — the PS letters. Threshold tuned to
  // catch the letter centers without grabbing the lighter highlights on the
  // ball edges.
  const WHITISH = 220;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const a = data[i + 3]!;
    const isLetter = a > 0 && r >= WHITISH && g >= WHITISH && b >= WHITISH;

    if (isLetter) {
      lettersData[i] = 255;
      lettersData[i + 1] = 255;
      lettersData[i + 2] = 255;
      lettersData[i + 3] = a;
      ballData[i + 3] = 0; // erase from ball
    } else {
      lettersData[i + 3] = 0; // erase from letters
      // ball: leave unchanged
    }
  }

  const sharpOpts = {
    raw: { width: info.width, height: info.height, channels: 4 as const },
  };
  await sharp(ballData, sharpOpts)
    .png()
    .toFile(path.join(OUT_IMAGES, 'PSElement_ball.png'));
  await sharp(lettersData, sharpOpts)
    .png()
    .toFile(path.join(OUT_IMAGES, 'PSElement_letters.png'));

  console.log(`[ps-split] generated PSElement_ball.png + PSElement_letters.png`);
}

async function copyStaticAssets(): Promise<void> {
  // Sounds
  await copyFile(
    path.join(PROTOTYPE_SOUNDS, 'background.mp3'),
    path.join(OUT_SOUNDS, 'background.mp3'),
  );
  await copyFile(
    path.join(PROTOTYPE_SOUNDS, 'meowcert.mp3'),
    path.join(OUT_SOUNDS, 'meowcert.mp3'),
  );

  // Images
  const images = [
    'gameBackground.png',
    'meowBarFill.png',
    'meowBarOutline.png',
    'rythmBarBackground.png',
    'PSElement.png',
    'PSTarget.png',
  ];
  for (const img of images) {
    await copyFile(path.join(PROTOTYPE_ASSETS, img), path.join(OUT_IMAGES, img));
  }

  // Fonts
  const fonts = ['PixeloidSans.otf', 'PixeloidSans-Bold.otf'];
  for (const font of fonts) {
    await copyFile(path.join(PROTOTYPE_FONTS, font), path.join(OUT_FONTS, font));
  }
}

/**
 * The prototype's meowBarFill.png is 148x30 but the cat-tail content only
 * occupies the middle 10 rows (y=10..19). The empty rows above and below
 * make the bar's white track show through when displayed. Trim the image
 * to its actual opaque row range so the tail fills the bar vertically.
 */
async function trimMeowBarFill(): Promise<void> {
  const filePath = path.join(OUT_IMAGES, 'meowBarFill.png');
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3]! > 0) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        break;
      }
    }
  }
  if (maxY < minY) return;
  const cropHeight = maxY - minY + 1;
  if (cropHeight === height) return;

  const tmp = `${filePath}.tmp`;
  await sharp(filePath)
    .extract({ left: 0, top: minY, width, height: cropHeight })
    .toFile(tmp);
  await fs.rename(tmp, filePath);
  console.log(
    `[trim] meowBarFill: kept rows ${minY}-${maxY} (${cropHeight} of ${height})`,
  );
}

/**
 * After the cat atlas is packed, emit per-frame translation offsets for
 * every cat animation. Static cosmetics (single-frame PNG uploads) ride
 * these offsets at runtime to bob/jump/etc. along with their cat — see
 * `Cat.syncOneCosmetic`.
 *
 * For each cat × animation × frameIndex, the offset is the delta between
 * that frame's painted-bound CENTER and the painted-bound center of
 * frame 0 of idle for the same cat. Captures pure translations (bobs,
 * jumps); for deformation animations (stretch, hiss) it approximates the
 * body-center motion, which is close enough for slot-multiplier tuning
 * to clean up. Output:
 *
 *   {
 *     "cat1": {
 *       "idle":  [[0,0], [0,-1], [0,-2], [0,-1], [0,0], ...],
 *       "happy": [[0,-2], [0,-5], [0,-3], [0,0], ...],
 *       ...
 *     },
 *     ...
 *   }
 */
async function writeCatFrameOffsets(): Promise<void> {
  const atlasJsonPath = path.join(OUT_ATLAS_DIR, 'cats.json');
  const raw = await fs.readFile(atlasJsonPath, 'utf8').catch(() => null);
  if (!raw) {
    console.warn('[offsets] cats.json missing — skipping frame offsets');
    return;
  }
  const atlas = JSON.parse(raw) as { frames: AtlasFrame[] };

  // Group frames by breed + animation, sort by frame index.
  type Bucket = { name: string; cx: number; cy: number; idx: number };
  const byCatAnim = new Map<string, Map<string, Bucket[]>>();
  const frameNameRegex = /^(cat\d+)_([a-z_]+)_(\d+)$/;

  for (const f of atlas.frames) {
    const m = frameNameRegex.exec(f.filename);
    if (!m) continue;
    const [, breed, anim, idxStr] = m;
    const idx = parseInt(idxStr!, 10);
    // Anchor X to a constant (sourceSize/2 = canvas centerline) and Y to
    // the TOP of the painted bounds (= head's top edge).
    //
    // Why X is fixed: spriteSourceSize.x is constant across all frames of
    // a cat (the body's left edge doesn't move horizontally) — what changes
    // is `w` as the body extends right (tail flicks, paw lifts). Using
    // center-X of painted bounds picked up that body extension as false
    // head motion, dragging static cosmetics side-to-side. A fixed anchor
    // = zero horizontal motion in the offsets = static cosmetics lock
    // perfectly to the head.
    //
    // Why Y is top: the original center-Y conflated body deformation
    // (paw lifts, body stretches DOWN during lick/meow) with head motion.
    // Top-Y tracks the topmost painted row directly = where the head's
    // crown is = the true vertical landmark for hats / faces.
    //
    // Why thickTopY and not spriteSourceSize.y: a single stray pixel
    // from a brush mark or sparkle artifact above the head will hijack
    // spriteSourceSize.y (which is min-Y across all painted pixels) and
    // report the head at Y=0, causing a 10+ px cosmetic jump on that
    // frame. _thickTopY skips rows with <3 pixels so isolated artifacts
    // don't move the head landmark. Falls back to spriteSourceSize.y
    // for older atlas builds that didn't emit the field.
    const cx = f.sourceSize.w / 2;
    const cy = (f as AtlasFrame & { _thickTopY?: number })._thickTopY ?? f.spriteSourceSize.y;
    let perAnim = byCatAnim.get(breed!);
    if (!perAnim) {
      perAnim = new Map();
      byCatAnim.set(breed!, perAnim);
    }
    let arr = perAnim.get(anim!);
    if (!arr) {
      arr = [];
      perAnim.set(anim!, arr);
    }
    arr.push({ name: f.filename, cx, cy, idx });
  }

  const offsets: Record<string, Record<string, [number, number][]>> = {};
  for (const [breed, perAnim] of byCatAnim) {
    // Reference center = frame 0 of idle for this cat. Fall back to the
    // first frame of any animation if idle is missing.
    const idleFrames = (perAnim.get('idle') ?? []).slice().sort((a, b) => a.idx - b.idx);
    let refCx = 0;
    let refCy = 0;
    if (idleFrames.length > 0) {
      refCx = idleFrames[0]!.cx;
      refCy = idleFrames[0]!.cy;
    } else {
      // Fallback — first animation, first frame.
      const first = [...perAnim.values()][0]?.[0];
      if (first) {
        refCx = first.cx;
        refCy = first.cy;
      }
    }

    offsets[breed] = {};
    for (const [anim, arr] of perAnim) {
      const sorted = arr.slice().sort((a, b) => a.idx - b.idx);
      offsets[breed]![anim] = sorted.map(
        (f) => [Math.round(f.cx - refCx), Math.round(f.cy - refCy)] as [number, number],
      );
    }
  }

  const outPath = path.join(OUT_ATLAS_DIR, 'cat-frame-offsets.json');
  await fs.writeFile(outPath, JSON.stringify(offsets, null, 2));
  const breedCount = Object.keys(offsets).length;
  const animCount = Object.values(offsets).reduce(
    (acc, b) => acc + Object.keys(b).length,
    0,
  );
  console.log(
    `[offsets] ${breedCount} cats x ${animCount} animations -> ${path.relative(PROJECT_ROOT, outPath)}`,
  );
}

/** Round-trip an RGB color through HSL and enforce minimum lightness +
 *  saturation so a sampled "very dark muddy brown" lifts into a visible
 *  warm tone. Lane tints get this before being written to JSON so the
 *  game never has to brighten at runtime. */
function ensureBrightness(c: { r: number; g: number; b: number }): { r: number; g: number; b: number } {
  const MIN_L = 0.45;
  const MIN_S = 0.35;
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  const newL = Math.max(l, MIN_L);
  const newS = Math.max(s, MIN_S);
  const q = newL < 0.5 ? newL * (1 + newS) : newL + newS - newL * newS;
  const p = 2 * newL - q;
  const hue2rgb = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return {
    r: Math.round(hue2rgb(h + 1 / 3) * 255),
    g: Math.round(hue2rgb(h) * 255),
    b: Math.round(hue2rgb(h - 1 / 3) * 255),
  };
}

/**
 * Sample three dominant lane colors per background by scanning the floor
 * zone of each `themes/<id>-bg.png`. The bg's bottom 75% is open floor
 * (per the v7 prompt spec), so picking three distinct dominant colors
 * from image y 600–1500 gives us hues that already live in the scene —
 * `Game.drawLanes` paints semi-transparent fills with these so the lanes
 * feel like they belong to the bg instead of "UI stamped on top."
 *
 * Quantization: posterize each pixel to 5 bits per channel (32 levels)
 * and count buckets. Pick the most common, then keep walking the sorted
 * list and add the next bucket only if it's >= MIN_DIST away in RGB
 * from every already-picked color. Caps at 3.
 *
 * Output shape:
 *   {
 *     "stage":  ["#1a0a2e", "#3a2050", "#5a3070"],
 *     "arcade": ["#2a1450", "#4a2090", "#6a3070"],
 *     ...
 *   }
 */
async function writeBgLaneColors(): Promise<void> {
  const themesDir = path.join(OUT_PUBLIC, 'themes');
  const entries = await fs.readdir(themesDir).catch(() => [] as string[]);
  const bgs = entries.filter((f) => f.endsWith('-bg.png')).sort();
  if (bgs.length === 0) {
    console.warn('[lane-colors] no bg pngs found — skipping');
    return;
  }

  const MIN_DIST = 70; // RGB euclidean — keeps the 3 lane colors visually distinct
  const result: Record<string, [string, string, string]> = {};

  for (const file of bgs) {
    const id = file.replace(/-bg\.png$/, '');
    const filepath = path.join(themesDir, file);
    try {
      // Floor zone scales with the image. Standard bgs are 1024×1536
      // (floor zone roughly y 600–1500), but Tim's older bgs landed at
      // other sizes — compute the zone from the actual metadata so we
      // never miss past the image edge.
      const meta = await sharp(filepath).metadata();
      const W = meta.width ?? 1024;
      const H = meta.height ?? 1536;
      const top = Math.floor(H * 0.40);  // skip the decorated upper portion
      const bot = Math.floor(H * 0.95);  // skip a couple of px of bottom edge
      const cropH = bot - top;
      const { data, info } = await sharp(filepath)
        .extract({ left: 0, top, width: W, height: cropH })
        .resize(48, 48, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true });

      const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
      const stride = info.channels;
      for (let i = 0; i < data.length; i += stride) {
        const r5 = data[i]! >> 3;
        const g5 = data[i + 1]! >> 3;
        const b5 = data[i + 2]! >> 3;
        const key = (r5 << 10) | (g5 << 5) | b5;
        const prev = buckets.get(key);
        if (prev) prev.count++;
        else buckets.set(key, { count: 1, r: r5 << 3, g: g5 << 3, b: b5 << 3 });
      }

      const sorted = [...buckets.values()].sort((a, b) => b.count - a.count);
      const picks: { r: number; g: number; b: number }[] = [];
      // Skip ultra-dark buckets entirely — they collapse to identical bright
      // hues after the brightness boost. Luminance via Rec. 709 weights.
      const MIN_LUMA = 50;
      // Distance check operates on BRIGHTENED candidates, not raw, so two
      // distinct near-black floor pixels don't collapse to the same bright
      // tint and become duplicate lanes.
      for (const c of sorted) {
        const luma = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
        if (luma < MIN_LUMA) continue;
        const bright = ensureBrightness({ r: c.r, g: c.g, b: c.b });
        let tooClose = false;
        for (const p of picks) {
          const dr = bright.r - p.r;
          const dg = bright.g - p.g;
          const db = bright.b - p.b;
          if (Math.sqrt(dr * dr + dg * dg + db * db) < MIN_DIST) {
            tooClose = true;
            break;
          }
        }
        if (!tooClose) {
          picks.push(bright);
          if (picks.length === 3) break;
        }
      }
      // Synthesize a fallback by shifting hue if we couldn't find 3
      // distinct colors (very monochrome floors like marble).
      while (picks.length < 3) {
        const last = picks[picks.length - 1] ?? { r: 180, g: 180, b: 200 };
        picks.push({
          r: (last.r + 70) % 256,
          g: (last.g + 110) % 256,
          b: (last.b + 50) % 256,
        });
      }

      const toHex = (n: number) => n.toString(16).padStart(2, '0');
      result[id] = picks.map(
        (p) => `#${toHex(p.r)}${toHex(p.g)}${toHex(p.b)}`,
      ) as [string, string, string];
    } catch (e) {
      console.warn(`[lane-colors] sampling ${id} failed: ${(e as Error).message}`);
    }
  }

  const outPath = path.join(OUT_ATLAS_DIR, 'bg-lane-colors.json');
  await fs.writeFile(outPath, JSON.stringify(result, null, 2));
  console.log(
    `[lane-colors] ${Object.keys(result).length} bgs sampled -> ${path.relative(PROJECT_ROOT, outPath)}`,
  );
}

/**
 * Generate tintable greyscale versions of the lane backdrop + hit target.
 * The hard requirement (from playtest feedback): the original's texture
 * detail — paw print, fuzzy edges, drawn borders — has to stay visible
 * after tinting, but the asset should read as "mostly white with grey
 * shadows" so `setTint(color)` produces a bright-tinted shape rather
 * than a muddy multiplication of two saturated colors.
 *
 * Approach (per-image histogram stretch, NOT the earlier "normalize
 * brightest to 255" which crushed the dark-light variation):
 *   1. Compute Rec. 709 luma for each visible pixel.
 *   2. Find the actual luma range of the source (minLuma .. maxLuma,
 *      ignoring fully transparent pixels).
 *   3. Linearly stretch that range to OUT_MIN .. 255, where OUT_MIN is
 *      set high (~110) so the output is predominantly bright. The
 *      stretch preserves every brightness DIFFERENCE in the source —
 *      so a paw-print pixel that was 10 luma darker than its
 *      surrounding fill stays 10ish luma darker in the output, just
 *      lifted into the bright half of the range.
 *   4. Anti-aliased edge pixels (luma close to minLuma but with low
 *      alpha) keep their alpha so the silhouette stays clean.
 *
 * Alpha is preserved verbatim. File suffix stays `-white.png` for
 * backwards compatibility with AssetKeys / Preloader; the content
 * inside is greyscale-stretched, not flat white.
 */
async function makeWhiteBaseTintables(): Promise<void> {
  const sources: Array<{ src: string; dst: string }> = [
    { src: 'rythmBarBackground.png', dst: 'rythmBarBackground-white.png' },
    { src: 'PSTarget.png', dst: 'PSTarget-white.png' },
    // Falling-note ball — same logic as the lane track + target so the
    // note matches its lane's hit target on every bg. Splits ran in
    // splitPsElementIntoBallAndLetters() before this loop, so the input
    // file is already in OUT_IMAGES.
    { src: 'PSElement_ball.png', dst: 'PSElement_ball-white.png' },
  ];
  // Output range: shadows stay distinctly grey (so paw print / borders
  // remain visible darker areas inside the tinted shape), highlights
  // hit 255 so the tint comes through at full saturation.
  const OUT_MIN = 110;
  const OUT_MAX = 255;
  const OUT_RANGE = OUT_MAX - OUT_MIN;

  for (const { src, dst } of sources) {
    const srcPath = path.join(OUT_IMAGES, src);
    const dstPath = path.join(OUT_IMAGES, dst);
    try {
      const { data, info } = await sharp(srcPath)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const stride = info.channels;
      const pxCount = data.length / stride;
      const lumas = new Uint16Array(pxCount);

      // Pass 1: compute Rec. 709 luma per visible pixel + track the
      // ACTUAL source range. Skipping transparent pixels makes the
      // stretch reflect the artwork's own contrast envelope, not the
      // transparent border's zero floor.
      let minLuma = 255;
      let maxLuma = 0;
      for (let i = 0; i < data.length; i += stride) {
        const idx = i / stride;
        if (data[i + 3]! === 0) {
          lumas[idx] = 0;
          continue;
        }
        const luma = Math.round(
          0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!,
        );
        lumas[idx] = luma;
        if (luma > maxLuma) maxLuma = luma;
        if (luma < minLuma) minLuma = luma;
      }

      // Pass 2: stretch [minLuma..maxLuma] -> [OUT_MIN..255]. Each
      // visible pixel ends up greyscale (R=G=B=stretched). Alpha is
      // already verbatim from the source so anti-aliased edges keep
      // their silhouette.
      const sourceRange = Math.max(1, maxLuma - minLuma);
      for (let i = 0; i < data.length; i += stride) {
        if (data[i + 3]! === 0) continue;
        const luma = lumas[i / stride]!;
        const t = (luma - minLuma) / sourceRange; // 0..1
        const v = Math.round(OUT_MIN + t * OUT_RANGE);
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
      }
      await sharp(data, {
        raw: { width: info.width, height: info.height, channels: info.channels },
      })
        .png()
        .toFile(dstPath);
      console.log(
        `[tint-base] ${src} -> ${path.relative(PROJECT_ROOT, dstPath)} (src ${minLuma}..${maxLuma} → ${OUT_MIN}..${OUT_MAX})`,
      );
    } catch (e) {
      console.warn(`[tint-base] ${src} failed: ${(e as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  await ensureDirs();
  const catFrames = await extractCatGifs();
  await packAtlas(catFrames, 'cats');
  await writeCatFrameOffsets();
  const cosmeticFrames = await extractCosmeticGifs();
  await packAtlas(cosmeticFrames, 'cosmetics');
  await copyStaticAssets();
  await splitPsElementIntoBallAndLetters();
  await trimMeowBarFill();
  await makeWhiteBaseTintables();
  await writeBgLaneColors();
  console.log('done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
