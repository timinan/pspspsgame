import { Scene, Scenes, GameObjects } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { TopHud } from '@/ui/top-hud';
import { BackgroundManager } from '@/entities/background-manager';
import { liftTowardWhite, BALL_BRIGHTNESS_LIFT, LANE_BRIGHTNESS_LIFT } from '@/entities/note-colors';
import * as L from '@/constants/scene-layout';
import { AssetKeys } from '@/constants/assets';
import { saveChart } from '@/services/state-client';
import {
  emptyChart,
  validateChart,
  CHART_PAGE_SIZE,
} from '@/../shared/state';
import type { PlayerState, Chart, LaneId, BackingVibe } from '@/../shared/state';
import {
  buildTempoCycle,
  buildVibeCycle,
  type TempoEntry,
} from '@/systems/tempo-vibe-cycles';
import { generateChart } from '@/../shared/chart-generator';
import { GenerateModal } from '@/ui/generate-modal';
import { Balance } from '@/constants/balance';

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
  /** Per-bg sampled lane tints for the active background. Same source
   *  as `Game.laneTints` so the editor previews colors that match
   *  what'll show in-round. Falls back to `LANE_COLORS` defaults. */
  private laneTints: readonly [number, number, number] = [
    L.LANE_COLORS[0]!, L.LANE_COLORS[1]!, L.LANE_COLORS[2]!,
  ];

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
  private tmplBtn!: GameObjects.Rectangle;
  private tmplBtnText!: GameObjects.Text;
  private generateModal: GenerateModal | null = null;

  // Bottom controls
  private bpmBtnText!: GameObjects.Text;
  private tempoCycle: TempoEntry[] = [];
  private tempoIndex = 0;
  private vibeBtnText!: GameObjects.Text;
  private vibeCycle: BackingVibe[] = [];
  private vibeIndex = 0;
  private tryBusy = false;
  private tryBtnBg!: GameObjects.Rectangle;
  private tryBtnText!: GameObjects.Text;

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
    this.tryBusy = false;
    this.colCenterXs = [];
  }

  /** Max chart length, in pages. Tuned to fit a 45-second round at the
   *  slowest tempo we support — Template-generated charts at 130bpm pack
   *  about 25 pages, so 32 leaves headroom for a slower future BPM and
   *  hand-extended authoring without ever needing a runtime clamp. */
  private static readonly MAX_PAGES = 32;

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

  /** Look up the per-bg sampled lane tint trio from cache, matching the
   *  exact same resolver `Game` uses. Falls back to LANE_COLORS defaults
   *  when the JSON didn't load or the active bg isn't sampled. */
  private resolveLaneTints(): readonly [number, number, number] {
    const sampled = this.cache.json.get(AssetKeys.Json.BgLaneColors) as
      | Record<string, [string, string, string]>
      | undefined;
    const activeBg = this.playerState?.activeBackground ?? 'stage';
    const trio = sampled?.[activeBg];
    if (!trio || trio.length !== 3) {
      return [L.LANE_COLORS[0]!, L.LANE_COLORS[1]!, L.LANE_COLORS[2]!];
    }
    return trio.map((hex) => parseInt(hex.replace('#', ''), 16)) as unknown as readonly [number, number, number];
  }

  private drawColumnWashes(): void {
    // Resolve the per-bg sampled lane tints once and cache. Editor reads
    // the same `bg-lane-colors.json` Game does, so the preview matches
    // what the chart will look like in-round on whichever bg the player
    // currently has active.
    this.laneTints = this.resolveLaneTints();
    const colW = this.cellW;
    const colH = this.gridBottom - this.gridTop;
    for (let i = 0; i < L.LANE_COUNT; i++) {
      const cx = this.colCenterXs[i]!;
      const cy = this.gridTop + colH / 2;
      const color = this.laneTints[i]!;
      // White-base lane texture so the tint comes through clean — same
      // change Game.drawLanes uses.
      const bar = this.add.image(cx, cy, AssetKeys.Image.RhythmBarBackgroundWhite);
      bar.displayWidth = colH;
      bar.displayHeight = colW - 2;
      bar.setRotation(-Math.PI / 2);
      // Match Game.drawLanes: pastel the lane so the raw-color ball pops.
      bar.setTint(liftTowardWhite(color, LANE_BRIGHTNESS_LIFT));
      // Higher alpha than Game (was 0.55) so the busy background detail
      // up at the top of the lane stops bleeding through the cell grid
      // — players said it made the upper steps hard to read.
      bar.setAlpha(0.88);
      this.root.add(bar);
    }
  }

  private buildHud(): void {
    this.hud = new TopHud(this, {
      showStats: false,
      items: [
        {
          label: 'SHOWTIME',
          description: 'Play the show',
          icon: '🎵',
          onTap: () => this.scene.start(SceneKeys.Game, { playerState: this.playerState }),
        },
        {
          label: 'SET STAGE',
          description: 'Cats & backdrop',
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

    // TEMPLATE — opens the Generate modal so the player can fill the
    // chart with a procedurally generated pattern. Sits between the
    // page nav cluster and ADD PAGE so it never overlaps either.
    const tmplW = 96;
    const tmplH = 28;
    const tmplX = addX - addW / 2 - 8 - tmplW / 2;
    this.tmplBtn = this.add
      .rectangle(tmplX, navY, tmplW, tmplH, 0x2c1856, 1)
      .setStrokeStyle(1, 0xffd34d, 0.7)
      .setInteractive({ useHandCursor: true });
    this.tmplBtnText = this.add
      .text(tmplX, navY, 'TEMPLATE', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '11px',
        color: '#ffd34d',
      })
      .setOrigin(0.5);
    this.tmplBtn.on('pointerdown', () => this.onTemplateTap());

    this.root.add([
      this.upPageBtn,
      this.pageLabel,
      this.downPageBtn,
      this.tmplBtn,
      this.tmplBtnText,
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
        // Same white-base ball + lifted tint as the in-game falling note —
        // see `Note.configure` + `liftTowardWhite`. Keeps the editor's
        // preview color-accurate against the live Game scene.
        const ball = this.add.image(0, 0, AssetKeys.Image.PspspsElementBallWhite);
        ball.setDisplaySize(noteSize, noteSize);
        ball.setTint(liftTowardWhite(this.laneTints[lane]!, BALL_BRIGHTNESS_LIFT));
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

    // Four buttons across the bottom: CLEAR / TEMPO / VIBE / TRY.
    // TRY is the primary action — saves the chart, then immediately
    // boots the Game scene in test mode so the player can play their
    // own chart. The post-test summary offers POST + BACK TO EDITOR.
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

    // TRY — primary action. Big yellow button. Saves the chart then
    // jumps to Game in test mode for an instant playthrough.
    const tryX = vibeX + btnW + gap;
    this.tryBtnBg = this.add
      .rectangle(tryX, barCenterY, btnW, btnH, 0xffd34d, 1)
      .setInteractive({ useHandCursor: true });
    this.tryBtnText = this.add
      .text(tryX, barCenterY, 'TRY', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '14px',
        color: '#1a0a2e',
      })
      .setOrigin(0.5);
    this.tryBtnBg.on('pointerdown', () => void this.onTryTap());
    this.root.add([this.tryBtnBg, this.tryBtnText]);
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

  private onTemplateTap(): void {
    if (!this.generateModal) this.generateModal = new GenerateModal(this);
    this.generateModal.open({
      initial: {
        bpm: this.chart.bpm,
        vibe: this.chart.vibe,
      },
      onGenerate: (result) => {
        const generated = generateChart({
          authorId: this.chart.authorId,
          title: this.chart.title,
          difficulty: result.difficulty,
          bpm: result.bpm,
          vibe: result.vibe,
          targetDurationMs: Balance.maxRoundMs,
        });
        // Mutate the existing chart in place so any other reference (e.g.
        // playerState.chart pointing at this object) sees the update,
        // then re-sync the editor's tempo/vibe pickers to match.
        this.chart.steps = generated.steps;
        this.chart.stepCount = generated.stepCount;
        this.chart.bpm = generated.bpm;
        this.chart.vibe = generated.vibe;
        this.chart.updatedAt = generated.updatedAt;
        this.syncTempoVibeIndexes();
        this.bpmBtnText.setText(this.tempoButtonLabel());
        this.vibeBtnText.setText(this.vibeButtonLabel());
        this.scrollOffset = 0;
        this.refreshPage();
      },
    });
  }

  /** After a generator run flips bpm + vibe under us, snap the editor's
   *  cycle indexes back into sync so the next tempo/vibe tap continues
   *  from the right slot instead of jumping to a stale position. */
  private syncTempoVibeIndexes(): void {
    if (this.tempoCycle.length > 0) {
      const idx = this.tempoCycle.findIndex((t) => t.bpm === this.chart.bpm);
      this.tempoIndex = idx >= 0 ? idx : 0;
    }
    this.vibeCycle = buildVibeCycle(this.chart.bpm);
    if (this.vibeCycle.length > 0) {
      const idx = this.chart.vibe ? this.vibeCycle.indexOf(this.chart.vibe) : -1;
      this.vibeIndex = idx >= 0 ? idx : 0;
      this.chart.vibe = this.vibeCycle[this.vibeIndex]!;
    }
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

  private async onTryTap(): Promise<void> {
    if (this.tryBusy) return;
    const result = validateChart(this.chart);
    if (!result.ok) {
      console.warn('[ChartEditor] validateChart failed:', result.reason);
      this.flashTryButton(0xff6b6b, 'INVALID');
      return;
    }
    this.tryBusy = true;
    this.chart.updatedAt = Date.now();
    try {
      await saveChart(this.chart);
    } catch (err) {
      // Save failure isn't fatal — Game.initChartPlayer reads the chart
      // off playerState first, and we mutate that below. Worst case the
      // player tests an unsaved version.
      console.warn('[ChartEditor] saveChart failed (continuing anyway):', err);
    }
    if (this.playerState) {
      this.playerState.chart = this.chart;
    }
    this.scene.start(SceneKeys.Game, {
      playerState: this.playerState,
      testMode: true,
    });
  }

  /** Briefly recolor + relabel the TRY button — only used for
   *  validation failure; on a successful TRY we navigate to Game
   *  immediately so no flash is needed. */
  private flashTryButton(color: number, label: string): void {
    this.tryBtnBg.setFillStyle(color, 1);
    this.tryBtnText.setText(label);
    this.time.delayedCall(900, () => {
      if (!this.scene.isActive()) return;
      this.tryBtnBg.setFillStyle(0xffd34d, 1);
      this.tryBtnText.setText('TRY');
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
    this.generateModal?.destroy();
    this.generateModal = null;
    this.root.destroy(true);
  }
}

// Layout constants — referenced from computeGrid + buildPageNav +
// buildBottomBar so the page-nav row and bottom strip stack cleanly.
const PAGE_NAV_ROW_H = 36;
const BOTTOM_STRIP_H = 72;

