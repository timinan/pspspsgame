import { Scene, Scenes, GameObjects } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { LANE_COLORS, LANE_GUTTER_PX, LANE_GAP_PX, LANE_COUNT } from '@/constants/scene-layout';
import { TopHud } from '@/ui/top-hud';
import { ChartPlayer } from '@/systems/chart-player';
import { SongPlayer } from '@/systems/song-player';
import { Balance } from '@/constants/balance';
import { saveChart } from '@/services/state-client';
import {
  emptyChart,
  validateChart,
  CHART_PAGE_SIZE,
} from '@/../shared/state';
import type { PlayerState, Chart, LaneId } from '@/../shared/state';

// ─── Layout constants ──────────────────────────────────────────────────────

const BPM_CYCLE = [80, 100, 120, 140, 160] as const;

const CELL_GAP = 4;
// Cell height; width is computed from canvas width at create time.
const CELL_H = 50;

// ─── Scene ─────────────────────────────────────────────────────────────────

/**
 * Phase 5 Task 12 — ChartEditor scene.
 *
 * A 3-lane × 8-step beat editor. Tap cells to toggle notes, press Play to
 * preview with a scan line, cycle BPM, then POST to save and return to Game.
 *
 * All UI lives in a single Container so destroy(true) handles cleanup.
 */
export class ChartEditor extends Scene {
  private playerState: PlayerState | null = null;
  private chart!: Chart;

  // Root container — destroy(true) in shutdown handler tears down everything.
  private root!: GameObjects.Container;
  private hud!: TopHud;

  // Grid — only CHART_PAGE_SIZE rows of cells exist physically; they map
  // to chart.steps[scrollOffset + localStep] so a 32-step chart pages
  // through 4 windows of 8 rows each.
  private cellRects: GameObjects.Rectangle[][] = []; // [localStep][lane]
  private scrollOffset = 0;
  private gridOriginX = 0;
  private gridOriginY = 0;
  private gridW = 0;
  private gridH = 0;

  // Page navigation
  private prevPageBtn: GameObjects.Text | null = null;
  private nextPageBtn: GameObjects.Text | null = null;
  private pageLabel: GameObjects.Text | null = null;

  // Scan line — single pre-created Rectangle, repositioned each frame.
  private scanLine!: GameObjects.Rectangle;
  private scanActive = false;
  private scanElapsedMs = 0;
  private scanTotalMs = 0;
  private scanPlayer: ChartPlayer | null = null;
  // Per-preview SongPlayer — fires pitched meows alongside the visual
  // scan line so the player can hear what they've authored. Recreated
  // on each PLAY so BPM changes take effect on the next preview.
  private previewSongPlayer: SongPlayer | null = null;
  // Flash timeouts for cell highlight during preview (step → timer)
  private flashTimers: Phaser.Time.TimerEvent[] = [];

  // Controls
  private playBtnBg!: GameObjects.Rectangle;
  private playBtnText!: GameObjects.Text;
  private bpmBtnText!: GameObjects.Text;
  private bpmIndex: number = 2; // default 120
  private postBusy = false;

  // Title label (editable via HTML overlay; v1 is read-only text)
  private titleText!: GameObjects.Text;

  constructor() {
    super(SceneKeys.ChartEditor);
  }

  init(data: { playerState?: PlayerState | null }): void {
    this.playerState = data?.playerState ?? null;

    const username = this.playerState?.username ?? 'anon';
    const existing = this.playerState?.chart;
    // Clone so local edits don't mutate the passed-in state object.
    this.chart = existing
      ? JSON.parse(JSON.stringify(existing)) as Chart
      : emptyChart(username, 'My Beat');

    // Sync bpmIndex to loaded chart
    const bpmIdx = BPM_CYCLE.indexOf(this.chart.bpm as (typeof BPM_CYCLE)[number]);
    this.bpmIndex = bpmIdx >= 0 ? bpmIdx : 2;

    // Reset preview state
    this.scanActive = false;
    this.scanElapsedMs = 0;
    this.scanTotalMs = 0;
    this.scanPlayer = null;
    this.postBusy = false;
    this.cellRects = [];
    this.flashTimers = [];
    this.scrollOffset = 0;
  }

  create(): void {
    const { width, height } = this.scale;

    this.root = this.add.container(0, 0).setDepth(0);

    // Dark background
    const bg = this.add.rectangle(0, 0, width, height, 0x0f0820, 1).setOrigin(0, 0);
    this.root.add(bg);

    this.buildHud();
    this.buildSubHeader(width);
    this.buildLanePills(width);
    this.buildPageNav(width);
    this.buildGrid(width);
    this.buildScanLine();
    this.buildControls(width);
    this.buildTitleLabel(width);
    this.buildPostButton(width, height);

    this.events.once(Scenes.Events.SHUTDOWN, () => this.cleanup());
  }

