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
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (data[(y * w + x) * 4 + 3]! > 0) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      // Fully-transparent frame: skip (no visible pixels = nothing to pack)
      if (maxX < minX || maxY < minY) return null;
      return {
        ...f,
        origW: w,
        origH: h,
        trimX: minX,
        trimY: minY,
        trimW: maxX - minX + 1,
        trimH: maxY - minY + 1,
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
    path.join(PROTOTYPE_SOUNDS, 'pspsps.mp3'),
    path.join(OUT_SOUNDS, 'pspsps.mp3'),
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
    const cx = f.spriteSourceSize.x + f.spriteSourceSize.w / 2;
    const cy = f.spriteSourceSize.y + f.spriteSourceSize.h / 2;
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
  console.log('done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
