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
    const gifs = await glob(`${srcDir}/*.gif`);
    // Sort 'idle' first so it wins de-dup ties if multiple suffixes map
    // to the same canonical animation.
    gifs.sort((a, b) => {
      const ai = path.basename(a).includes('idle') ? 0 : 1;
      const bi = path.basename(b).includes('idle') ? 0 : 1;
      return ai - bi;
    });

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
  }
  return all;
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

  const ATLAS_WIDTH = 2048;
  let x = 0;
  let y = 0;
  let shelfHeight = trimmed[0]?.trimH ?? 0;

  const placements: AtlasFrame[] = [];
  const composites: sharp.OverlayOptions[] = [];

  for (const f of trimmed) {
    if (x + f.trimW > ATLAS_WIDTH) {
      x = 0;
      y += shelfHeight;
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
    x += f.trimW;
  }

  const ATLAS_HEIGHT = y + shelfHeight;

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
      app: 'pspspsgame-extractor',
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

async function main(): Promise<void> {
  await ensureDirs();
  const catFrames = await extractCatGifs();
  await packAtlas(catFrames, 'cats');
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
