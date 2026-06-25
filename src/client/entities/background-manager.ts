import { GameObjects, Scene } from 'phaser';
import { BACKGROUND_CATALOG } from '@/../shared/state';
import type { BackgroundId } from '@/../shared/state';
import { TopHud } from '@/ui/top-hud';

const KNOWN_IDS = Object.keys(BACKGROUND_CATALOG) as BackgroundId[];

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
    this.draw();
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
