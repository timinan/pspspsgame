import { GameObjects, Scene } from 'phaser';
import type { SceneSlot } from '@/constants/scene-slots';

/**
 * Visible-during-edit-mode dashed rectangle that marks where a decoration
 * can be placed. Drawn via Phaser.Graphics (no asset needed). Includes an
 * invisible Rectangle hit area for tap detection.
 *
 * Tap events are emitted as 'slot:tap' on the scene's event emitter with
 * the slot id as payload. The scene routes them to the placement handler.
 */
export class SlotGhost extends GameObjects.Container {
  readonly slotId: string;
  private graphics: GameObjects.Graphics;
  private hitArea: GameObjects.Rectangle;
  private label: GameObjects.Text;
  private pulseTween?: Phaser.Tweens.Tween;
  private readonly _width: number;
  private readonly _height: number;

  constructor(scene: Scene, slot: SceneSlot, width = 50, height = 50) {
    super(scene, slot.x, slot.y);
    this.slotId = slot.id;
    this._width = width;
    this._height = height;

    this.graphics = scene.add.graphics();
    this.drawDashed(0xc0a0e6, 0.4);

    this.hitArea = scene.add
      .rectangle(0, 0, width, height, 0xffffff, 0)
      .setInteractive({ useHandCursor: true });
    this.hitArea.on('pointerdown', () => scene.events.emit('slot:tap', this.slotId));

    this.label = scene.add
      .text(0, 0, slot.label.toUpperCase().replace(' ', '\n'), {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '9px',
        color: '#c0a0e6',
        align: 'center',
      })
      .setOrigin(0.5);

    this.add([this.graphics, this.hitArea, this.label]);
  }

  private drawDashed(color: number, alpha: number): void {
    this.graphics.clear();
    this.graphics.lineStyle(2, color, alpha);
    const w = this._width;
    const h = this._height;
    // Simple dashed rectangle: 4px dash, 3px gap
    const dashes = (length: number) => Math.floor(length / 7);
    // Top
    for (let i = 0; i < dashes(w); i++) {
      const x0 = -w / 2 + i * 7;
      this.graphics.lineBetween(x0, -h / 2, x0 + 4, -h / 2);
    }
    // Bottom
    for (let i = 0; i < dashes(w); i++) {
      const x0 = -w / 2 + i * 7;
      this.graphics.lineBetween(x0, h / 2, x0 + 4, h / 2);
    }
    // Left
    for (let i = 0; i < dashes(h); i++) {
      const y0 = -h / 2 + i * 7;
      this.graphics.lineBetween(-w / 2, y0, -w / 2, y0 + 4);
    }
    // Right
    for (let i = 0; i < dashes(h); i++) {
      const y0 = -h / 2 + i * 7;
      this.graphics.lineBetween(w / 2, y0, w / 2, y0 + 4);
    }
  }

  /** Pulse gold to indicate it's a valid drop target. */
  startPulse(color: number = 0xffd34d): void {
    this.drawDashed(color, 0.9);
    if (this.pulseTween) this.pulseTween.stop();
    this.pulseTween = this.scene.tweens.add({
      targets: this,
      alpha: { from: 0.7, to: 1 },
      duration: 600,
      yoyo: true,
      repeat: -1,
    });
  }

  stopPulse(): void {
    if (this.pulseTween) {
      this.pulseTween.stop();
      delete this.pulseTween;
    }
    this.drawDashed(0xc0a0e6, 0.4);
    this.setAlpha(1);
  }

  override destroy(fromScene?: boolean): void {
    if (this.pulseTween) {
      this.pulseTween.stop();
      delete this.pulseTween;
    }
    super.destroy(fromScene);
  }
}
