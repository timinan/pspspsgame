import { GameObjects, Scene } from 'phaser';

/**
 * Placeholder rewards modal — the REWARDS drawer entry opens this until
 * the real rewards feature ships. Title + body + single OK button.
 */
export class RewardsComingSoonModal {
  private container: GameObjects.Container | null = null;

  constructor(private scene: Scene) {}

  open(): void {
    this.close();
    const { width, height } = this.scene.scale;
    const w = 260;
    const h = 200;
    const cx = width / 2;
    const cy = height / 2;

    this.container = this.scene.add.container(0, 0).setDepth(400);

    const scrim = this.scene.add
      .rectangle(0, 0, width, height, 0x0b041a, 0.78)
      .setOrigin(0, 0)
      .setInteractive();
    scrim.on('pointerdown', () => this.close());
    this.container.add(scrim);

    const panel = this.scene.add
      .rectangle(cx, cy, w, h, 0x2c1856, 1)
      .setStrokeStyle(2, 0xffd34d, 1)
      .setInteractive();
    panel.on('pointerdown', (_p: unknown, _x: unknown, _y: unknown, e: Phaser.Types.Input.EventData) => e.stopPropagation());
    this.container.add(panel);

    const icon = this.scene.add
      .text(cx, cy - h / 2 + 30, '🎁', {
        fontSize: '32px',
      })
      .setOrigin(0.5);
    this.container.add(icon);

    const title = this.scene.add
      .text(cx, cy - 18, 'REWARDS', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '16px',
        color: '#ffd34d',
      })
      .setOrigin(0.5);
    this.container.add(title);

    const body = this.scene.add
      .text(
        cx,
        cy + 16,
        'Coming soon — daily logins,\nmilestone unlocks, weekly drops.\nCheck back often.',
        {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontSize: '10px',
          color: '#ffffff',
          align: 'center',
          wordWrap: { width: w - 24 },
        },
      )
      .setOrigin(0.5);
    this.container.add(body);

    const okBg = this.scene.add
      .rectangle(cx, cy + h / 2 - 24, 100, 28, 0xffd34d, 1)
      .setInteractive({ useHandCursor: true });
    const okLabel = this.scene.add
      .text(cx, cy + h / 2 - 24, 'OK', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#0b041a',
      })
      .setOrigin(0.5);
    okBg.on('pointerdown', () => this.close());
    this.container.add([okBg, okLabel]);
  }

  close(): void {
    if (this.container) {
      this.container.destroy(true);
      this.container = null;
    }
  }

  destroy(): void {
    this.close();
  }
}
