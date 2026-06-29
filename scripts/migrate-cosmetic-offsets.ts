/**
 * One-shot migration: recompute every cosmetic's catalog offsetX/offsetY/
 * scale to match where its art actually sits in the atlas today.
 *
 * Before this script: cosmetics.json's offsetX/offsetY were decorative
 * — set in the calibrator UI but ignored by the runtime. The runtime
 * positioned cosmetics purely by where the art landed in the 91×64
 * source canvas. So calibrator preview ≠ in-game render for most items.
 *
 * After this script + the matching runtime change in cat.ts: catalog
 * values describe reality. Runtime reads them. Calibrator drives the
 * game. Zero visual change for any existing cosmetic — we compute the
 * SAME numbers the runtime is implicitly using today.
 *
 * Math (matching the calibrator's preview drawing in
 * tools/cosmetics/calibrator.html):
 *   offsetX = (trimX + trimW/2) - 45   // art center relative to canvas centerline
 *   offsetY = (trimY + trimH/2) - 12   // art center relative to reference cat head top (12px = cat3 idle_00)
 *   scale   = 1.0
 *
 * Variants with sourceFrame (e.g. tint variants like c44 pointing at
 * cosmetic_c1_idle_00) inherit the parent's computed offsets, since
 * they share the parent's atlas frame.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const CATALOG_PATH = path.join(PROJECT_ROOT, 'tools', 'cosmetics', 'cosmetics.json');
const ATLAS_JSON_PATH = path.join(PROJECT_ROOT, 'public', 'assets', 'atlas', 'cosmetics.json');

// Anchor reference: cat3 idle_00 head-top-Y in canvas coordinates.
// All cats have head-top within 12-14 in their canvas; using cat3 as the
// reference means cosmetics are 0-2px lower on cats with deeper head tops.
// Acceptable variance (sub-pixel-noticeable).
const CAT_HEAD_TOP_REF = 12;
const CANVAS_HORIZONTAL_CENTER = 45; // 91-wide canvas centerline (rounded down from 45.5)

type CatalogEntry = {
  id: string;
  name: string;
  slot: string;
  rarity: string;
  offsetX: number;
  offsetY: number;
  scale: number;
  sourceFrame?: string;
  tint?: string;
  tintMode?: string;
  isStatic?: boolean;
  motionStrength?: number;
};

type AtlasFrame = {
  filename: string;
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
};

async function main(): Promise<void> {
  const catalog = JSON.parse(await fs.readFile(CATALOG_PATH, 'utf-8')) as CatalogEntry[];
  const atlas = JSON.parse(await fs.readFile(ATLAS_JSON_PATH, 'utf-8')) as { frames: AtlasFrame[] };
  const framesByName = new Map<string, AtlasFrame>();
  for (const f of atlas.frames) framesByName.set(f.filename, f);

  let updated = 0;
  let skipped = 0;
  const issues: string[] = [];

  for (const entry of catalog) {
    // Figure out which atlas frame holds the actual art for this cosmetic.
    // Variants (c44+) point at the parent's frame via sourceFrame; base
    // cosmetics use cosmetic_<id>_idle_00.
    const frameName = entry.sourceFrame ?? `cosmetic_${entry.id}_idle_00`;
    const frame = framesByName.get(frameName);
    if (!frame) {
      issues.push(`${entry.id}: no atlas frame found (${frameName}) — leaving catalog values unchanged`);
      skipped++;
      continue;
    }

    const trimX = frame.spriteSourceSize.x;
    const trimY = frame.spriteSourceSize.y;
    const trimW = frame.spriteSourceSize.w;
    const trimH = frame.spriteSourceSize.h;

    const newOffsetX = Math.round((trimX + trimW / 2) - CANVAS_HORIZONTAL_CENTER);
    const newOffsetY = Math.round((trimY + trimH / 2) - CAT_HEAD_TOP_REF);
    const newScale = 1.0;

    const oldX = entry.offsetX;
    const oldY = entry.offsetY;
    const oldScale = entry.scale;
    entry.offsetX = newOffsetX;
    entry.offsetY = newOffsetY;
    entry.scale = newScale;

    const drift = Math.abs(oldX - newOffsetX) + Math.abs(oldY - newOffsetY);
    const scaleChanged = Math.abs(oldScale - newScale) > 0.01;
    if (drift > 0 || scaleChanged) {
      console.log(
        `${entry.id} (${entry.name}): offsetX ${oldX}→${newOffsetX}, offsetY ${oldY}→${newOffsetY}, ` +
        `scale ${oldScale}→${newScale}`,
      );
    }
    updated++;
  }

  if (issues.length) {
    console.log('\n--- issues ---');
    for (const i of issues) console.log(' ', i);
  }
  console.log(`\nUpdated: ${updated}, Skipped: ${skipped}`);
  await fs.writeFile(CATALOG_PATH, JSON.stringify(catalog, null, 2));
  console.log(`\nWrote ${CATALOG_PATH}`);
}

await main();
