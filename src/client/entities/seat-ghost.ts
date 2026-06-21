import { GameObjects, Scene } from 'phaser';
import type { SeatPosition } from '@/constants/scene-slots';

/**
 * Dashed circle marker for cat seats. Same pattern as SlotGhost but a
 * circle outline with a "+" glyph in the center.
 *
 * Emits 'seat:tap' on the scene event emitter with the seat id as payload.
 */
export class SeatGhost extends GameObjects.Container {
  readonly seatId: string;
  private graphics: GameObjects.Graphics;
  private hitArea: GameObjects.Arc;
  private plus: GameObjects.Text;
  private pulseTween?: Phaser.Tweens.Tween;
  private radius = 24;

  constructor(scene: Scene, seat: SeatPosition) {
    super(scene, seat.x, seat.y);
    this.seatId = seat.id;

    this.graphics = scene.add.graphics();
    this.drawDashedCircle(0xc0a0e6, 0.4);

    this.hitArea = scene.add
      .circle(0, 0, this.radius, 0xffffff, 0)
      .setInteractive({ useHandCursor: true });
    this.hitArea.on('pointerdown', () => scene.events.emit('seat:tap', this.seatId));

    this.plus = scene.add
      .text(0, 0, '+', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '18px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);

    this.add([this.graphics, this.hitArea, this.plus]);
  }

  private drawDashedCircle(color: number, alpha: number): void {
    this.graphics.clear();
    this.graphics.lineStyle(2, color, alpha);
    const segments = 24;
    for (let i = 0; i < segments; i += 2) {
      const a1 = (i / segments) * Math.PI * 2;
      const a2 = ((i + 1) / segments) * Math.PI * 2;
      this.graphics.beginPath();
      this.graphics.arc(0, 0, this.radius, a1, a2);
      this.graphics.strokePath();
    }
  }

  /** Pulse green to indicate it's a valid drop target. */
  startPulse(color: number = 0x4dffb4): void {
    this.drawDashedCircle(color, 0.9);
    this.plus.setColor('#4dffb4');
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
    this.drawDashedCircle(0xc0a0e6, 0.4);
    this.plus.setColor('#c0a0e6');
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
