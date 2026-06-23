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
  BACKING_CATALOG,
} from '@/../shared/state';
import type { PlayerState, Chart, LaneId, BackingVibe } from '@/../shared/state';

interface TempoEntry {
  speedLabel: string;
  bpm: number;
}

/** Derive the tempo cycle from BACKING_CATALOG so the editor only
 *  offers BPMs we actually have music for. One entry per unique
 *  speedLabel, sorted by BPM. Picks the lowest-BPM backing per label
 *  if multiple share a label. */
function buildTempoCycle(): TempoEntry[] {
  const byLabel = new Map<string, TempoEntry>();
  for (const backing of Object.values(BACKING_CATALOG)) {
    const existing = byLabel.get(backing.speedLabel);
    if (!existing || backing.bpm < existing.bpm) {
      byLabel.set(backing.speedLabel, {
        speedLabel: backing.speedLabel,
        bpm: backing.bpm,
      });
    }
  }
  return [...byLabel.values()].sort((a, b) => a.bpm - b.bpm);
}

const VIBE_DISPLAY_ORDER: BackingVibe[] = ['upbeat', 'melodic', 'smooth'];

/** Vibes available at a given BPM. Player's vibe picker only shows
 *  options that actually have at least one backing at the current
 *  tempo so an empty pick is impossible. */
