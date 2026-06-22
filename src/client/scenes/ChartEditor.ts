import { Scene, Scenes, GameObjects } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { TopHud } from '@/ui/top-hud';
import { BackgroundManager } from '@/entities/background-manager';
import * as L from '@/constants/scene-layout';
import { AssetKeys } from '@/constants/assets';
import { saveChart } from '@/services/state-client';
import {
  emptyChart,
  validateChart,
  CHART_PAGE_SIZE,
} from '@/../shared/state';
import type { PlayerState, Chart, LaneId } from '@/../shared/state';

const BPM_CYCLE = [80, 100, 120, 140, 160] as const;

/**
 * Chart editor — 3-lane × 32-step beat sequencer paged in 8-row windows.
 *
 * Visual approach (from Mock B): real game backdrop behind the grid,
 * lane columns washed with the same RhythmBarBackground tint Game uses,
 * active cells render the actual PspspsElementBall + letters sprite. No
 * seated cats — they aren't the focus of authoring.
 *
 * Flow: edit grid → tap PLAY → chart is saved + Game scene boots in
 * test mode → Game's Ready modal asks "Ready to test?" with a
 * "← BACK TO EDITOR" escape hatch.
 */
export class ChartEditor extends Scene {
  private playerState: PlayerState | null = null;
  private chart!: Chart;

  private root!: GameObjects.Container;
  private hud!: TopHud;
  private bg!: BackgroundManager;

  // Grid geometry
  private gridTop = 0;
  private gridBottom = 0;
  private cellH = 0;
  private cellW = 0;
  private colCenterXs: number[] = [];

  // Cells
  private cellPanels: GameObjects.Rectangle[][] = []; // [localStep][lane]
  private cellNotes: GameObjects.Container[][] = [];  // [localStep][lane]

  // Page nav
  private scrollOffset = 0;
  private upPageBtn!: GameObjects.Text;
  private downPageBtn!: GameObjects.Text;
  private pageLabel!: GameObjects.Text;

  // Bottom controls
  private bpmBtnText!: GameObjects.Text;
  private bpmIndex = 2; // default 120bpm
  private playBusy = false;

  constructor() {
    super(SceneKeys.ChartEditor);
  }

  init(data: { playerState?: PlayerState | null }): void {
    this.playerState = data?.playerState ?? null;

    const username = this.playerState?.username ?? 'anon';
    const existing = this.playerState?.chart;
    this.chart = existing
      ? (JSON.parse(JSON.stringify(existing)) as Chart)
      : emptyChart(username, 'My Beat');

    const bpmIdx = BPM_CYCLE.indexOf(this.chart.bpm as (typeof BPM_CYCLE)[number]);
    this.bpmIndex = bpmIdx >= 0 ? bpmIdx : 2;

    this.cellPanels = [];
    this.cellNotes = [];
    this.scrollOffset = 0;
    this.playBusy = false;
    this.colCenterXs = [];
  }

  create(): void {
    this.root = this.add.container(0, 0).setDepth(0);

    this.bg = new BackgroundManager(this);
    this.bg.create();
    const activeBg = this.playerState?.activeBackground ?? 'stage';
    this.bg.setBackground(activeBg);

    this.computeGrid();
    this.drawColumnWashes();
    this.buildHud();
    this.buildPageNav();
    this.buildGrid();
    this.buildBottomBar();

    this.events.once(Scenes.Events.SHUTDOWN, () => this.cleanup());
  }

  // ─── Layout ─────────────────────────────────────────────────────────────

  private computeGrid(): void {
    const { width, height } = this.scale;
    // Reserve HUD strip up top, a compact page-nav row, and the bottom
    // controls strip. Everything else is the grid — no cats row eating
    // space.
    const topReserved = TopHud.HEIGHT + 36; // HUD + page nav
    const bottomReserved = 88;              // controls strip + breathing room
    this.gridTop = topReserved;
    this.gridBottom = height - bottomReserved;
    this.cellH = (this.gridBottom - this.gridTop) / CHART_PAGE_SIZE;
    this.cellW = width / L.LANE_COUNT;
    for (let i = 0; i < L.LANE_COUNT; i++) {
      this.colCenterXs[i] = L.laneCenterX(i as 0 | 1 | 2, width);
    }
  }

  private drawColumnWashes(): void {
    const colW = this.cellW;
    const colH = this.gridBottom - this.gridTop;
    for (let i = 0; i < L.LANE_COUNT; i++) {
      const cx = this.colCenterXs[i]!;
      const cy = this.gridTop + colH / 2;
      const color = L.LANE_COLORS[i]!;
      const bar = this.add.image(cx, cy, AssetKeys.Image.RhythmBarBackground);
      bar.displayWidth = colH;
      bar.displayHeight = colW - 2;
      bar.setRotation(-Math.PI / 2);
      bar.setTint(color);
      bar.setAlpha(0.55);
      this.root.add(bar);
    }
  }