  override update(_time: number, delta: number): void {
    if (!this.scanActive || !this.scanPlayer) return;

    this.scanElapsedMs += delta;
    this.scanPlayer.advance(delta);

    // Compute the play head's current global step + auto-scroll the page
    // so the head stays visible. progress wraps to [0,1) per page so the
    // scan line moves through each window then jumps back to the top.
    const msPerStep = 60000 / (this.chart.bpm * 2);
    const globalProgress = Math.min(this.scanElapsedMs / this.scanTotalMs, 1);
    const globalStepF = globalProgress * this.chart.stepCount;
    const currentPageStart =
      Math.floor(globalStepF / CHART_PAGE_SIZE) * CHART_PAGE_SIZE;
    if (currentPageStart !== this.scrollOffset && currentPageStart < this.chart.stepCount) {
      this.scrollOffset = currentPageStart;
      this.refreshCells();
      this.refreshPageLabel();
    }
    const localStepF = globalStepF - currentPageStart;
    const scanY = this.gridOriginY + (localStepF / CHART_PAGE_SIZE) * this.gridH;
    this.scanLine.setPosition(this.gridOriginX + this.gridW / 2, scanY);

    // Suppress unused-warning for msPerStep — kept because future per-step
    // visuals (beat dot, bar boundary line) will need it.
    void msPerStep;

    if (this.scanPlayer.isFinished()) {
      this.stopPreview();
    }
  }

