/**
 * fx-scan harness — applies every generated effect to a dummy sprite in a
 * bare Phaser scene so the Playwright driver can detect apply-time throws,
 * per-frame throws (RAF-chain death), and hard main-thread stalls.
 *
 * Diagnostic tool only. Never shipped in the game bundle.
 */
import Phaser from 'phaser';
import { NEW_EFFECT_CATALOG } from '@/shared/effect-catalog-gen';
import { makeCatEffectFromMeta } from '@/effects/effect-interpreter';
import type { EffectHandle } from '@/effects/cat-effects';

// Interpreter references the global Phaser namespace (Phaser.Display.…).
(window as unknown as { Phaser: typeof Phaser }).Phaser = Phaser;

type ScanApi = {
  ids(): string[];
  start(id: string): string | null; // returns error message or null
  frames(): number;
  baseline(): void;
  pixelDelta(): number; // pixels differing from the effect-free baseline
  stop(): string | null;
};

const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) =>
  errors.push(String((e as PromiseRejectionEvent).reason)),
);

class ScanScene extends Phaser.Scene {
  frameCount = 0;
  target!: Phaser.GameObjects.Sprite;
  handle: EffectHandle | null = null;

  create(): void {
    const g = this.add.graphics();
    g.fillStyle(0x888888, 1);
    g.fillRect(0, 0, 64, 64);
    g.generateTexture('dummy-cat', 64, 64);
    g.destroy();
    this.target = this.add.sprite(240, 320, 'dummy-cat').setScale(1.4);

    let base: Uint8ClampedArray | null = null;
    // WebGL-safe: blit the game canvas into an offscreen 2d canvas
    // (requires preserveDrawingBuffer: true in the game config below).
    const off = document.createElement('canvas');
    const grab = (): Uint8ClampedArray => {
      const canvas = this.game.canvas;
      off.width = canvas.width; off.height = canvas.height;
      const ctx = off.getContext('2d')!;
      ctx.drawImage(canvas, 0, 0);
      return ctx.getImageData(0, 0, off.width, off.height).data;
    };

    const api: ScanApi = {
      ids: () => NEW_EFFECT_CATALOG.map((m) => m.id),
      baseline: () => { base = grab(); },
      pixelDelta: () => {
        if (!base) return -1;
        const now = grab();
        let delta = 0;
        for (let i = 0; i < now.length; i += 4) {
          if (
            Math.abs(now[i] - base[i]) > 8 ||
            Math.abs(now[i + 1] - base[i + 1]) > 8 ||
            Math.abs(now[i + 2] - base[i + 2]) > 8
          ) delta++;
        }
        return delta;
      },
      start: (id: string) => {
        errors.length = 0;
        const meta = NEW_EFFECT_CATALOG.find((m) => m.id === id);
        if (!meta) return `no meta for ${id}`;
        try {
          this.handle = makeCatEffectFromMeta(meta).apply(this, this.target, 1.4);
        } catch (err) {
          return `APPLY THROW: ${String(err)}`;
        }
        return null;
      },
      frames: () => this.frameCount,
      stop: () => {
        try {
          this.handle?.destroy();
        } catch (err) {
          return `DESTROY THROW: ${String(err)}`;
        } finally {
          this.handle = null;
        }
        return errors.length ? `TICK THROW: ${errors.join(' | ')}` : null;
      },
    };
    (window as unknown as { __scan: ScanApi }).__scan = api;
    (window as unknown as { __scene: Phaser.Scene }).__scene = this;
    (window as unknown as { __ready: boolean }).__ready = true;
  }

  update(): void {
    this.frameCount++;
  }
}

new Phaser.Game({
  type: Phaser.AUTO, // match the game's config (game.ts uses AUTO)
  width: 480,
  height: 640,
  backgroundColor: '#101018',
  render: { preserveDrawingBuffer: true },
  scene: [ScanScene],
});
