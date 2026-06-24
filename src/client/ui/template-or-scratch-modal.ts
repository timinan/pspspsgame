import { GameObjects, Scene } from 'phaser';

export type StartMode = 'template' | 'scratch';

/**
 * Two big stacked buttons asking the editor user how they want to start
 * their chart against the song they just picked. Template fills the chart
 * with a procedurally generated beat; Scratch leaves it empty at the
 * length needed to cover the round at the song's BPM.
 */
export class TemplateOrScratchModal {
  private container: GameObjects.Container | null = null;
  private onPickRef: ((mode: StartMode) => void) | null = null;
  private onBackRef: (() => void) | null = null;

  constructor(private scene: Scene) {}

  open(args: {
    onPick: (mode: StartMode) => void;
    onBack?: () => void;
  }): void {
    this.close();
    this.onPickRef = args.onPick;
    this.onBackRef = args.onBack ?? null;

    const { width, height } = this.scene.scale;
    const cx = width / 2;
    const cy = height / 2;
    const fontBase = { fontFamily: 'Pixeloid Sans, sans-serif' };

    this.container = this.scene.add.container(0, 0).setDepth(400);

    const scrim = this.scene.add
      .rectangle(0, 0, width, height, 0x0b041a, 0.78)
      .setOrigin(0, 0)
      .setInteractive();
    scrim.on('pointerdown', (_p: unknown, _x: unknown, _y: unknown, e: Phaser.Types.Input.EventData) =>
      e.stopPropagation(),
    );
    this.container.add(scrim);

    const panelW = Math.min(284, width - 24);
    const panelH = 364;
    const panel = this.scene.add
      .rectangle(cx, cy, panelW, panelH, 0x1a0a2e, 1)
      .setStrokeStyle(2, 0xffd34d, 0.85)
      .setInteractive();
    panel.on('pointerdown', (_p: unknown, _x: unknown, _y: unknown, e: Phaser.Types.Input.EventData) =>
      e.stopPropagation(),
    );
    this.container.add(panel);

    // Red ✕ close — project standard from DressingRoom.
    const closeCx = cx + panelW / 2 - 18;
    const closeCy = cy - panelH / 2 + 18;
    const closeBg = this.scene.add
      .circle(closeCx, closeCy, 12, 0xff5050, 1)
      .setStrokeStyle(2, 0x0b041a, 1)
      .setInteractive({ useHandCursor: true });
    const closeGlyph = this.scene.add
      .text(closeCx, closeCy, '✕', {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#ffffff',
      })
      .setOrigin(0.5);
    closeBg.on('pointerdown', () => {
      const cb = this.onBackRef;
      this.close();
      cb?.();
    });
    this.container.add([closeBg, closeGlyph]);

    const title = this.scene.add
      .text(cx, cy - panelH / 2 + 22, 'START FROM', {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '18px',
        color: '#ffd34d',
      })
      .setOrigin(0.5);
    this.container.add(title);

    const subtitle = this.scene.add
      .text(cx, cy - panelH / 2 + 48, 'Begin with a generated pattern or a blank grid', {
        ...fontBase,
        fontSize: '10px',
        color: '#c0a0e6',
        align: 'center',
        wordWrap: { width: panelW - 32 },
      })
      .setOrigin(0.5);
    this.container.add(subtitle);

    // Three stacked buttons: TEMPLATE / SCRATCH / BACK. BACK is the new
    // third button (was a chip in the corner — looked awkward + small,
    // see Tim's mockup feedback). All three sit centered with even gaps
    // so the panel breathes properly.
    const btnW = panelW - 48;
    const btnH = 76;
    const backH = 40;
    const gap = 12;
    const totalH = btnH * 2 + backH + gap * 2;
    const topY = cy + 8 - totalH / 2 + btnH / 2;

    this.addOption(cx, topY, btnW, btnH, 'TEMPLATE', 'A generated beat you can tweak', 0xffd34d, () => {
      const cb = this.onPickRef;
      this.close();
      cb?.('template');
    });
    this.addOption(cx, topY + btnH + gap, btnW, btnH, 'SCRATCH', 'Empty grid, build your own', 0x4dffb4, () => {
      const cb = this.onPickRef;
      this.close();
      cb?.('scratch');
    });

    // BACK as the third button, smaller and secondary so it doesn't
    // compete with TEMPLATE / SCRATCH for the eye.
    const backY = topY + btnH * 2 + gap * 2 + (backH - btnH) / 2;
    const backBg = this.scene.add
      .rectangle(cx, backY, btnW, backH, 0x2c1856, 1)
      .setStrokeStyle(2, 0xc0a0e6, 0.55)
      .setInteractive({ useHandCursor: true });
    const backLbl = this.scene.add
      .text(cx, backY, '← BACK', {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '14px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);
    backBg.on('pointerover', () => backBg.setFillStyle(0x3d2566, 1));
    backBg.on('pointerout', () => backBg.setFillStyle(0x2c1856, 1));
    backBg.on('pointerdown', () => {
      const cb = this.onBackRef;
      this.close();
      cb?.();
    });
    this.container.add([backBg, backLbl]);
  }

  close(): void {
    if (this.container) {
      this.container.destroy(true);
      this.container = null;
    }
    this.onPickRef = null;
    this.onBackRef = null;
  }

  destroy(): void {
    this.close();
  }

  private addOption(
    cx: number,
    cy: number,
    w: number,
    h: number,
    label: string,
    blurb: string,
    color: number,
    onTap: () => void,
  ): void {
    if (!this.container) return;
    const fontBase = { fontFamily: 'Pixeloid Sans, sans-serif' };
    const bg = this.scene.add
      .rectangle(cx, cy, w, h, 0x2c1856, 1)
      .setStrokeStyle(2, color, 0.85)
      .setInteractive({ useHandCursor: true });
    const lbl = this.scene.add
      .text(cx, cy - 14, label, {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '20px',
        color: this.colorToHex(color),
      })
      .setOrigin(0.5);
    const blurbText = this.scene.add
      .text(cx, cy + 16, blurb, {
        ...fontBase,
        fontSize: '10px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);
    bg.on('pointerover', () => bg.setFillStyle(0x3d2566, 1));
    bg.on('pointerout', () => bg.setFillStyle(0x2c1856, 1));
    bg.on('pointerdown', onTap);
    this.container.add([bg, lbl, blurbText]);
  }

  private colorToHex(n: number): string {
    return '#' + n.toString(16).padStart(6, '0');
  }
}
