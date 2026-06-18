/*
 * Extracts cat GIF animations from the original pspsadopt prototype into
 * Phaser-friendly assets:
 *   - public/assets/atlas/cats.png + cats.json  (texture atlas)
 *   - public/assets/sounds/*.mp3                (background + pspsps sfx)
 *   - public/assets/images/*.png                (background + meow bar + rhythm bar)
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
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const OUT_RAW = path.join(PROJECT_ROOT, 'assets-raw');
const OUT_PUBLIC = path.join(PROJECT_ROOT, 'public', 'assets');
const OUT_ATLAS_DIR = path.join(OUT_PUBLIC, 'atlas');
const OUT_SOUNDS = path.join(OUT_PUBLIC, 'sounds');
const OUT_IMAGES = path.join(OUT_PUBLIC, 'images');

const BREEDS = ['cat1', 'cat2', 'cat3'] as const;

// Map prototype filename suffix -> our CatAnimationState in src/client/types/game.ts
const ANIMATION_MAP: Record<string, string> = {
  idle: 'idle',
  lick: 'lick',
  meow: 'meow',
  sleep_left: 'sleep',
  sleep_right: 'sleep',
  stretch_left: 'stretch',
  stretch_right: 'stretch',
  strech_right: 'stretch', // typo present in prototype; normalize
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
  for (const d of [OUT_RAW, OUT_PUBLIC, OUT_ATLAS_DIR, OUT_SOUNDS, OUT_IMAGES]) {
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

async function extractAllGifs(): Promise<ExtractedFrame[]> {
  const all: ExtractedFrame[] = [];
  for (const breed of BREEDS) {
    const breedSrcDir = path.join(PROTOTYPE_ASSETS, breed);
    const breedOutDir = path.join(OUT_RAW, breed);
    await fs.mkdir(breedOutDir, { recursive: true });

    const gifs = await glob(`${breedSrcDir}/*.gif`);
    for (const gifPath of gifs) {
      const base = path.basename(gifPath, '.gif');
      const suffix = base.replace(`${breed}_`, '');
      const animation = ANIMATION_MAP[suffix];
      if (!animation) {
        console.warn(`[skip unknown anim] ${gifPath}`);
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

interface AtlasFrame {
  filename: string;
  frame: { x: number; y: number; w: number; h: number };
  rotated: false;
  trimmed: false;
  spriteSourceSize: { x: 0; y: 0; w: number; h: number };
  sourceSize: { w: number; h: number };
}

async function packAtlas(frames: ExtractedFrame[]): Promise<void> {
  if (frames.length === 0) {
    throw new Error('No frames extracted — check prototype path / animation map');
  }

  // Read dimensions of every frame
  const sized = await Promise.all(
    frames.map(async (f) => {
      const meta = await sharp(f.srcPath).metadata();
      if (!meta.width || !meta.height) {
        throw new Error(`Missing dimensions for ${f.srcPath}`);
      }
      return { ...f, width: meta.width, height: meta.height };
    }),
  );

  // Simple shelf packing: rows of uniform-height shelves
  const SHELF_HEIGHT = Math.max(...sized.map((f) => f.height));
  const ATLAS_WIDTH = 2048;
  let x = 0;
  let y = 0;

  const placements: AtlasFrame[] = [];
  const composites: sharp.OverlayOptions[] = [];

  for (const f of sized) {
    if (x + f.width > ATLAS_WIDTH) {
      x = 0;
      y += SHELF_HEIGHT;
    }
    const filename = `${f.breed}_${f.animation}_${String(f.frameIndex).padStart(2, '0')}`;
    placements.push({
      filename,
      frame: { x, y, w: f.width, h: f.height },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: f.width, h: f.height },
      sourceSize: { w: f.width, h: f.height },
    });
    composites.push({ input: f.srcPath, left: x, top: y });
    x += f.width;
  }

  const ATLAS_HEIGHT = y + SHELF_HEIGHT;

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

  const atlasPngPath = path.join(OUT_ATLAS_DIR, 'cats.png');
  const atlasJsonPath = path.join(OUT_ATLAS_DIR, 'cats.json');
  await fs.writeFile(atlasPngPath, atlasPngBuffer);

  const atlasJson = {
    frames: placements,
    meta: {
      app: 'pspspsgame-extractor',
      version: '1',
      image: 'cats.png',
      format: 'RGBA8888',
      size: { w: ATLAS_WIDTH, h: ATLAS_HEIGHT },
      scale: '1',
    },
  };
  await fs.writeFile(atlasJsonPath, JSON.stringify(atlasJson, null, 2));

  console.log(
    `[atlas] ${ATLAS_WIDTH}x${ATLAS_HEIGHT}, ${placements.length} frames -> ${atlasPngPath}`,
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
  const frames = await extractAllGifs();
  await packAtlas(frames);
  await copyStaticAssets();
  await splitPsElementIntoBallAndLetters();
  await trimMeowBarFill();
  console.log('done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
