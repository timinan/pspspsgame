import { Scene, Scenes, GameObjects } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { LANE_COLORS, LANE_GUTTER_PX, LANE_GAP_PX, LANE_COUNT } from '@/constants/scene-layout';
import { TopHud } from '@/ui/top-hud';
import { ChartPlayer } from '@/systems/chart-player';
import { saveChart } from '@/services/state-client';
import { emptyChart, validateChart } from '@/../shared/state';
import type { PlayerState, Chart, LaneId } from '@/../shared/state';

// ─── Layout constants ──────────────────────────────────────────────────────

const BPM_CYCLE = [80, 100, 120, 140, 160] as const;

const STEP_COUNT = 8;
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

  // Grid
  private cellRects: GameObjects.Rectangle[][] = []; // [step][lane]
  private gridOriginX = 0;
  private gridOriginY = 0;
  private gridW = 0;
  private gridH = 0;

  // Scan line — single pre-created Rectangle, repositioned each frame.
  private scanLine!: GameObjects.Rectangle;
  private scanActive = false;
  private scanElapsedMs = 0;
  private scanTotalMs = 0;
  private scanPlayer: ChartPlayer | null = null;
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

    // Reposition scan line — no allocation, just number math.
    const progress = Math.min(this.scanElapsedMs / this.scanTotalMs, 1);
    const scanY = this.gridOriginY + progress * this.gridH;
    this.scanLine.setPosition(this.gridOriginX + this.gridW / 2, scanY);

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

  private buildGrid(width: number): void {
    const gridTop = TopHud.HEIGHT + 80;
    const inner = width - LANE_GUTTER_PX * 2;
    const colW = (inner - LANE_GAP_PX * (LANE_COUNT - 1)) / LANE_COUNT;
    const cellW = colW - 2;

    this.gridOriginX = LANE_GUTTER_PX;
    this.gridOriginY = gridTop;
    this.gridW = inner;
    this.gridH = STEP_COUNT * (CELL_H + CELL_GAP) - CELL_GAP;

    for (let step = 0; step < STEP_COUNT; step++) {
      this.cellRects[step] = [];
      const cy = gridTop + step * (CELL_H + CELL_GAP) + CELL_H / 2;

      for (let lane = 0; lane < LANE_COUNT; lane++) {
        const laneId = lane as LaneId;
        const cx = LANE_GUTTER_PX + colW * lane + colW / 2 + LANE_GAP_PX * lane;
        const color = LANE_COLORS[lane]!;
        const isActive = this.chart.steps[step]!.lanes.includes(laneId);

        const cell = this.add.rectangle(cx, cy, cellW, CELL_H - 2, 0x1a0a2e, 1);
        cell.setStrokeStyle(1.5, 0x4a2878, 0.9);

        if (isActive) this.activateCell(cell, color);

        cell.setInteractive({ useHandCursor: true });
        // Capture step/lane by value for the closure.
        const s = step;
        const l = lane;
        cell.on('pointerdown', () => this.toggleCell(s, l as LaneId));

        this.cellRects[step]![lane] = cell;
        this.root.add(cell);
      }
    }
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
      // Re-check active state after flash.
      const step = this.cellRects.findIndex((row) => row && row.includes(cell));
      const lane = step >= 0 ? this.cellRects[step]!.indexOf(cell) : -1;
      if (step >= 0 && lane >= 0) {
        const active = this.chart.steps[step]!.lanes.includes(lane as LaneId);
        if (active) {
          this.activateCell(cell, color);
        } else {
          this.deactivateCell(cell);
        }
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

  private toggleCell(step: number, lane: LaneId): void {
    const chartStep = this.chart.steps[step]!;
    const idx = chartStep.lanes.indexOf(lane);
    const cell = this.cellRects[step]![lane]!;
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
    this.scanTotalMs = msPerStep * STEP_COUNT;
    this.scanElapsedMs = 0;

    this.scanPlayer = new ChartPlayer(this.chart, { loopCount: 1, noteFallMs: 0 });
    this.scanPlayer.onSpawn((lane) => {
      // Flash cells that fire at the current play-head step.
      const approxStep = Math.round(this.scanElapsedMs / msPerStep);
      const clampedStep = Math.max(0, Math.min(STEP_COUNT - 1, approxStep));
      const cell = this.cellRects[clampedStep]?.[lane];
      if (cell) this.flashCell(cell, LANE_COLORS[lane]!);
    });

    this.scanLine.setPosition(this.gridOriginX + this.gridW / 2, this.gridOriginY);
    this.scanLine.setVisible(true);
    this.scanActive = true;

    this.playBtnBg.setFillStyle(0xb71c1c, 1);
    this.playBtnText.setText('■ STOP');
  }

  private stopPreview(): void {
    this.scanActive = false;
    this.scanPlayer = null;
    this.scanLine.setVisible(false);
    this.playBtnBg.setFillStyle(0x2e7d32, 1);
    this.playBtnText.setText('▶ PLAY');
  }

  private onClearTap(): void {
    this.stopPreview();
    for (let step = 0; step < STEP_COUNT; step++) {
      this.chart.steps[step]!.lanes = [];
      for (let lane = 0; lane < LANE_COUNT; lane++) {
        const cell = this.cellRects[step]![lane]!;
        this.deactivateCell(cell);
      }
    }
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