  private buildHud(): void {
    this.hud = new TopHud(this, {
      showStats: false,
      items: [
        {
          label: 'PLAY',
          description: "This post's beat",
          icon: '🎵',
          onTap: () => this.scene.start(SceneKeys.Game, { playerState: this.playerState }),
        },
        {
          label: 'DECORATE',
          description: 'Cats & background',
          icon: '😺',
          onTap: () => this.scene.start(SceneKeys.Decorate, { playerState: this.playerState }),
        },
        {
          label: 'PURCHASE',
          description: 'Boxes',
          icon: '🛒',
          onTap: () => this.scene.start(SceneKeys.Purchase, { playerState: this.playerState }),
        },
      ],
    });
  }

  private buildPageNav(): void {
    const navY = TopHud.HEIGHT + 18;
    const w = this.scale.width;
    const cx = w / 2;

    this.upPageBtn = this.add
      .text(cx - 64, navY, '▲', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '20px',
        color: '#ffd34d',
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    this.upPageBtn.on('pointerdown', () => this.onPrevPage());

    this.pageLabel = this.add
      .text(cx, navY, '', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#ffffff',
      })
      .setOrigin(0.5);

    this.downPageBtn = this.add
      .text(cx + 64, navY, '▼', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '20px',
        color: '#ffd34d',
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    this.downPageBtn.on('pointerdown', () => this.onNextPage());

    this.root.add([this.upPageBtn, this.pageLabel, this.downPageBtn]);
    this.refreshPageLabel();
  }

  private buildGrid(): void {
    for (let localStep = 0; localStep < CHART_PAGE_SIZE; localStep++) {
      this.cellPanels[localStep] = [];
      this.cellNotes[localStep] = [];
      const cy = this.gridTop + localStep * this.cellH + this.cellH / 2;

      for (let lane = 0; lane < L.LANE_COUNT; lane++) {
        const cx = this.colCenterXs[lane]!;

        const panel = this.add
          .rectangle(cx, cy, this.cellW - 6, this.cellH - 4, 0x0b041a, 0.35)
          .setStrokeStyle(1, 0xffffff, 0.12)
          .setInteractive({ useHandCursor: true });
        const ls = localStep;
        const ln = lane;
        panel.on('pointerdown', () => this.toggleCell(ls, ln as LaneId));
        this.cellPanels[localStep]![lane] = panel;
        this.root.add(panel);

        const noteSize = Math.min(this.cellW - 18, this.cellH - 12, 64);
        const noteContainer = this.add.container(cx, cy);
        const ball = this.add.image(0, 0, AssetKeys.Image.PspspsElementBall);
        ball.setDisplaySize(noteSize, noteSize);
        ball.setTint(L.LANE_COLORS[lane]!);
        const letters = this.add.image(0, 0, AssetKeys.Image.PspspsElementLetters);
        letters.setDisplaySize(noteSize, noteSize);
        noteContainer.add([ball, letters]);
        noteContainer.setDepth(40);
        noteContainer.setVisible(false);
        this.cellNotes[localStep]![lane] = noteContainer;
        this.root.add(noteContainer);
      }
    }
    this.refreshPage();
  }

  private buildBottomBar(): void {
    const { width, height } = this.scale;
    const stripH = 72;
    const stripY = height - stripH;
    const strip = this.add
      .rectangle(0, stripY, width, stripH, 0x0b041a, 0.78)
      .setOrigin(0, 0);
    this.root.add(strip);

    const barCenterY = stripY + stripH / 2;
    const btnH = 40;

    // Three buttons across the bottom: CLEAR / BPM / PLAY. PLAY is the
    // primary action — saves the chart and routes to Game in test mode.
    const sideMargin = 12;
    const gap = 8;
    const btnW = (width - sideMargin * 2 - gap * 2) / 3;
    const startX = sideMargin + btnW / 2;

    // CLEAR
    const clearBg = this.add
      .rectangle(startX, barCenterY, btnW, btnH, 0x2c1856, 1)
      .setStrokeStyle(1, 0xc678ff, 0.7)
      .setInteractive({ useHandCursor: true });
    const clearText = this.add
      .text(startX, barCenterY, 'CLEAR', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '13px',
        color: '#c678ff',
      })
      .setOrigin(0.5);
    clearBg.on('pointerdown', () => this.onClearTap());
    this.root.add([clearBg, clearText]);

    // BPM cycle
    const bpmX = startX + btnW + gap;
    const bpmBg = this.add
      .rectangle(bpmX, barCenterY, btnW, btnH, 0x2c1856, 1)
      .setStrokeStyle(1, 0xc678ff, 0.7)
      .setInteractive({ useHandCursor: true });
    this.bpmBtnText = this.add
      .text(bpmX, barCenterY, `BPM ${BPM_CYCLE[this.bpmIndex]}`, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);
    bpmBg.on('pointerdown', () => this.onBpmTap());
    this.root.add([bpmBg, this.bpmBtnText]);

    // PLAY — the primary action. Big, yellow, leads into Game test mode.
    const playX = bpmX + btnW + gap;
    const playBg = this.add
      .rectangle(playX, barCenterY, btnW, btnH, 0xffd34d, 1)
      .setInteractive({ useHandCursor: true });
    const playText = this.add
      .text(playX, barCenterY, '▶ PLAY', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '14px',
        color: '#1a0a2e',
      })
      .setOrigin(0.5);
    playBg.on('pointerdown', () => void this.onPlayTap());
    this.root.add([playBg, playText]);
  }

  // ─── Interactions ───────────────────────────────────────────────────────

  private toggleCell(localStep: number, lane: LaneId): void {
    const modelStep = this.scrollOffset + localStep;
    const step = this.chart.steps[modelStep];
    if (!step) return;
    const idx = step.lanes.indexOf(lane);
    const note = this.cellNotes[localStep]![lane]!;
    if (idx >= 0) {
      step.lanes.splice(idx, 1);
      note.setVisible(false);
    } else {
      step.lanes.push(lane);
      note.setVisible(true);
      this.tweens.add({
        targets: note,
        scale: { from: 0.6, to: 1 },
        duration: 120,
        ease: 'Back.easeOut',
      });
    }
  }

  private refreshPage(): void {
    for (let localStep = 0; localStep < CHART_PAGE_SIZE; localStep++) {
      const modelStep = this.scrollOffset + localStep;
      const step = this.chart.steps[modelStep];
      for (let lane = 0; lane < L.LANE_COUNT; lane++) {
        const note = this.cellNotes[localStep]![lane]!;
        const active = step?.lanes.includes(lane as LaneId) ?? false;
        note.setVisible(active);
        note.setScale(1);
      }
    }
    this.refreshPageLabel();
  }

  private refreshPageLabel(): void {
    const page = Math.floor(this.scrollOffset / CHART_PAGE_SIZE) + 1;
    const totalPages = Math.max(1, Math.ceil(this.chart.stepCount / CHART_PAGE_SIZE));
    this.pageLabel.setText(`PAGE ${page} / ${totalPages}`);
    this.upPageBtn.setAlpha(page === 1 ? 0.3 : 1);
    this.downPageBtn.setAlpha(page === totalPages ? 0.3 : 1);
  }

  private onPrevPage(): void {
    if (this.scrollOffset === 0) return;
    this.scrollOffset = Math.max(0, this.scrollOffset - CHART_PAGE_SIZE);
    this.refreshPage();
  }

  private onNextPage(): void {
    const maxOffset = this.chart.stepCount - CHART_PAGE_SIZE;
    if (this.scrollOffset >= maxOffset) return;
    this.scrollOffset = Math.min(maxOffset, this.scrollOffset + CHART_PAGE_SIZE);
    this.refreshPage();
  }

  private onClearTap(): void {
    for (const step of this.chart.steps) step.lanes = [];
    this.refreshPage();
  }

  private onBpmTap(): void {
    this.bpmIndex = (this.bpmIndex + 1) % BPM_CYCLE.length;
    const bpm = BPM_CYCLE[this.bpmIndex]!;
    this.chart.bpm = bpm;
    this.bpmBtnText.setText(`BPM ${bpm}`);
  }

  private async onPlayTap(): Promise<void> {
    if (this.playBusy) return;
    const result = validateChart(this.chart);
    if (!result.ok) {
      console.warn('[ChartEditor] validateChart failed:', result.reason);
      return;
    }
    this.playBusy = true;
    this.chart.updatedAt = Date.now();
    try {
      await saveChart(this.chart);
    } catch (err) {
      console.warn('[ChartEditor] saveChart failed, routing anyway:', err);
    }
    // Game.initChartPlayer reads playerState.chart first — mutate so the
    // round actually picks up the freshly-edited beat instead of whatever
    // chart was on the state object when this scene started.
    if (this.playerState) {
      this.playerState.chart = this.chart;
    }
    this.scene.start(SceneKeys.Game, {
      playerState: this.playerState,
      testMode: true,
    });
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────

  private cleanup(): void {
    this.tweens.killAll();
    this.time.removeAllEvents();
    this.input.removeAllListeners();
    this.input.keyboard?.removeAllListeners();
    this.scale.off('resize');
    this.hud.destroy();
    this.bg.destroy();
    this.root.destroy(true);
  }
}
