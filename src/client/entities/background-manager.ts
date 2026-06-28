import * as Phaser from 'phaser';
import { GameObjects, Scene } from 'phaser';
import { BACKGROUND_CATALOG } from '@/../shared/state';
import type { BackgroundId } from '@/../shared/state';
import { TopHud } from '@/ui/top-hud';

const KNOWN_IDS = Object.keys(BACKGROUND_CATALOG) as BackgroundId[];

/** Module-level dedup so multiple BackgroundManager instances (across
 *  scenes, or this scene + Decorate's picker) don't trigger duplicate
 *  fetches for the same bg key. Resolves to the same promise. */
const pendingBgLoads = new Map<string, Promise<void>>();

/**
 * Draws a themed procedural backdrop behind the cat stage.
 *
 * Usage:
 *   const bg = new BackgroundManager(scene);
 *   const container = bg.create();          // call in scene create()
 *   bg.setBackground('cozy');               // swap at any time
 *   bg.destroy();                           // call on scene SHUTDOWN
 *
 * The container sits at depth -100 so it renders behind everything else.
 * Art is procedural for v1 (gradient rect + scenery emoji). Swap `draw()`
 * internals for atlas keys once backdrop art lands.
 */
export class BackgroundManager {
  active: BackgroundId = 'stage';
  private container: GameObjects.Container | undefined;

  constructor(private scene: Scene) {}

  create(): GameObjects.Container {
    this.container = this.scene.add.container(0, 0);
    this.container.setDepth(-100);
    this.draw();
    return this.container;
  }

  setBackground(id: BackgroundId): void {
    this.active = KNOWN_IDS.includes(id) ? id : 'stage';
    this.draw(); // shows fallback rect immediately if texture missing
    // Lazy-load the bg PNG if it's not already in the texture cache.
    // Preloader no longer eager-loads every theme (was 119MB cold-load);
    // theme bgs fetch on demand here. Once loaded, draw() runs again so
    // the fallback rect swaps to the real bg.
    const entry = BACKGROUND_CATALOG[this.active];
    if (entry && !this.scene.textures.exists(entry.backdropKey)) {
      const targetId = this.active;
      void loadBgIfMissing(this.scene, this.active).then(() => {
        // Only redraw if the user hasn't picked a different bg while
        // this one was loading. Stale completions are silently dropped.
        if (this.active === targetId && this.container) this.draw();
      }).catch((err) => {
        console.warn('[bg] lazy load failed for', targetId, err);
        // Fallback rect already showing from the draw() above; nothing to undo.
      });
    }
  }

  /** Redraws the container contents for the active background id.
   *  Renders the catalog's backdrop texture stretched to fill the
   *  canvas. Falls back to a solid color rect if the texture isn't
   *  loaded so the scene never goes blank. Safe to call on background
   *  changes — not a per-frame hot path. */
  private draw(): void {
    if (!this.container) return;
    this.container.removeAll(true);

    const w = this.scene.scale.width;
    const h = this.scene.scale.height;
    // Reserve the top strip for the TopHud so the bg starts where the
    // play area starts. Without this, the backdrop renders behind the
    // header and the platforms in the upper third of the image fall
    // under the HUD bar instead of where the seated cats actually sit.
    const offsetY = TopHud.HEIGHT;
    const drawH = h - offsetY;
    const entry = BACKGROUND_CATALOG[this.active];

    if (entry && this.scene.textures.exists(entry.backdropKey)) {
      // Per-bg vertical shift + scale read from the calibrator-driven
      // catalog. shiftUp moves the image up in design pixels so the
      // source's platforms land at the cat-seat row. bgScale zooms the
      // image (anchored at center) — > 1 crops in on the platforms,
      // < 1 leaves empty space at the edges.
      const e = entry as typeof entry & { bgShiftUp?: number; bgScale?: number };
      const shiftDesign = e.bgShiftUp ?? 0;
      const bgScale = e.bgScale ?? 1;
      const scaleY = h / 580;
      const shift = shiftDesign * scaleY;
      const scaledW = w * bgScale;
      const scaledH = drawH * bgScale;
      // Center horizontally; center vertically inside the original draw box,
      // then apply the upward shift.
      const x = (w - scaledW) / 2;
      const y = offsetY + (drawH - scaledH) / 2 - shift;
      const img = this.scene.add
        .image(x, y, entry.backdropKey)
        .setOrigin(0, 0);
      img.displayWidth = scaledW;
      img.displayHeight = scaledH;
      this.container.add(img);
      return;
    }

    // Texture missing — solid color fallback so the lane stays readable.
    const fallback = this.scene.add
      .rectangle(0, offsetY, w, drawH, 0x3b2a5c)
      .setOrigin(0, 0);
    this.container.add(fallback);
  }

  destroy(): void {
    this.container?.destroy(true);
    this.container = undefined;
  }
}

/** Lazy-load a single theme bg PNG into the scene's texture cache.
 *  Idempotent + deduped at module scope — calling twice for the same
 *  bg returns the same in-flight promise. No-ops if the texture is
 *  already loaded.
 *
 *  Uses a FRESH Phaser.Loader.LoaderPlugin (not the scene's default
 *  `this.load`) so the load doesn't put the scene into its LOADING
 *  state. Prior attempt #1 used `this.load.image + this.load.start`
 *  on the active scene, which conflicted with the hamburger drawer's
 *  open/close tween. A separate LoaderPlugin instance has its own
 *  state machine + still uses Phaser's URL resolver + texture cache
 *  (fixes prior attempt #2's native-Image URL-resolution issue in
 *  Devvit's webview iframe). `setPath('assets')` mirrors Preloader's
 *  base path exactly so theme URLs resolve identically. */
export function loadBgIfMissing(scene: Scene, bgId: BackgroundId): Promise<void> {
  const entry = BACKGROUND_CATALOG[bgId];
  if (!entry) return Promise.reject(new Error(`unknown bg id: ${bgId}`));
  if (scene.textures.exists(entry.backdropKey)) return Promise.resolve();
  const existing = pendingBgLoads.get(entry.backdropKey);
  if (existing) return existing;
  const promise = new Promise<void>((resolve, reject) => {
    const loader = new Phaser.Loader.LoaderPlugin(scene);
    loader.setPath('assets');
    loader.image(entry.backdropKey, `themes/${entry.id}-bg.png`);
    loader.once(Phaser.Loader.Events.COMPLETE, () => {
      pendingBgLoads.delete(entry.backdropKey);
      loader.destroy();
      resolve();
    });
    loader.once(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
      console.warn('[bg-lazy] failed:', file.key, file.url);
      pendingBgLoads.delete(entry.backdropKey);
      loader.destroy();
      reject(new Error(`bg load failed: ${file.url}`));
    });
    loader.start();
  });
  pendingBgLoads.set(entry.backdropKey, promise);
  return promise;
}
