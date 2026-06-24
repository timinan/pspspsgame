import { GameObjects, Scene } from 'phaser';
import type { GenDifficulty } from '@/../shared/chart-generator';

interface DifficultyOption {
  id: GenDifficulty;
  label: string;
  blurb: string;
  color: number;
}

const OPTIONS: DifficultyOption[] = [
  { id: 'easy',   label: 'EASY',   blurb: 'Sparse beats, generous timing', color: 0x70d76b },
  { id: 'medium', label: 'NORMAL', blurb: 'Balanced — the default rehearsal', color: 0xffd34d },
  { id: 'hard',   label: 'HARD',   blurb: 'Dense chart, tight windows', color: 0xff6b6b },
];

/**
 * After a song is picked in the Rehearse flow, this modal asks the
 * player how hard they want the chart to be. Three vertical buttons
 * with a primary color band per option, plus START to commit and BACK
 * to return to the song picker. Same purple modal language as the
 * dressing room + song picker.
 */
export class DifficultyPickerModal {
  private container: GameObjects.Container | null = null;
  private selectedIdx = 1; // default: normal
  private optionBgs: GameObjects.Rectangle[] = [];
  private optionTexts: GameObjects.Text[] = [];
  private onStartRef: ((d: GenDifficulty) => void) | null = null;
  private onBackRef: (() => void) | null = null;

  constructor(private scene: Scene) {}

  open(args: {
    initial?: GenDifficulty;
    onStart: (difficulty: GenDifficulty) => void;
    onBack?: () => void;
  }): void {
    this.close();
    this.onStartRef = args.onStart;
    this.onBackRef = args.onBack ?? null;
    if (args.initial) {
      const idx = OPTIONS.findIndex((o) => o.id === args.initial);
      if (idx >= 0) this.selectedIdx = idx;
    }

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
    const panelH = 380;
    const panel = this.scene.add
      .rectangle(cx, cy, panelW, panelH, 0x1a0a2e, 1)
      .setStrokeStyle(2, 0xc678ff, 0.8)
      .setInteractive();
    panel.on('pointerdown', (_p: unknown, _x: unknown, _y: unknown, e: Phaser.Types.Input.EventData) =>
      e.stopPropagation(),
    );
    this.container.add(panel);

    // ← BACK chip
    const backY = cy - panelH / 2 + 22;
    const backX = cx - panelW / 2 + 28;
    const backChip = this.scene.add
      .text(backX, backY, '← BACK', {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '10px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    backChip.on('pointerdown', () => {
      const cb = this.onBackRef;
      this.close();
      cb?.();
    });
    this.container.add(backChip);

    const title = this.scene.add
      .text(cx, cy - panelH / 2 + 22, 'DIFFICULTY', {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '18px',
        color: '#ffd34d',
      })
      .setOrigin(0.5);
    this.container.add(title);

    const subtitle = this.scene.add
      .text(cx, cy - panelH / 2 + 48, 'How hard should the chart be?', {
        ...fontBase,
        fontSize: '10px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);
    this.container.add(subtitle);

    // Stacked option buttons
    const btnW = panelW - 48;
    const btnH = 58;
    const gap = 10;
    const topY = cy - panelH / 2 + 88 + btnH / 2;

    OPTIONS.forEach((opt, i) => {
      const y = topY + i * (btnH + gap);
      const isSelected = i === this.selectedIdx;
      const bg = this.scene.add
        .rectangle(cx, y, btnW, btnH, isSelected ? 0x4d2d8c : 0x2c1856, 1)
        .setStrokeStyle(2, isSelected ? opt.color : 0xc678ff, isSelected ? 1 : 0.5)
        .setInteractive({ useHandCursor: true });
      const lbl = this.scene.add
        .text(cx, y - 10, opt.label, {
          ...fontBase,
          fontStyle: 'bold',
          fontSize: '16px',
          color: isSelected ? this.colorToHex(opt.color) : '#ffffff',
        })
        .setOrigin(0.5);
      const blurb = this.scene.add
        .text(cx, y + 12, opt.blurb, {
          ...fontBase,
          fontSize: '9px',
          color: '#c0a0e6',
        })
        .setOrigin(0.5);
      bg.on('pointerdown', () => {
        if (this.selectedIdx === i) return;
        this.selectedIdx = i;
        this.refreshOptions();
      });
      this.container!.add([bg, lbl, blurb]);
      this.optionBgs.push(bg);
      this.optionTexts.push(lbl);
    });

    // START button
    const startY = cy + panelH / 2 - 38;
    const startW = panelW - 60;
    const startH = 44;
    const startBg = this.scene.add
      .rectangle(cx, startY, startW, startH, 0xffd34d, 1)
      .setInteractive({ useHandCursor: true });
    const startTxt = this.scene.add
      .text(cx, startY, '▶ START', {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '18px',
        color: '#1a0a2e',
      })
      .setOrigin(0.5);
    startBg.on('pointerover', () => startBg.setFillStyle(0xffe680, 1));
    startBg.on('pointerout', () => startBg.setFillStyle(0xffd34d, 1));
    startBg.on('pointerdown', () => {
      const cb = this.onStartRef;
      const choice = OPTIONS[this.selectedIdx]!.id;
      this.close();
      cb?.(choice);
    });
    this.container.add([startBg, startTxt]);
  }

  close(): void {
    if (this.container) {
      this.container.destroy(true);
      this.container = null;
    }
    this.optionBgs = [];
    this.optionTexts = [];
    this.onStartRef = null;
    this.onBackRef = null;
    this.selectedIdx = 1;
  }

  destroy(): void {
    this.close();
  }

  private refreshOptions(): void {
    OPTIONS.forEach((opt, i) => {
      const bg = this.optionBgs[i];
      const lbl = this.optionTexts[i];
      if (!bg || !lbl) return;
      const isSelected = i === this.selectedIdx;
      bg.setFillStyle(isSelected ? 0x4d2d8c : 0x2c1856, 1);
      bg.setStrokeStyle(2, isSelected ? opt.color : 0xc678ff, isSelected ? 1 : 0.5);
      lbl.setColor(isSelected ? this.colorToHex(opt.color) : '#ffffff');
    });
  }

  private colorToHex(n: number): string {
    return '#' + n.toString(16).padStart(6, '0');
  }
}