  // ─── Build helpers ──────────────────────────────────────────────────────

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
        // POST (self) is omitted
        {
          label: 'PURCHASE',
          description: 'Boxes',
          icon: '🛒',
          onTap: () => this.scene.start(SceneKeys.Purchase, { playerState: this.playerState }),
        },
      ],
    });
  }

  private buildSubHeader(width: number): void {
    const y = TopHud.HEIGHT + 18;

    const title = this.add
      .text(width / 2, y, 'STEP SEQUENCER', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '16px',
        color: '#ffd34d',
      })
      .setOrigin(0.5, 0.5);

    const caption = this.add
      .text(width / 2, y + 20, '3 lanes · 8 steps · time flows ↓', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '10px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5, 0.5);

    this.root.add([title, caption]);
  }

  private buildLanePills(width: number): void {
    const pillY = TopHud.HEIGHT + 56;
    const inner = width - LANE_GUTTER_PX * 2;
    const colW = (inner - LANE_GAP_PX * (LANE_COUNT - 1)) / LANE_COUNT;
    const pillH = 18;

    const labels = ['L1', 'L2', 'L3'];
    for (let i = 0; i < LANE_COUNT; i++) {
      const cx = LANE_GUTTER_PX + colW * i + colW / 2 + LANE_GAP_PX * i;
      const color = LANE_COLORS[i]!;

      const pillBg = this.add.rectangle(cx, pillY, colW - 4, pillH, color, 0.25);
      pillBg.setStrokeStyle(1, color, 0.8);

      const pillText = this.add
        .text(cx, pillY, labels[i]!, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '10px',
          color: '#ffffff',
        })
        .setOrigin(0.5, 0.5);

      this.root.add([pillBg, pillText]);
    }
  }

  private buildPageNav(width: number): void {
    const pageY = TopHud.HEIGHT + 78;

    this.prevPageBtn = this.add
      .text(LANE_GUTTER_PX + 20, pageY, '◀', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '16px',
        color: '#ffd34d',
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    this.prevPageBtn.on('pointerdown', () => this.onPrevPage());

    this.pageLabel = this.add
      .text(width / 2, pageY, '', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '11px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);

    this.nextPageBtn = this.add
      .text(width - LANE_GUTTER_PX - 20, pageY, '▶', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '16px',
        color: '#ffd34d',
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    this.nextPageBtn.on('pointerdown', () => this.onNextPage());

    this.root.add([this.prevPageBtn, this.pageLabel, this.nextPageBtn]);
  }

  private buildGrid(width: number): void {
    const gridTop = TopHud.HEIGHT + 96;
    const inner = width - LANE_GUTTER_PX * 2;
    const colW = (inner - LANE_GAP_PX * (LANE_COUNT - 1)) / LANE_COUNT;
    const cellW = colW - 2;

    this.gridOriginX = LANE_GUTTER_PX;
    this.gridOriginY = gridTop;
    this.gridW = inner;
    this.gridH = CHART_PAGE_SIZE * (CELL_H + CELL_GAP) - CELL_GAP;

    // Cells are keyed by LOCAL step index (0…CHART_PAGE_SIZE-1) at fixed
    // y positions. Their model-step meaning shifts when scrollOffset
    // changes — refreshCells() re-reads chart.steps[scrollOffset + i] to
    // repaint the active state.
    for (let localStep = 0; localStep < CHART_PAGE_SIZE; localStep++) {
      this.cellRects[localStep] = [];
      const cy = gridTop + localStep * (CELL_H + CELL_GAP) + CELL_H / 2;

      for (let lane = 0; lane < LANE_COUNT; lane++) {
        const cx = LANE_GUTTER_PX + colW * lane + colW / 2 + LANE_GAP_PX * lane;

        const cell = this.add.rectangle(cx, cy, cellW, CELL_H - 2, 0x1a0a2e, 1);
        cell.setStrokeStyle(1.5, 0x4a2878, 0.9);
        cell.setInteractive({ useHandCursor: true });
        const ls = localStep;
        const l = lane;
        cell.on('pointerdown', () => this.toggleCell(ls, l as LaneId));

        this.cellRects[localStep]![lane] = cell;
        this.root.add(cell);
      }
    }

    this.refreshCells();
    this.refreshPageLabel();
  }

  /** Repaint each visible cell from the chart model at the current scroll
   *  offset. Cheap — 24 cells, no allocation. */
  private refreshCells(): void {
    for (let localStep = 0; localStep < CHART_PAGE_SIZE; localStep++) {
      const modelStep = this.scrollOffset + localStep;
      const chartStep = this.chart.steps[modelStep];
      for (let lane = 0; lane < LANE_COUNT; lane++) {
        const cell = this.cellRects[localStep]![lane]!;
        const isActive = chartStep?.lanes.includes(lane as LaneId) ?? false;
        if (isActive) this.activateCell(cell, LANE_COLORS[lane]!);
        else this.deactivateCell(cell);
      }
    }
  }

  private refreshPageLabel(): void {
    if (!this.pageLabel) return;
    const page = Math.floor(this.scrollOffset / CHART_PAGE_SIZE) + 1;
    const totalPages = Math.max(1, Math.ceil(this.chart.stepCount / CHART_PAGE_SIZE));
    const from = this.scrollOffset + 1;
    const to = Math.min(this.scrollOffset + CHART_PAGE_SIZE, this.chart.stepCount);
    this.pageLabel.setText(`Page ${page}/${totalPages}  ·  steps ${from}–${to}`);
    // Dim disabled arrows so the player can see when they're at the ends.
    if (this.prevPageBtn) this.prevPageBtn.setAlpha(page === 1 ? 0.3 : 1);
    if (this.nextPageBtn) this.nextPageBtn.setAlpha(page === totalPages ? 0.3 : 1);
  }

  private onPrevPage(): void {
    if (this.scrollOffset === 0) return;
    this.scrollOffset = Math.max(0, this.scrollOffset - CHART_PAGE_SIZE);
    this.refreshCells();
    this.refreshPageLabel();
  }

  private onNextPage(): void {
    const maxOffset = this.chart.stepCount - CHART_PAGE_SIZE;
    if (this.scrollOffset >= maxOffset) return;
    this.scrollOffset = Math.min(maxOffset, this.scrollOffset + CHART_PAGE_SIZE);
    this.refreshCells();
    this.refreshPageLabel();
  }

  private activateCell(cell: GameObjects.Rectangle, color: number): void {
    cell.setFillStyle(color, 0.8);
    cell.setStrokeStyle(2, color, 1);
  }

  private deactivateCell(cell: GameObjects.Rectangle): void {
    cell.setFillStyle(0x1a0a2e, 1);
    cell.setStrokeStyle(1.5, 0x4a2878, 0.9);
  }

  private flashCell(cell: GameObjects.Rectangle, color: number): void {
    cell.setFillStyle(0xffffff, 0.95);
    const t = this.time.delayedCall(80, () => {
      // Re-check active state after flash. The cell's row/column tells us
      // its LOCAL position; the model step is scrollOffset + localStep.
      const localStep = this.cellRects.findIndex((row) => row && row.includes(cell));
      const lane = localStep >= 0 ? this.cellRects[localStep]!.indexOf(cell) : -1;
      if (localStep >= 0 && lane >= 0) {
        const modelStep = this.scrollOffset + localStep;
        const active = this.chart.steps[modelStep]?.lanes.includes(lane as LaneId) ?? false;
        if (active) this.activateCell(cell, color);
        else this.deactivateCell(cell);
      }
    });
    this.flashTimers.push(t);
  }

  private buildScanLine(): void {
    // Single pre-created Rectangle. Repositioned in update(). No per-frame allocation.
    this.scanLine = this.add.rectangle(
      this.gridOriginX + this.gridW / 2,
      this.gridOriginY,
      this.gridW,
      2,
      0xffd34d,
      1,
    );
    this.scanLine.setVisible(false);
    this.scanLine.setDepth(10);
    this.root.add(this.scanLine);
  }

  private buildControls(width: number): void {
    const controlsY = this.gridOriginY + this.gridH + 24;
    const btnH = 36;
    const btnW = (width - LANE_GUTTER_PX * 2 - CELL_GAP * 2) / 3;
    const startX = LANE_GUTTER_PX + btnW / 2;

    // ▶ PLAY
    this.playBtnBg = this.add
      .rectangle(startX, controlsY, btnW, btnH, 0x2e7d32, 1)
      .setInteractive({ useHandCursor: true });
    this.playBtnText = this.add
      .text(startX, controlsY, '▶ PLAY', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '11px',
        color: '#ffffff',
      })
      .setOrigin(0.5);

    this.playBtnBg.on('pointerdown', () => this.onPlayTap());
    this.root.add([this.playBtnBg, this.playBtnText]);

    // CLEAR
    const clearX = startX + btnW + CELL_GAP;
    const clearBg = this.add
      .rectangle(clearX, controlsY, btnW, btnH, 0x2c1856, 1)
      .setStrokeStyle(1, 0xc678ff, 0.7)
      .setInteractive({ useHandCursor: true });
    const clearText = this.add
      .text(clearX, controlsY, 'CLEAR', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '11px',
        color: '#c678ff',
      })
      .setOrigin(0.5);

    clearBg.on('pointerdown', () => this.onClearTap());
    this.root.add([clearBg, clearText]);

    // BPM CYCLE
    const bpmX = clearX + btnW + CELL_GAP;
    const bpmBg = this.add
      .rectangle(bpmX, controlsY, btnW, btnH, 0x2c1856, 1)
      .setStrokeStyle(1, 0xc678ff, 0.7)
      .setInteractive({ useHandCursor: true });
    this.bpmBtnText = this.add
      .text(bpmX, controlsY, `BPM ${BPM_CYCLE[this.bpmIndex]}`, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '11px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);

    bpmBg.on('pointerdown', () => this.onBpmTap());
    this.root.add([bpmBg, this.bpmBtnText]);
  }

  private buildTitleLabel(width: number): void {
    const controlsY = this.gridOriginY + this.gridH + 24;
    const titleY = controlsY + 28 + 16;

    // v1: read-only label. HTML overlay input deferred to follow-up.
    this.titleText = this.add
      .text(width / 2, titleY, `TITLE: ${this.chart.title}`, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '11px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5, 0.5);

    this.root.add(this.titleText);
  }

  private buildPostButton(width: number, _height: number): void {
    const controlsY = this.gridOriginY + this.gridH + 24;
    const titleY = controlsY + 28 + 16;
    const postY = titleY + 28;
    const postW = width - LANE_GUTTER_PX * 2;
    const postH = 42;

    const postBg = this.add
      .rectangle(width / 2, postY, postW, postH, 0xffd34d, 1)
      .setInteractive({ useHandCursor: true });
    const postText = this.add
      .text(width / 2, postY, 'POST BEAT', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '13px',
        color: '#1a0a2e',
      })
      .setOrigin(0.5);

    postBg.on('pointerdown', () => void this.onPostTap());
    this.root.add([postBg, postText]);
  }

  // ─── Interactions ───────────────────────────────────────────────────────

  private toggleCell(localStep: number, lane: LaneId): void {
    const modelStep = this.scrollOffset + localStep;
    const chartStep = this.chart.steps[modelStep];
    if (!chartStep) return;
    const idx = chartStep.lanes.indexOf(lane);
    const cell = this.cellRects[localStep]![lane]!;
    const color = LANE_COLORS[lane]!;

    if (idx >= 0) {
      chartStep.lanes.splice(idx, 1);
      this.deactivateCell(cell);
    } else {
      chartStep.lanes.push(lane);
      this.activateCell(cell, color);
    }

    // Small scale bounce for tactile feel.
    this.tweens.add({
      targets: cell,
      scaleX: 0.92,
      scaleY: 0.92,
      duration: 60,
      yoyo: true,
    });
  }

  private onPlayTap(): void {
    if (this.scanActive) {
      this.stopPreview();
      return;
    }
    this.startPreview();
  }

  private startPreview(): void {
    // msPerStep is the same formula ChartPlayer uses.
    const msPerStep = 60000 / (this.chart.bpm * 2);
    this.scanTotalMs = msPerStep * this.chart.stepCount;
    this.scanElapsedMs = 0;

    this.scanPlayer = new ChartPlayer(this.chart, { loopCount: 1, noteFallMs: 0 });
    this.scanPlayer.onSpawn((lane) => {
      // Flash cells that fire at the current play-head step. Only the
      // visible window's local cell exists; if the step is on a different
      // page, the auto-scroll in update() will catch up next frame.
      const approxStep = Math.round(this.scanElapsedMs / msPerStep);
      const modelStep = Math.max(0, Math.min(this.chart.stepCount - 1, approxStep));
      const localStep = modelStep - this.scrollOffset;
      if (localStep < 0 || localStep >= CHART_PAGE_SIZE) return;
      const cell = this.cellRects[localStep]?.[lane];
      if (cell) this.flashCell(cell, LANE_COLORS[lane]!);
    });

    this.scanLine.setPosition(this.gridOriginX + this.gridW / 2, this.gridOriginY);
    this.scanLine.setVisible(true);
    this.scanActive = true;

    this.playBtnBg.setFillStyle(0xb71c1c, 1);
    this.playBtnText.setText('■ STOP');

    // Audio preview: fire pitched meows on every active step so the
    // player hears their chart as they author it. Recreated each PLAY
    // so BPM changes between previews are picked up. First PLAY tap
    // is itself a user gesture so unlock() can resolve immediately.
    if (Balance.audioEnabled) {
      this.previewSongPlayer?.destroy();
      try {
        // Same real-meow sampler as Game. Skip the backing track here so
        // the author hears the meow placement clearly while building.
        this.previewSongPlayer = new SongPlayer({
          chart: this.chart,
          meowSamples: { C4: 'assets/audio/meows/meow.wav' },
        });
        void this.previewSongPlayer.unlock().then(() => this.previewSongPlayer?.start());
      } catch (err) {
        console.warn('[ChartEditor] preview SongPlayer init failed:', err);
        this.previewSongPlayer = null;
      }
    }
  }

  private stopPreview(): void {
    this.scanActive = false;
    this.scanPlayer = null;
    this.scanLine.setVisible(false);
    this.playBtnBg.setFillStyle(0x2e7d32, 1);
    this.playBtnText.setText('▶ PLAY');
    this.previewSongPlayer?.destroy();
    this.previewSongPlayer = null;
  }

  private onClearTap(): void {
    this.stopPreview();
    for (let step = 0; step < this.chart.stepCount; step++) {
      this.chart.steps[step]!.lanes = [];
    }
    this.refreshCells();
  }

  private onBpmTap(): void {
    this.bpmIndex = (this.bpmIndex + 1) % BPM_CYCLE.length;
    const bpm = BPM_CYCLE[this.bpmIndex]!;
    this.chart.bpm = bpm;
    this.bpmBtnText.setText(`BPM ${bpm}`);
    // If preview is running, restart so timing is correct.
    if (this.scanActive) {
      this.stopPreview();
      this.startPreview();
    }
  }

  private async onPostTap(): Promise<void> {
    if (this.postBusy) return;
    this.stopPreview();

    const result = validateChart(this.chart);
    if (!result.ok) {
      console.warn('[ChartEditor] validateChart failed:', result.reason);
      // Show a brief visual feedback: flash the POST button red.
      this.tweens.add({
        targets: this.root.list.filter(
          (o) => o instanceof GameObjects.Rectangle && (o as GameObjects.Rectangle).fillColor === 0xffd34d,
        ),
        alpha: 0.4,
        duration: 100,
        yoyo: true,
      });
      return;
    }

    this.postBusy = true;
    this.chart.updatedAt = Date.now();

    try {
      await saveChart(this.chart);
      console.info('[ChartEditor] chart saved, routing to Game');
    } catch (err) {
      console.warn('[ChartEditor] saveChart failed:', err);
      // Continue routing anyway — don't trap the user.
    }

    this.scene.start(SceneKeys.Game, { playerState: this.playerState });
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────

  private cleanup(): void {
    // Cancel all flash timers.
    for (const t of this.flashTimers) t.destroy();
    this.flashTimers = [];

    this.previewSongPlayer?.destroy();
    this.previewSongPlayer = null;

    this.tweens.killAll();
    this.time.removeAllEvents();
    this.input.removeAllListeners();
    this.input.keyboard?.removeAllListeners();
    this.scale.off('resize');

    this.hud.destroy();
    this.scanLine.destroy();
    this.root.destroy(true);
  }
}