function buildVibeCycle(bpm: number): BackingVibe[] {
  const set = new Set<BackingVibe>();
  for (const backing of Object.values(BACKING_CATALOG)) {
    if (backing.bpm === bpm) set.add(backing.vibe);
  }
  return VIBE_DISPLAY_ORDER.filter((v) => set.has(v));
}

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

  // Page nav (sits right above the bottom controls strip)
  private scrollOffset = 0;
  private upPageBtn!: GameObjects.Text;
  private downPageBtn!: GameObjects.Text;
  private pageLabel!: GameObjects.Text;
  private addPageBtn!: GameObjects.Rectangle;
  private addPageBtnText!: GameObjects.Text;

  // Bottom controls
  private bpmBtnText!: GameObjects.Text;
  private tempoCycle: TempoEntry[] = [];
  private tempoIndex = 0;
  private vibeBtnText!: GameObjects.Text;
  private vibeCycle: BackingVibe[] = [];
  private vibeIndex = 0;
  private saveBusy = false;
  private saveBtnBg!: GameObjects.Rectangle;
  private saveBtnText!: GameObjects.Text;

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

    // Build the tempo cycle from whatever backings are in the catalog.
    // Snap chart.bpm to the closest available tempo so a chart authored
    // before a backing was added still has a valid playable tempo.
    this.tempoCycle = buildTempoCycle();
    if (this.tempoCycle.length > 0) {
      let nearestIdx = 0;
      let nearestDist = Math.abs(this.chart.bpm - this.tempoCycle[0]!.bpm);
      for (let i = 1; i < this.tempoCycle.length; i++) {
        const d = Math.abs(this.chart.bpm - this.tempoCycle[i]!.bpm);
        if (d < nearestDist) {
          nearestDist = d;
          nearestIdx = i;
        }
      }
      this.tempoIndex = nearestIdx;
      this.chart.bpm = this.tempoCycle[nearestIdx]!.bpm;
    }

    // Vibe cycle depends on the current tempo — only vibes with at
    // least one backing at this tempo are pickable. If the chart's
    // saved vibe is no longer available (catalog churn), snap to the
    // first option.
    this.vibeCycle = buildVibeCycle(this.chart.bpm);
    if (this.vibeCycle.length > 0) {
      const saved = this.chart.vibe;
      const matchIdx = saved ? this.vibeCycle.indexOf(saved) : -1;
      this.vibeIndex = matchIdx >= 0 ? matchIdx : 0;
      this.chart.vibe = this.vibeCycle[this.vibeIndex]!;
    }

    this.cellPanels = [];
    this.cellNotes = [];
    this.scrollOffset = 0;
    this.saveBusy = false;
    this.colCenterXs = [];
  }

  /** Max chart length, in pages. Lift if 32+ pages becomes a real need. */
  private static readonly MAX_PAGES = 16;

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
    // HUD up top; bottom carved into page-nav row + controls strip + a
    // bit of breathing room. Grid takes everything else.
    const topReserved = TopHud.HEIGHT + 8;
    const bottomReserved = PAGE_NAV_ROW_H + BOTTOM_STRIP_H + 8;
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
    const { width, height } = this.scale;
    // Page-nav row sits directly above the bottom controls strip.
    const navY = height - BOTTOM_STRIP_H - PAGE_NAV_ROW_H / 2;

    // ▲ on the left, PAGE label + ▼ clustered to the right of it. Leaves
    // the right edge for the + ADD PAGE button so navigate-vs-modify
    // stay visually separated.
    const leftCluster = 12;
    this.upPageBtn = this.add
      .text(leftCluster + 14, navY, '▲', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '20px',
        color: '#ffd34d',
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    this.upPageBtn.on('pointerdown', () => this.onPrevPage());

    this.pageLabel = this.add
      .text(leftCluster + 80, navY, '', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#ffffff',
      })
      .setOrigin(0.5);

    this.downPageBtn = this.add
      .text(leftCluster + 144, navY, '▼', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '20px',
        color: '#ffd34d',
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    this.downPageBtn.on('pointerdown', () => this.onNextPage());

    // + ADD PAGE — grows the chart by another 8-step page (capped at
    // MAX_PAGES so the timeline doesn't blow up to thousands of steps).
    const addW = 96;
    const addH = 28;
    const addX = width - 12 - addW / 2;
    this.addPageBtn = this.add
      .rectangle(addX, navY, addW, addH, 0x2c1856, 1)
      .setStrokeStyle(1, 0x4dffb4, 0.7)
      .setInteractive({ useHandCursor: true });
    this.addPageBtnText = this.add
      .text(addX, navY, '+ ADD PAGE', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '11px',
        color: '#4dffb4',
      })
      .setOrigin(0.5);
    this.addPageBtn.on('pointerdown', () => this.onAddPage());

    this.root.add([
      this.upPageBtn,
      this.pageLabel,
      this.downPageBtn,
      this.addPageBtn,
      this.addPageBtnText,
    ]);
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
    const stripY = height - BOTTOM_STRIP_H;
    const strip = this.add
      .rectangle(0, stripY, width, BOTTOM_STRIP_H, 0x0b041a, 0.78)
      .setOrigin(0, 0);
    this.root.add(strip);

    const barCenterY = stripY + BOTTOM_STRIP_H / 2;
    const btnH = 40;

    // Four buttons across the bottom: CLEAR / TEMPO / VIBE / SAVE.
    // SAVE is the primary action — persists the chart in place. Play
    // happens from the hamburger drawer.
    const sideMargin = 10;
    const gap = 6;
    const btnW = (width - sideMargin * 2 - gap * 3) / 4;
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
        fontSize: '12px',
        color: '#c678ff',
      })
      .setOrigin(0.5);
    clearBg.on('pointerdown', () => this.onClearTap());
    this.root.add([clearBg, clearText]);

    // TEMPO cycle
    const bpmX = startX + btnW + gap;
    const bpmBg = this.add
      .rectangle(bpmX, barCenterY, btnW, btnH, 0x2c1856, 1)
      .setStrokeStyle(1, 0xc678ff, 0.7)
      .setInteractive({ useHandCursor: true });
    this.bpmBtnText = this.add
      .text(bpmX, barCenterY, this.tempoButtonLabel(), {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '11px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);
    bpmBg.on('pointerdown', () => this.onBpmTap());
    this.root.add([bpmBg, this.bpmBtnText]);

    // VIBE cycle
    const vibeX = bpmX + btnW + gap;
    const vibeBg = this.add
      .rectangle(vibeX, barCenterY, btnW, btnH, 0x2c1856, 1)
      .setStrokeStyle(1, 0xc678ff, 0.7)
      .setInteractive({ useHandCursor: true });
    this.vibeBtnText = this.add
      .text(vibeX, barCenterY, this.vibeButtonLabel(), {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '11px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);
    vibeBg.on('pointerdown', () => this.onVibeTap());
    this.root.add([vibeBg, this.vibeBtnText]);

    // SAVE — primary action. Big yellow button. Flashes green on success
    // so the player gets unambiguous confirmation without a modal.
    const saveX = vibeX + btnW + gap;
    this.saveBtnBg = this.add
      .rectangle(saveX, barCenterY, btnW, btnH, 0xffd34d, 1)
      .setInteractive({ useHandCursor: true });
    this.saveBtnText = this.add
      .text(saveX, barCenterY, 'SAVE', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '14px',
        color: '#1a0a2e',
      })
      .setOrigin(0.5);
    this.saveBtnBg.on('pointerdown', () => void this.onSaveTap());
    this.root.add([this.saveBtnBg, this.saveBtnText]);
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
    const atMax = totalPages >= ChartEditor.MAX_PAGES;
    this.addPageBtn.setAlpha(atMax ? 0.3 : 1);
    this.addPageBtnText.setAlpha(atMax ? 0.4 : 1);
  }

  private onAddPage(): void {
    const totalPages = Math.ceil(this.chart.stepCount / CHART_PAGE_SIZE);
    if (totalPages >= ChartEditor.MAX_PAGES) return;
    for (let i = 0; i < CHART_PAGE_SIZE; i++) {
      this.chart.steps.push({ lanes: [] });
    }
    this.chart.stepCount += CHART_PAGE_SIZE;
    // Jump the player to the new page so they can start authoring it.
    this.scrollOffset = this.chart.stepCount - CHART_PAGE_SIZE;
    this.refreshPage();
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
    if (this.tempoCycle.length === 0) return;
    this.tempoIndex = (this.tempoIndex + 1) % this.tempoCycle.length;
    this.chart.bpm = this.tempoCycle[this.tempoIndex]!.bpm;
    this.bpmBtnText.setText(this.tempoButtonLabel());

    // Vibes available depend on the new tempo — rebuild the cycle and
    // snap the chart's vibe to whatever's available so the picker
    // never lies about what's selectable.
    this.vibeCycle = buildVibeCycle(this.chart.bpm);
    if (this.vibeCycle.length === 0) {
      delete this.chart.vibe;
      this.vibeBtnText.setText(this.vibeButtonLabel());
      return;
    }
    const existingIdx = this.chart.vibe
      ? this.vibeCycle.indexOf(this.chart.vibe)
      : -1;
    this.vibeIndex = existingIdx >= 0 ? existingIdx : 0;
    this.chart.vibe = this.vibeCycle[this.vibeIndex]!;
    this.vibeBtnText.setText(this.vibeButtonLabel());
  }

  private onVibeTap(): void {
    if (this.vibeCycle.length === 0) return;
    this.vibeIndex = (this.vibeIndex + 1) % this.vibeCycle.length;
    this.chart.vibe = this.vibeCycle[this.vibeIndex]!;
    this.vibeBtnText.setText(this.vibeButtonLabel());
  }

  /** Render the speedLabel uppercased, e.g. "FAST". Falls back to a
   *  numeric "BPM N" only if the catalog is empty — that's a content
   *  bug worth surfacing. */
  private tempoButtonLabel(): string {
    if (this.tempoCycle.length === 0) return `BPM ${this.chart.bpm}`;
    const entry = this.tempoCycle[this.tempoIndex]!;
    return entry.speedLabel.toUpperCase();
  }

  /** Render the current vibe uppercased, e.g. "UPBEAT". Shows "—"
   *  if no vibes are available at the current tempo so the picker
   *  visibly inert rather than mysteriously blank. */
  private vibeButtonLabel(): string {
    if (this.vibeCycle.length === 0) return '—';
    return this.vibeCycle[this.vibeIndex]!.toUpperCase();
  }

  private async onSaveTap(): Promise<void> {
    if (this.saveBusy) return;
    const result = validateChart(this.chart);
    if (!result.ok) {
      console.warn('[ChartEditor] validateChart failed:', result.reason);
      this.flashSaveButton(0xff6b6b, 'INVALID');
      return;
    }
    this.saveBusy = true;
    this.chart.updatedAt = Date.now();
    try {
      await saveChart(this.chart);
      // Mutate the live playerState so the next time the player hits PLAY
      // from the hamburger drawer, Game.initChartPlayer sees the chart they
      // just authored (initChartPlayer reads playerState.chart first).
      if (this.playerState) {
        this.playerState.chart = this.chart;
      }
      this.flashSaveButton(0x4dffb4, 'SAVED');
    } catch (err) {
      console.warn('[ChartEditor] saveChart failed:', err);
      this.flashSaveButton(0xff6b6b, 'FAILED');
    } finally {
      this.saveBusy = false;
    }
  }

  /** Briefly recolor + relabel the SAVE button so the player sees the
   *  write took effect, then snap it back to yellow / SAVE. */
  private flashSaveButton(color: number, label: string): void {
    this.saveBtnBg.setFillStyle(color, 1);
    this.saveBtnText.setText(label);
    this.time.delayedCall(900, () => {
      if (!this.scene.isActive()) return;
      this.saveBtnBg.setFillStyle(0xffd34d, 1);
      this.saveBtnText.setText('SAVE');
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

// Layout constants — referenced from computeGrid + buildPageNav +
// buildBottomBar so the page-nav row and bottom strip stack cleanly.
const PAGE_NAV_ROW_H = 36;
const BOTTOM_STRIP_H = 72;

