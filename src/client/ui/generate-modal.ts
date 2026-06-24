import { GameObjects, Scene } from 'phaser';
import type { BackingVibe } from '@/../shared/state';
import {
  buildTempoCycle,
  buildVibeCycle,
  type TempoEntry,
} from '@/systems/tempo-vibe-cycles';
import type { GenDifficulty } from '@/../shared/chart-generator';

const DIFFICULTIES: GenDifficulty[] = ['easy', 'medium', 'hard'];

export interface GenerateModalResult {
  difficulty: GenDifficulty;
  bpm: number;
  vibe: BackingVibe;
}

/**
 * Generate modal — shared by the editor's TEMPLATE button and the Play
 * scene's pre-round picker. Three cycle pickers (Difficulty / Tempo /
 * Vibe) and a primary GENERATE button. The caller passes initial values
 * (so the modal can echo the chart's current tempo+vibe when launched
 * from the editor) and a callback that receives the final selection.
 *
 * Self-destroys on Generate or Cancel. Pointer events on the scrim and
 * the panel are stopped so taps outside a button don't leak through to
 * the underlying scene (the editor grid is full-canvas).
 */
export class GenerateModal {
  private container: GameObjects.Container | null = null;

  constructor(private scene: Scene) {}

  open(args: {
    initial?: Partial<GenerateModalResult>;
    /** Optional copy overrides. The editor opens this modal as "GENERATE
     *  BEAT" / "GENERATE" since the action authors content; the Play
     *  scene reuses the same modal as a pre-round picker so it reads as
     *  "READY TO PLAY?" / "PLAY". Defaults preserve the editor wording. */
    title?: string;
    subtitle?: string;
    primaryLabel?: string;
    onGenerate: (result: GenerateModalResult) => void;
    onCancel?: () => void;
  }): void {
    this.close();

    const tempoCycle = buildTempoCycle();
    if (tempoCycle.length === 0) {
      // No music in the catalog — nothing to generate against. Bail out
      // immediately so the caller never gets a half-broken modal.
      console.warn('[GenerateModal] no backings available, refusing to open');
      args.onCancel?.();
      return;
    }

    let difficultyIdx = Math.max(
      0,
      DIFFICULTIES.indexOf(args.initial?.difficulty ?? 'medium'),
    );
    let tempoIdx = Math.max(
      0,
      tempoCycle.findIndex((t) => t.bpm === args.initial?.bpm),
    );
    if (tempoIdx < 0) tempoIdx = 0;
    let vibeCycle = buildVibeCycle(tempoCycle[tempoIdx]!.bpm);
    let vibeIdx = Math.max(
      0,
      args.initial?.vibe ? vibeCycle.indexOf(args.initial.vibe) : 0,
    );
    if (vibeIdx < 0) vibeIdx = 0;

    const { width, height } = this.scene.scale;
    const cx = width / 2;
    const cy = height / 2;
    const panelW = Math.min(280, width - 32);
    const panelH = 320;
    const fontBase = { fontFamily: 'Pixeloid Sans, sans-serif' };

    this.container = this.scene.add.container(0, 0).setDepth(400);

    const scrim = this.scene.add
      .rectangle(0, 0, width, height, 0x0b041a, 0.75)
      .setOrigin(0, 0)
      .setInteractive();
    scrim.on('pointerdown', (_p: unknown, _x: unknown, _y: unknown, e: Phaser.Types.Input.EventData) =>
      e.stopPropagation(),
    );
    this.container.add(scrim);

    const panel = this.scene.add
      .rectangle(cx, cy, panelW, panelH, 0x1a0a2e, 1)
      .setStrokeStyle(2, 0xc678ff, 0.8)
      .setInteractive();
    panel.on('pointerdown', (_p: unknown, _x: unknown, _y: unknown, e: Phaser.Types.Input.EventData) =>
      e.stopPropagation(),
    );
    this.container.add(panel);

    const title = this.scene.add
      .text(cx, cy - panelH / 2 + 22, args.title ?? 'GENERATE BEAT', {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '18px',
        color: '#ffd34d',
      })
      .setOrigin(0.5);
    this.container.add(title);

    const subtitle = this.scene.add
      .text(cx, cy - panelH / 2 + 48, args.subtitle ?? 'A fresh chart that fills the round', {
        ...fontBase,
        fontSize: '10px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);
    this.container.add(subtitle);

    // Three rows: Difficulty / Tempo / Vibe. Each row = label on left,
    // cycle button on right. Aligned so taps land on the button.
    const rowW = panelW - 40;
    const rowH = 40;
    const rowGap = 8;
    const rowsTop = cy - panelH / 2 + 78;
    const btnW = 110;
    const labelX = cx - rowW / 2;
    const btnX = cx + rowW / 2 - btnW / 2;

    const difficultyText = this.makeRow(rowsTop + 0 * (rowH + rowGap), 'DIFFICULTY', labelX, btnX, rowH, btnW, difficultyLabel(DIFFICULTIES[difficultyIdx]!));
    difficultyText.bg.on('pointerdown', () => {
      difficultyIdx = (difficultyIdx + 1) % DIFFICULTIES.length;
      difficultyText.txt.setText(difficultyLabel(DIFFICULTIES[difficultyIdx]!));
    });

    const tempoText = this.makeRow(rowsTop + 1 * (rowH + rowGap), 'TEMPO', labelX, btnX, rowH, btnW, tempoLabel(tempoCycle[tempoIdx]!));
    tempoText.bg.on('pointerdown', () => {
      tempoIdx = (tempoIdx + 1) % tempoCycle.length;
      tempoText.txt.setText(tempoLabel(tempoCycle[tempoIdx]!));
      // Tempo changed → vibe options may have changed too. Reset to the
      // first available so the picker can never show a stale vibe with
      // no backing at the new tempo.
      vibeCycle = buildVibeCycle(tempoCycle[tempoIdx]!.bpm);
      vibeIdx = 0;
      vibeText.txt.setText(vibeLabel(vibeCycle[vibeIdx]));
    });

    const vibeText = this.makeRow(rowsTop + 2 * (rowH + rowGap), 'VIBE', labelX, btnX, rowH, btnW, vibeLabel(vibeCycle[vibeIdx]));
    vibeText.bg.on('pointerdown', () => {
      if (vibeCycle.length === 0) return;
      vibeIdx = (vibeIdx + 1) % vibeCycle.length;
      vibeText.txt.setText(vibeLabel(vibeCycle[vibeIdx]));
    });

    // Footer buttons
    const footerY = cy + panelH / 2 - 32;
    const footBtnW = 110;
    const footBtnH = 38;
    const footGap = 12;

    const cancelBg = this.scene.add
      .rectangle(cx - footBtnW / 2 - footGap / 2, footerY, footBtnW, footBtnH, 0x2c1856, 1)
      .setStrokeStyle(1, 0xc0a0e6, 0.5)
      .setInteractive({ useHandCursor: true });
    const cancelText = this.scene.add
      .text(cx - footBtnW / 2 - footGap / 2, footerY, 'CANCEL', {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);
    cancelBg.on('pointerover', () => cancelBg.setFillStyle(0x3d2566, 1));
    cancelBg.on('pointerout', () => cancelBg.setFillStyle(0x2c1856, 1));
    cancelBg.on('pointerdown', () => {
      args.onCancel?.();
      this.close();
    });
    this.container.add([cancelBg, cancelText]);

    const genBg = this.scene.add
      .rectangle(cx + footBtnW / 2 + footGap / 2, footerY, footBtnW, footBtnH, 0xffd34d, 1)
      .setInteractive({ useHandCursor: true });
    const genText = this.scene.add
      .text(cx + footBtnW / 2 + footGap / 2, footerY, args.primaryLabel ?? 'GENERATE', {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '14px',
        color: '#1a0a2e',
      })
      .setOrigin(0.5);
    genBg.on('pointerover', () => genBg.setFillStyle(0xffe680, 1));
    genBg.on('pointerout', () => genBg.setFillStyle(0xffd34d, 1));
    genBg.on('pointerdown', () => {
      const result: GenerateModalResult = {
        difficulty: DIFFICULTIES[difficultyIdx]!,
        bpm: tempoCycle[tempoIdx]!.bpm,
        vibe: vibeCycle[vibeIdx] ?? 'upbeat',
      };
      args.onGenerate(result);
      this.close();
    });
    this.container.add([genBg, genText]);
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

  /** Build one labeled cycle-button row inside the panel. The label
   *  Text + button rect + button Text are all parented to the modal
   *  container so a single .destroy(true) cleans everything up. */
  private makeRow(
    y: number,
    label: string,
    labelX: number,
    btnX: number,
    rowH: number,
    btnW: number,
    initial: string,
  ): { bg: GameObjects.Rectangle; txt: GameObjects.Text } {
    if (!this.container) {
      throw new Error('GenerateModal.makeRow called before container init');
    }
    const fontBase = { fontFamily: 'Pixeloid Sans, sans-serif' };

    const lbl = this.scene.add
      .text(labelX, y, label, {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '11px',
        color: '#c0a0e6',
      })
      .setOrigin(0, 0.5);
    this.container.add(lbl);

    const bg = this.scene.add
      .rectangle(btnX, y, btnW, rowH - 4, 0x2c1856, 1)
      .setStrokeStyle(1, 0xc678ff, 0.7)
      .setInteractive({ useHandCursor: true });
    const txt = this.scene.add
      .text(btnX, y, initial, {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#ffffff',
      })
      .setOrigin(0.5);
    bg.on('pointerover', () => bg.setFillStyle(0x3d2566, 1));
    bg.on('pointerout', () => bg.setFillStyle(0x2c1856, 1));
    this.container.add([bg, txt]);
    return { bg, txt };
  }
}

function difficultyLabel(d: GenDifficulty): string {
  return d.toUpperCase();
}

function tempoLabel(t: TempoEntry): string {
  return t.speedLabel.toUpperCase();
}

function vibeLabel(v: BackingVibe | undefined): string {
  return v ? v.toUpperCase() : '—';
}
