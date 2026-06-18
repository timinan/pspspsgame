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

async function main(): Promise<void> {
  await ensureDirs();
  const frames = await extractAllGifs();
  await packAtlas(frames);
  await copyStaticAssets();
  console.log('done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
