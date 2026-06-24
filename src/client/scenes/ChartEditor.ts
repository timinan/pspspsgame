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
  BACKING_CATALOG,
} from '@/../shared/state';
import type { PlayerState, Chart, LaneId } from '@/../shared/state';
import { generateChart, stepsForDuration, type GenDifficulty } from '@/../shared/chart-generator';
import { SongPickerModal, type SongPickerResult } from '@/ui/song-picker-modal';
import { TemplateOrScratchModal, type StartMode } from '@/ui/template-or-scratch-modal';
import { DifficultyPickerModal } from '@/ui/difficulty-picker-modal';
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

  // Page nav (sits right above the bottom controls strip). ADD PAGE +
  // TEMPLATE buttons were removed when chart length became fixed at song
  // pick time — the page nav is just ▲ / PAGE / ▼ now.
  private scrollOffset = 0;
  private upPageBtn!: GameObjects.Text;
  private downPageBtn!: GameObjects.Text;
  private pageLabel!: GameObjects.Text;

  // Bottom controls — CLEAR / SONG / TRY since tempo+vibe come from the
  // SongPicker now.
  private songBtnText!: GameObjects.Text;
  private tryBusy = false;
  private tryBtnBg!: GameObjects.Rectangle;
  private tryBtnText!: GameObjects.Text;

  // Pre-edit pickers — SongPickerModal then TemplateOrScratchModal seed
  // the chart at scene entry. Both nullable so cleanup can null-check.
  private songPicker: SongPickerModal | null = null;
  private templateScratchModal: TemplateOrScratchModal | null = null;
  private difficultyPicker: DifficultyPickerModal | null = null;

  constructor() {
    super(SceneKeys.ChartEditor);
  }

  init(data: { playerState?: PlayerState | null }): void {
    this.playerState = data?.playerState ?? null;
    // Chart is not assigned here — it's seeded by SongPicker + Template/
    // Scratch in create(). Until then this.chart is undefined and the
    // grid isn't built.
    this.cellPanels = [];
    this.cellNotes = [];
    this.scrollOffset = 0;
    this.tryBusy = false;
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

    this.events.once(Scenes.Events.SHUTDOWN, () => this.cleanup());

    // Editor entry flow: pick a song, then (if needed) pick template or
    // scratch. Once both resolve, finishSetup builds the page nav + grid
    // + bottom bar and the user can author the chart.
    this.showSongPickerModal();
  }

  // ─── Entry flow ─────────────────────────────────────────────────────────

  private showSongPickerModal(): void {
    if (!this.songPicker) this.songPicker = new SongPickerModal(this);
    const existing = this.playerState?.chart;
    this.songPicker.open({
      initial: {
        ...(existing?.audioKey ? { audioKey: existing.audioKey } : {}),
        ...(existing?.vibe ? { vibe: existing.vibe } : {}),
      },
      onPick: (song) => this.handleSongPicked(song),
      onCancel: () => {
        this.scene.start(SceneKeys.Decorate, { playerState: this.playerState });
      },
    });
  }

  /** Decide whether to skip Template/Scratch and load the existing
   *  chart directly. Skip when: the player already has a chart AT THIS
   *  SAME song with at least one note authored — they're coming back to
   *  keep editing, not start over. */
  private handleSongPicked(song: SongPickerResult): void {
    const existing = this.playerState?.chart;
    const sameSong = existing?.audioKey === song.audioKey;
    const hasNotes = !!existing?.steps.some((s) => s.lanes.length > 0);
    if (existing && sameSong && hasNotes) {
      const chart = JSON.parse(JSON.stringify(existing)) as Chart;
      // Make sure tempo/vibe match what was just picked — catalog could
      // have shifted between the save and now.
      chart.bpm = song.bpm;
      chart.vibe = song.vibe;
      chart.audioKey = song.audioKey;
      this.finishSetup(chart);
      return;
    }
    this.showTemplateOrScratchModal(song);
  }

  private showTemplateOrScratchModal(song: SongPickerResult): void {
    if (!this.templateScratchModal) {
      this.templateScratchModal = new TemplateOrScratchModal(this);
    }
    this.templateScratchModal.open({
      onPick: (mode) => this.handleStartMode(song, mode),
      onBack: () => this.showSongPickerModal(),
    });
  }

  /** Template path branches into the difficulty picker so the procedurally
   *  generated chart has the player's intended density. Scratch path goes
   *  straight to an empty grid. */
  private handleStartMode(song: SongPickerResult, mode: StartMode): void {
    if (mode === 'template') {
      this.showDifficultyPickerModal(song);
    } else {
      this.buildScratchChart(song);
    }
  }

  private showDifficultyPickerModal(song: SongPickerResult): void {
    if (!this.difficultyPicker) {
      this.difficultyPicker = new DifficultyPickerModal(this);
    }
    this.difficultyPicker.open({
      initial: 'medium',
      onStart: (difficulty: GenDifficulty) => this.buildTemplateChart(song, difficulty),
      onBack: () => this.showTemplateOrScratchModal(song),
    });
  }

  private buildTemplateChart(song: SongPickerResult, difficulty: GenDifficulty): void {
    const username = this.playerState?.username ?? 'anon';
    const title = this.playerState?.chart?.title ?? 'My Beat';
    const chart = generateChart({
      authorId: username,
      title,
      difficulty,
      bpm: song.bpm,
      vibe: song.vibe,
      targetDurationMs: Balance.maxRoundMs,
    });
    chart.audioKey = song.audioKey;
    this.finishSetup(chart);
  }

  private buildScratchChart(song: SongPickerResult): void {
    const username = this.playerState?.username ?? 'anon';
    const title = this.playerState?.chart?.title ?? 'My Beat';
    // Scratch: pad chart length to one full round at this song's BPM
    // rounded up to a CHART_PAGE_SIZE so validateChart is happy.
    const rawSteps = stepsForDuration(song.bpm, Balance.maxRoundMs);
    const stepCount = Math.max(
      CHART_PAGE_SIZE,
      Math.ceil(rawSteps / CHART_PAGE_SIZE) * CHART_PAGE_SIZE,
    );
    const chart = emptyChart(username, title, stepCount);
    chart.bpm = song.bpm;
    chart.vibe = song.vibe;
    chart.audioKey = song.audioKey;
    this.finishSetup(chart);
  }

  /** Stamp the chart, build the grid + bottom bar, refresh the page. */
  private finishSetup(chart: Chart): void {
    this.chart = chart;
    this.buildPageNav();
    this.buildGrid();
    this.buildBottomBar();
  }

  // ─── Layout ─────────────────────────────────────────────────────────────

  private computeGrid(): void {
    const { width, height } = this.scale;
    // HUD up top; bottom carved into page-nav row + controls strip + a
    // bit of breathing room. Grid takes everything else. We render TWO
    // pages worth of cells at a time (EDITOR_VISIBLE_ROWS = 2 *
    // CHART_PAGE_SIZE) so the author can see the next page coming up
    // and decide note spacing across the page boundary.
    const topReserved = TopHud.HEIGHT + 8;
    const bottomReserved = PAGE_NAV_ROW_H + BOTTOM_STRIP_H + 8;
    this.gridTop = topReserved;
    this.gridBottom = height - bottomReserved;
    this.cellH = (this.gridBottom - this.gridTop) / EDITOR_VISIBLE_ROWS;
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
          label: 'REHEARSE',
          description: 'Practice your meowcert',
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
          label: 'MERCH',
          description: 'Cat + cosmetic drops',
          icon: '🛒',
          onTap: () => this.scene.start(SceneKeys.Purchase, { playerState: this.playerState }),
        },
        {
          label: 'CATCH A MEOWCERT',
          description: 'See who\'s playing',
          icon: '🎪',
          onTap: () => this.scene.start(SceneKeys.VisitShows, { playerState: this.playerState }),
        },
      ],
    });
  }

  private buildPageNav(): void {
    const { width, height } = this.scale;
    // Page-nav row sits directly above the bottom controls strip. With
    // ADD PAGE + TEMPLATE removed, the row is just the prev / page-label
    // / next cluster centered horizontally.
    const navY = height - BOTTOM_STRIP_H - PAGE_NAV_ROW_H / 2;
    const centerX = width / 2;
    const spacing = 60;

    this.upPageBtn = this.add
      .text(centerX - spacing, navY, '▲', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '20px',
        color: '#ffd34d',
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    this.upPageBtn.on('pointerdown', () => this.onPrevPage());

    this.pageLabel = this.add
      .text(centerX, navY, '', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#ffffff',
      })
      .setOrigin(0.5);

    this.downPageBtn = this.add
      .text(centerX + spacing, navY, '▼', {
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
    for (let localStep = 0; localStep < EDITOR_VISIBLE_ROWS; localStep++) {
      this.cellPanels[localStep] = [];
      this.cellNotes[localStep] = [];
      const cy = this.gridTop + localStep * this.cellH + this.cellH / 2;

      for (let lane = 0; lane < L.LANE_COUNT; lane++) {
        const cx = this.colCenterXs[lane]!;

        const panel = this.add
          .rectangle(cx, cy, this.cellW - 6, this.cellH - 2, 0x0b041a, 0.35)
          .setStrokeStyle(1, 0xffffff, 0.12)
          .setInteractive({ useHandCursor: true });
        const ls = localStep;
        const ln = lane;
        panel.on('pointerdown', () => this.toggleCell(ls, ln as LaneId));
        this.cellPanels[localStep]![lane] = panel;
        this.root.add(panel);

        const noteSize = Math.min(this.cellW - 10, this.cellH - 4, 64);
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

    // Page-break line — horizontal yellow divider between the top page
    // and the bottom page (rows 7 and 8 in the 16-row view). Same line
    // treatment the rehearse mode uses for page boundaries; here it's
    // static and sits permanently in the middle of the grid so the
    // author can read "this is the seam between pages."
    const pageBreakY = this.gridTop + CHART_PAGE_SIZE * this.cellH;
    const pageBreakLine = this.add
      .rectangle(this.scale.width / 2, pageBreakY, this.scale.width - 12, 2, 0xffd34d, 0.85)
      .setDepth(45);
    this.root.add(pageBreakLine);

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

    // Three buttons: CLEAR / SONG / TRY. Tempo + vibe came from the
    // SongPicker at scene entry, so they're no longer needed here. SONG
    // re-opens the picker so the player can swap mid-edit.
    const sideMargin = 10;
    const gap = 6;
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
        fontSize: '12px',
        color: '#c678ff',
      })
      .setOrigin(0.5);
    clearBg.on('pointerdown', () => this.onClearTap());
    this.root.add([clearBg, clearText]);

    // SONG — shows the picked song's display name (truncated). Tap to
    // re-open the SongPicker. Re-picking the same song keeps existing
    // notes; picking a different one triggers Template-or-Scratch again
    // and replaces the chart.
    const songX = startX + btnW + gap;
    const songBg = this.add
      .rectangle(songX, barCenterY, btnW, btnH, 0x2c1856, 1)
      .setStrokeStyle(1, 0xc678ff, 0.7)
      .setInteractive({ useHandCursor: true });
    this.songBtnText = this.add
      .text(songX, barCenterY, this.songButtonLabel(), {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '10px',
        color: '#c0a0e6',
        align: 'center',
        wordWrap: { width: btnW - 8 },
      })
      .setOrigin(0.5);
    songBg.on('pointerdown', () => this.showSongPickerModal());
    this.root.add([songBg, this.songBtnText]);

    // TRY — primary action. Big yellow button. Saves the chart then
    // jumps to Game in test mode for an instant playthrough.
    const tryX = songX + btnW + gap;
    this.tryBtnBg = this.add
      .rectangle(tryX, barCenterY, btnW, btnH, 0xffd34d, 1)
      .setInteractive({ useHandCursor: true });
    this.tryBtnText = this.add
      .text(tryX, barCenterY, 'REHEARSE', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '14px',
        color: '#1a0a2e',
      })
      .setOrigin(0.5);
    this.tryBtnBg.on('pointerdown', () => void this.onTryTap());
    this.root.add([this.tryBtnBg, this.tryBtnText]);
  }

  /** Human-readable label for the SONG button — the picked backing's
   *  display name when set, otherwise a fallback. Kept short so it fits
   *  the bottom-strip cell. */
  private songButtonLabel(): string {
    const key = this.chart?.audioKey;
    if (!key) return 'SONG';
    const entry = BACKING_CATALOG[key];
    const name = entry?.displayName ?? entry?.id ?? key;
    return name.toUpperCase();
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
    for (let localStep = 0; localStep < EDITOR_VISIBLE_ROWS; localStep++) {
      const modelStep = this.scrollOffset + localStep;
      const step = this.chart.steps[modelStep];
      // Cells beyond the end of the chart render empty + dim (no note,
      // panel still visible but greyed out so the author sees where the
      // chart "ends").
      const beyondChart = modelStep >= this.chart.stepCount;
      for (let lane = 0; lane < L.LANE_COUNT; lane++) {
        const note = this.cellNotes[localStep]![lane]!;
        const active = step?.lanes.includes(lane as LaneId) ?? false;
        note.setVisible(active);
        note.setScale(1);
        const panel = this.cellPanels[localStep]![lane]!;
        panel.setAlpha(beyondChart ? 0.18 : 1);
      }
    }
    this.refreshPageLabel();
  }

  private refreshPageLabel(): void {
    // Current page = the page sitting at the TOP of the visible 2-page
    // view. Total pages = chart.stepCount / CHART_PAGE_SIZE.
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
    // Cap at the LAST chart page sitting at the top of the view. Allows
    // "page N at top, empty below" for the final page.
    const maxOffset = Math.max(0, this.chart.stepCount - CHART_PAGE_SIZE);
    if (this.scrollOffset >= maxOffset) return;
    this.scrollOffset = Math.min(maxOffset, this.scrollOffset + CHART_PAGE_SIZE);
    this.refreshPage();
  }

  private onClearTap(): void {
    for (const step of this.chart.steps) step.lanes = [];
    this.refreshPage();
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
      this.tryBtnText.setText('REHEARSE');
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
    this.songPicker?.destroy();
    this.songPicker = null;
    this.templateScratchModal?.destroy();
    this.templateScratchModal = null;
    this.difficultyPicker?.destroy();
    this.difficultyPicker = null;
    this.root.destroy(true);
  }
}

// Layout constants — referenced from computeGrid + buildPageNav +
// buildBottomBar so the page-nav row and bottom strip stack cleanly.
const PAGE_NAV_ROW_H = 36;
const BOTTOM_STRIP_H = 72;
// Editor shows TWO pages of cells at once stacked vertically (16 rows
// = 2 * CHART_PAGE_SIZE) so the author can see the next page coming and
// space notes against the page break — Tim's "page 3 at top, page 4 at
// bottom" model. Pagination moves by one page (CHART_PAGE_SIZE = 8).
const EDITOR_VISIBLE_ROWS = CHART_PAGE_SIZE * 2;

