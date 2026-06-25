import { Scene, Scenes, GameObjects } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { TopHud } from '@/ui/top-hud';
import { BackgroundManager } from '@/entities/background-manager';
import { liftTowardWhite, darkenTowardBlack, LANE_BRIGHTNESS_LIFT } from '@/entities/note-colors';
import * as L from '@/constants/scene-layout';
import { AssetKeys } from '@/constants/assets';
import { saveChart } from '@/services/state-client';
import {
  emptyChart,
  validateChart,
  lanesTouchedBySlide,
  CHART_PAGE_SIZE,
  BACKING_CATALOG,
} from '@/../shared/state';
import type { PlayerState, Chart, LaneId, Hold, Slide, SlideReturn } from '@/../shared/state';
import { generateChart, stepsForDuration, type GenDifficulty } from '@/../shared/chart-generator';
import { SongPickerModal, type SongPickerResult } from '@/ui/song-picker-modal';
import { TemplateOrScratchModal, type StartMode } from '@/ui/template-or-scratch-modal';
import { DifficultyPickerModal } from '@/ui/difficulty-picker-modal';
import { Balance } from '@/constants/balance';
import { resolveLaneTintsFromSeatedCats } from '@/constants/cat-colors';

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

  /** Per-page hold visuals — destroyed and rebuilt on every refreshHolds.
   *  Mixed types (tail rectangles + head images) so the array is typed
   *  as the base GameObject. */
  private holdGraphics: GameObjects.GameObject[] = [];

  // Drag state for hold + slide authoring. pointerdown on a cell seeds
  // these; scene-level pointermove updates `current`; pointerup commits:
  // - same cell                → tap toggle
  // - same lane, different row → hold
  // - different lane (adjacent), same row(ish) → slide
  // - anything else → no-op
  private dragStartLocal: number | null = null;
  private dragStartLane: LaneId | null = null;
  private dragCurrentLocal: number | null = null;
  private dragCurrentLane: LaneId | null = null;
  /** All distinct lanes the pointer has entered during the current drag
   *  (including the start lane). Used to detect a slide-and-return: the
   *  pointer visited a non-start lane, then returned to the start lane
   *  on release. Captures intent the regular slide path can't. */
  private dragVisitedLanes = new Set<LaneId>();

  // Page-break labels — refresh per page so the author sees the actual
  // top-page + bottom-page numbers as they navigate.
  private pageBreakTopLine!: GameObjects.Rectangle;
  private pageBreakMidLine!: GameObjects.Rectangle;
  private pageBreakTopLabel!: GameObjects.Text;
  private pageBreakMidLabel!: GameObjects.Text;

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

  init(data: {
    playerState?: PlayerState | null;
    initialPage?: number;
    resume?: boolean;
  }): void {
    this.playerState = data?.playerState ?? null;
    // Chart is not assigned here — it's seeded by SongPicker + Template/
    // Scratch in create(). Until then this.chart is undefined and the
    // grid isn't built.
    this.cellPanels = [];
    this.cellNotes = [];
    this.scrollOffset = 0;
    this.pendingInitialPage = data?.initialPage ?? 0;
    this.pendingResume = data?.resume === true;
    this.tryBusy = false;
    this.colCenterXs = [];
  }

  /** Page index requested by the caller (e.g. Game's BACK TO EDITOR). Applied
   *  in finishSetup once the chart is loaded so the editor opens on the
   *  same page the player was rehearsing. */
  private pendingInitialPage = 0;

  /** True when re-entering from rehearsal — skip song/template pickers and
   *  load `playerState.chart` directly so the author lands back on the
   *  chart they were just editing. */
  private pendingResume = false;

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
    this.input.on('pointerup', this.onScenePointerUp, this);
    // Scene-level pointermove for hold drag tracking — per-cell pointerover
    // doesn't fire reliably during a touch drag (Phaser locks events to
    // the pointerdown target), so we manually hit-test against cell
    // bounds while a drag is in progress.
    this.input.on('pointermove', this.onScenePointerMove, this);

    // Resume path: re-entering from rehearsal. Skip the pickers and
    // jump straight to the chart we just sent off (lives on
    // playerState.chart since onTryTap stamps it before launching Game).
    if (this.pendingResume && this.playerState?.chart) {
      const chart = JSON.parse(JSON.stringify(this.playerState.chart)) as Chart;
      this.finishSetup(chart);
      return;
    }

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
    // Target the PLAYABLE window (not the full round) so the chart
    // doesn't extend into the cutoff zone. 1500ms estimated hold buffer
    // matches the player's runtime maxHold-aware cutoff for typical
    // generator output.
    const playableMs = Balance.maxRoundMs - Balance.noteFallMs - Balance.roundWindDownMs - 1500;
    const chart = generateChart({
      authorId: username,
      title,
      difficulty,
      bpm: song.bpm,
      vibe: song.vibe,
      targetDurationMs: playableMs,
    });
    chart.audioKey = song.audioKey;
    this.finishSetup(chart);
  }

  private buildScratchChart(song: SongPickerResult): void {
    const username = this.playerState?.username ?? 'anon';
    const title = this.playerState?.chart?.title ?? 'My Beat';
    // Scratch chart sized to the PLAYABLE window so the author isn't
    // editing into the cutoff zone. Rounded up to CHART_PAGE_SIZE so
    // validateChart is happy.
    const playableMs = Balance.maxRoundMs - Balance.noteFallMs - Balance.roundWindDownMs - 1500;
    const rawSteps = stepsForDuration(song.bpm, playableMs);
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

  /** Stamp the chart, build the grid + bottom bar, refresh the page.
   *  Applies any `initialPage` passed in by the caller (e.g. coming
   *  back from rehearsal) so the editor opens on the right page. */
  private finishSetup(chart: Chart): void {
    this.chart = chart;
    // Strip any tap/hold/slide that falls past the playable cutoff —
    // legacy charts (or template-generated charts before this guard)
    // can have notes there; they'll never play in-round so visually
    // clear them up front. New placements are blocked at commit time.
    this.stripRestrictedNotes();
    const totalPages = Math.max(1, Math.ceil(chart.stepCount / CHART_PAGE_SIZE));
    const requested = Math.max(0, Math.min(totalPages - 1, this.pendingInitialPage));
    this.scrollOffset = requested * CHART_PAGE_SIZE;
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

  /** Lane tints follow the seated cats, matching what Game.drawLanes
   *  does — same shared resolver so the editor preview always shows
   *  the player's actual lineup colors. Falls back to bg-sampled then
   *  default trio when no cats are seated. */
  private resolveLaneTints(): readonly [number, number, number] {
    const fromCats = resolveLaneTintsFromSeatedCats(this.playerState);
    if (fromCats) return fromCats;
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
      // Plain pastel-color rectangle — editor skips the textured rhythm
      // bar so the baked-in paws don't ride along, leaving a clean lane
      // wash for the grid + fuzzballs to read against.
      const bar = this.add.rectangle(
        cx,
        cy,
        colW - 2,
        colH,
        liftTowardWhite(color, LANE_BRIGHTNESS_LIFT),
        0.55,
      );
      this.root.add(bar);
    }
  }

  private buildHud(): void {
    this.hud = new TopHud(this, {
      showStats: false,
      currentKey: SceneKeys.ChartEditor,
      items: [
        {
          label: 'SET STAGE',
          description: 'Dress the band, light the room',
          icon: '😺',
          key: SceneKeys.Decorate,
          onTap: () => this.scene.start(SceneKeys.Decorate, { playerState: this.playerState }),
        },
        {
          label: 'REHEARSE',
          description: 'Pawractice makes purrfect',
          icon: '🎵',
          key: SceneKeys.Game,
          onTap: () => this.scene.start(SceneKeys.Game, { playerState: this.playerState }),
        },
        {
          label: 'PUT ON A SHOW',
          description: 'Cook up your next hit',
          icon: '🎼',
          key: SceneKeys.ChartEditor,
          onTap: () => this.scene.start(SceneKeys.ChartEditor, { playerState: this.playerState }),
        },
        {
          label: 'MERCH',
          description: 'Fresh drops at the merch table',
          icon: '🛒',
          key: SceneKeys.Purchase,
          onTap: () => this.scene.start(SceneKeys.Purchase, { playerState: this.playerState }),
        },
        {
          label: 'CATCH A SHOW',
          description: 'Front row for fellow artists',
          icon: '🎪',
          key: SceneKeys.VisitShows,
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

    // Tighter pager — arrows hug a yellow chip in the middle so the
    // 'page X / Y' reads as a unit instead of three free-floating items.
    const chipSpacing = 38;
    this.upPageBtn = this.add
      .text(centerX - chipSpacing, navY, '▲', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '18px',
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
        color: '#ffd34d',
      })
      .setOrigin(0.5);

    this.downPageBtn = this.add
      .text(centerX + chipSpacing, navY, '▼', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '18px',
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

        // Flipped per Tim's screenshot: DARK lines, LIGHT surfaces.
        // Cell fill is transparent so the lane wash (the cat color)
        // reads clean as the surface; the stroke is a dark indigo at
        // ~0.65 alpha so the row + column dividers stand out as
        // distinct dark grid lines instead of soft highlights.
        const panel = this.add
          .rectangle(cx, cy, this.cellW - 6, this.cellH - 2, 0x000000, 0)
          .setStrokeStyle(1, 0x1a0a2e, 0.7)
          .setInteractive({ useHandCursor: true });
        const ls = localStep;
        const ln = lane;
        panel.on('pointerdown', () => this.onCellPointerDown(ls, ln as LaneId));
        this.cellPanels[localStep]![lane] = panel;
        this.root.add(panel);

        // Slightly bigger than the previous (cellW - 10) → fills more of
        // the cell so the fuzzball pops on glance. Capped at 56 to keep
        // some breathing room above + below in the half-height cells.
        const noteSize = Math.min(this.cellW - 4, this.cellH + 2, 56);
        const noteContainer = this.add.container(cx, cy);
        // Use the hit-target sprite (no PS letters) instead of the
        // falling-note sprite. Tim's note: the editor preview should
        // read as the bottom catching fuzzball, not the falling ball.
        const ball = this.add.image(0, 0, AssetKeys.Image.PspspsTargetWhite);
        ball.setDisplaySize(noteSize, noteSize);
        ball.setTint(darkenTowardBlack(this.laneTints[lane]!, 0.18));
        noteContainer.add(ball);
        noteContainer.setDepth(40);
        noteContainer.setVisible(false);
        this.cellNotes[localStep]![lane] = noteContainer;
        this.root.add(noteContainer);
      }
    }

    // Page-break lines — matches the rehearse mode: yellow horizontal
    // dividers with the page number centered on the line. One sits at
    // the TOP of the grid (marks the start of the page currently in
    // view), one in the MIDDLE (between rows 7 and 8 — marks the start
    // of the next page). Labels refresh per page via refreshPage.
    const topY = this.gridTop;
    const midY = this.gridTop + CHART_PAGE_SIZE * this.cellH;
    const w = this.scale.width;
    this.pageBreakTopLine = this.add
      .rectangle(w / 2, topY, w - 12, 2, 0xffd34d, 0.85)
      .setDepth(45);
    this.pageBreakMidLine = this.add
      .rectangle(w / 2, midY, w - 12, 2, 0xffd34d, 0.85)
      .setDepth(45);
    const pageChipStyle = {
      fontFamily: 'Pixeloid Sans, sans-serif',
      fontStyle: 'bold',
      fontSize: '11px',
      color: '#1a0a2e',
      backgroundColor: '#ffd34d',
      padding: { x: 6, y: 1 },
    } as const;
    this.pageBreakTopLabel = this.add
      .text(w / 2, topY, '', pageChipStyle)
      .setOrigin(0.5)
      .setDepth(46);
    this.pageBreakMidLabel = this.add
      .text(w / 2, midY, '', pageChipStyle)
      .setOrigin(0.5)
      .setDepth(46);
    this.root.add([
      this.pageBreakTopLine,
      this.pageBreakMidLine,
      this.pageBreakTopLabel,
      this.pageBreakMidLabel,
    ]);

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

  /** Steps past this index will never play because they fall after the
   *  round-end wall-clock minus the fall + wind-down buffer. Editor
   *  refuses placements past this and paints those cells red so authors
   *  see the dead zone. */
  private getCutoffStep(): number {
    const msPerStep = 60000 / (this.chart.bpm * 2);
    const cutoffMs = Balance.maxRoundMs - Balance.noteFallMs - Balance.roundWindDownMs;
    return Math.max(1, Math.floor(cutoffMs / msPerStep));
  }

  /** One-shot cleanup of any tap/hold/slide that lands past the
   *  playable cutoff. Called on chart load so legacy / generator-
   *  produced notes in the red zone don't visually persist as
   *  "uneditable garbage." */
  private stripRestrictedNotes(): void {
    const cutoffStep = this.getCutoffStep();
    for (let s = cutoffStep; s < this.chart.steps.length; s++) {
      const step = this.chart.steps[s];
      if (step) step.lanes = [];
    }
    if (this.chart.holds) {
      this.chart.holds = this.chart.holds.filter(
        (h) => h.startStep < cutoffStep && h.endStep < cutoffStep,
      );
    }
    if (this.chart.slides) {
      this.chart.slides = this.chart.slides.filter((s) => s.startStep < cutoffStep);
    }
    if (this.chart.slideReturns) {
      this.chart.slideReturns = this.chart.slideReturns.filter((s) => s.startStep < cutoffStep);
    }
  }

  private toggleCell(localStep: number, lane: LaneId): void {
    const modelStep = this.scrollOffset + localStep;
    const step = this.chart.steps[modelStep];
    if (!step) return;
    if (modelStep >= this.getCutoffStep()) return;
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

  // ─── Hold authoring ────────────────────────────────────────────────────

  private onCellPointerDown(localStep: number, lane: LaneId): void {
    const modelStep = this.scrollOffset + localStep;
    if (modelStep >= this.chart.stepCount) return;
    // Tap on an existing slide → delete it.
    const existingSlide = this.findSlideAtCell(modelStep, lane);
    if (existingSlide) {
      this.removeSlide(existingSlide);
      this.refreshPage();
      this.resetDrag();
      return;
    }
    // Tap on an existing slide-and-return → delete it.
    const existingSR = this.findSlideReturnAtCell(modelStep, lane);
    if (existingSR) {
      this.removeSlideReturn(existingSR);
      this.refreshPage();
      this.resetDrag();
      return;
    }
    // Tap inside an existing hold removes it whole — easier than a
    // dedicated delete mode. Same-lane requirement keeps cross-lane
    // taps from accidentally clearing holds in neighboring lanes.
    const existingHold = this.findHoldAtCell(modelStep, lane);
    if (existingHold) {
      this.removeHold(existingHold);
      this.refreshPage();
      this.resetDrag();
      return;
    }
    this.dragStartLocal = localStep;
    this.dragStartLane = lane;
    this.dragCurrentLocal = localStep;
    this.dragCurrentLane = lane;
    this.dragVisitedLanes = new Set([lane]);
  }

  private onScenePointerMove = (pointer: Phaser.Input.Pointer): void => {
    if (this.dragStartLane === null || !pointer.isDown) return;
    const localStep = Math.floor((pointer.y - this.gridTop) / this.cellH);
    if (localStep < 0 || localStep >= EDITOR_VISIBLE_ROWS) return;
    const modelStep = this.scrollOffset + localStep;
    if (modelStep >= this.chart.stepCount) return;
    // Which lane is the pointer over? Walk the row's three cell panels
    // and pick the one whose bounds contain pointer.x. Cross-lane drag
    // is now supported — onScenePointerUp decides hold vs slide based
    // on the start vs current lane.
    let pointerLane: LaneId | null = null;
    for (let l = 0; l < L.LANE_COUNT; l++) {
      const panel = this.cellPanels[localStep]?.[l];
      if (!panel) continue;
      const bounds = panel.getBounds();
      if (pointer.x >= bounds.left && pointer.x <= bounds.right) {
        pointerLane = l as LaneId;
        break;
      }
    }
    if (pointerLane === null) return;
    this.dragCurrentLocal = localStep;
    this.dragCurrentLane = pointerLane;
    this.dragVisitedLanes.add(pointerLane);
  };

  private onScenePointerUp = (): void => {
    if (this.dragStartLocal === null || this.dragStartLane === null) return;
    const startLocal = this.dragStartLocal;
    const startLane = this.dragStartLane;
    const currentLocal = this.dragCurrentLocal ?? startLocal;
    const currentLane = this.dragCurrentLane ?? startLane;
    const visited = new Set(this.dragVisitedLanes);
    this.resetDrag();

    // Slide-and-return: pointer visited a different lane AND returned
    // to the start lane on release. Now supports BOTH 1-lane (adjacent)
    // and 2-lane (full-width 0↔2) variants — picks the farthest reached
    // lane as the target. So drag 0→1→0 commits 0↔1; drag 0→1→2→1→0
    // commits 0↔2.
    if (currentLane === startLane && visited.size >= 2) {
      let farthest: LaneId | null = null;
      let farthestDist = 0;
      for (const v of visited) {
        if (v === startLane) continue;
        const dist = Math.abs(v - startLane);
        if (dist > farthestDist) {
          farthestDist = dist;
          farthest = v;
        }
      }
      if (farthest !== null && (farthestDist === 1 || farthestDist === 2)) {
        this.commitSlideReturn(this.scrollOffset + startLocal, startLane, farthest);
        return;
      }
    }

    // Cross-lane drag → slide. Anchored to the START cell's step; the
    // current cell's lane is the target. 1-lane and 2-lane slides are
    // both valid (with 3 lanes total, that's the full range).
    if (currentLane !== startLane) {
      this.commitSlide(this.scrollOffset + startLocal, startLane, currentLane);
      return;
    }
    // Same-lane: tap toggle (no drag) or hold (drag to different cell).
    if (startLocal === currentLocal) {
      this.toggleCell(startLocal, startLane);
      return;
    }
    const aLocal = Math.min(startLocal, currentLocal);
    const bLocal = Math.max(startLocal, currentLocal);
    this.commitHold(this.scrollOffset + aLocal, this.scrollOffset + bLocal, startLane);
  };

  private resetDrag(): void {
    this.dragStartLocal = null;
    this.dragStartLane = null;
    this.dragCurrentLocal = null;
    this.dragVisitedLanes.clear();
    this.dragCurrentLane = null;
  }

  private findHoldAtCell(modelStep: number, lane: LaneId): Hold | null {
    if (!this.chart.holds) return null;
    for (const h of this.chart.holds) {
      if (h.lane !== lane) continue;
      if (modelStep >= h.startStep && modelStep <= h.endStep) return h;
    }
    return null;
  }

  private removeHold(hold: Hold): void {
    if (!this.chart.holds) return;
    const idx = this.chart.holds.indexOf(hold);
    if (idx >= 0) this.chart.holds.splice(idx, 1);
  }

  private commitHold(startStep: number, endStep: number, lane: LaneId): void {
    // Refuse if either edge falls in the unplayable zone past cutoff.
    if (startStep >= this.getCutoffStep() || endStep >= this.getCutoffStep()) return;
    // Same-lane overlap → silently refuse. The drag completes but no
    // hold is committed. Cross-lane is fine (different array entries).
    if (this.chart.holds?.some(
      (h) => h.lane === lane && !(endStep < h.startStep || startStep > h.endStep),
    )) {
      return;
    }
    // Symmetric finger-conflict rule: if any existing slide's path
    // (source + target, + middle for 2-lane jumps) passes through THIS
    // lane while the hold is active, the hold can't be placed — same
    // physical impossibility commitSlide enforces in the other direction.
    if (this.chart.slides?.some((s) => {
      if (s.startStep < startStep || s.startStep > endStep) return false;
      const touched = lanesTouchedBySlide(s.sourceLane, s.targetLane);
      return touched.includes(lane);
    })) {
      return;
    }
    // Strip any conflicting tap notes inside the hold's range so the
    // schema invariant (taps + holds are disjoint per cell) holds.
    for (let s = startStep; s <= endStep; s++) {
      const step = this.chart.steps[s];
      if (!step) continue;
      const idx = step.lanes.indexOf(lane);
      if (idx >= 0) step.lanes.splice(idx, 1);
    }
    if (!this.chart.holds) this.chart.holds = [];
    this.chart.holds.push({ lane, startStep, endStep });
    this.refreshPage();
  }

  private findSlideAtCell(modelStep: number, lane: LaneId): Slide | null {
    if (!this.chart.slides) return null;
    for (const s of this.chart.slides) {
      if (s.startStep === modelStep && s.sourceLane === lane) return s;
    }
    return null;
  }

  private removeSlide(slide: Slide): void {
    if (!this.chart.slides) return;
    const idx = this.chart.slides.indexOf(slide);
    if (idx >= 0) this.chart.slides.splice(idx, 1);
  }

  private findSlideReturnAtCell(modelStep: number, lane: LaneId): SlideReturn | null {
    if (!this.chart.slideReturns) return null;
    for (const sr of this.chart.slideReturns) {
      if (sr.startStep === modelStep && sr.sourceLane === lane) return sr;
    }
    return null;
  }

  private removeSlideReturn(sr: SlideReturn): void {
    if (!this.chart.slideReturns) return;
    const idx = this.chart.slideReturns.indexOf(sr);
    if (idx >= 0) this.chart.slideReturns.splice(idx, 1);
  }

  private commitSlideReturn(startStep: number, sourceLane: LaneId, targetLane: LaneId): void {
    if (sourceLane === targetLane) return;
    const span = Math.abs(sourceLane - targetLane);
    if (span !== 1 && span !== 2) return; // 1-lane (adjacent) or 2-lane (0↔2)
    if (startStep >= this.getCutoffStep()) return;
    // Refuse if a slide OR slide-return already exists at this source cell.
    if (this.chart.slides?.some(
      (s) => s.startStep === startStep && s.sourceLane === sourceLane,
    )) return;
    if (this.chart.slideReturns?.some(
      (s) => s.startStep === startStep && s.sourceLane === sourceLane,
    )) return;
    // Same finger-conflict rule as regular slide: every lane the gesture
    // touches (source + target, + middle for 2-lane variants) must be
    // hold-free at startStep.
    const involved: LaneId[] = span === 2 ? [sourceLane, 1, targetLane] : [sourceLane, targetLane];
    if (this.chart.holds?.some(
      (h) => involved.includes(h.lane) && startStep >= h.startStep && startStep <= h.endStep,
    )) return;
    // Strip any conflicting tap on the source cell so the schema stays clean.
    const step = this.chart.steps[startStep];
    if (step) {
      const idx = step.lanes.indexOf(sourceLane);
      if (idx >= 0) step.lanes.splice(idx, 1);
    }
    if (!this.chart.slideReturns) this.chart.slideReturns = [];
    this.chart.slideReturns.push({ startStep, sourceLane, targetLane });
    this.refreshPage();
  }

  private refreshSlideReturns(): void {
    if (!this.chart.slideReturns || this.chart.slideReturns.length === 0) return;
    const visibleStart = this.scrollOffset;
    const visibleEnd = this.scrollOffset + EDITOR_VISIBLE_ROWS - 1;
    for (const sr of this.chart.slideReturns) {
      if (sr.startStep < visibleStart || sr.startStep > visibleEnd) continue;
      const localStep = sr.startStep - visibleStart;
      const cy = this.gridTop + localStep * this.cellH + this.cellH / 2;
      const srcX = this.colCenterXs[sr.sourceLane]!;
      const tgtX = this.colCenterXs[sr.targetLane]!;
      const srcTint = darkenTowardBlack(this.laneTints[sr.sourceLane]!, 0.18);
      const tgtTint = darkenTowardBlack(this.laneTints[sr.targetLane]!, 0.18);
      // Tube + head — same construction as a regular slide.
      const tubeThickness = 40;
      const tubeLen = Math.abs(tgtX - srcX);
      const tubeMidX = (srcX + tgtX) / 2;
      const tube = this.add.image(tubeMidX, cy, AssetKeys.Image.PspspsTubeWhite);
      tube.setDisplaySize(tubeThickness, tubeLen);
      tube.setRotation(Math.PI / 2);
      const topColor = sr.targetLane > sr.sourceLane ? tgtTint : srcTint;
      const bottomColor = sr.targetLane > sr.sourceLane ? srcTint : tgtTint;
      tube.setTint(topColor, topColor, bottomColor, bottomColor);
      tube.setDepth(38);
      this.root.add(tube);
      this.holdGraphics.push(tube);
      const headSize = Math.min(this.cellW - 4, this.cellH + 2, 56);
      const head = this.add.image(srcX, cy, AssetKeys.Image.PspspsTargetWhite);
      head.setDisplaySize(headSize, headSize);
      head.setTint(srcTint);
      head.setDepth(40);
      this.root.add(head);
      this.holdGraphics.push(head);
      // Two-sided arrow at the TARGET end — signals out-and-back motion.
      const arrowGlyph = sr.targetLane > sr.sourceLane ? '◀▶' : '◀▶';
      const arrow = this.add.text(
        tgtX + (sr.targetLane > sr.sourceLane ? -14 : 14),
        cy,
        arrowGlyph,
        {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '14px',
          color: '#ffd34d',
          stroke: '#1a0a2e',
          strokeThickness: 3,
        },
      ).setOrigin(0.5).setDepth(41);
      this.root.add(arrow);
      this.holdGraphics.push(arrow);
    }
  }

  private commitSlide(startStep: number, sourceLane: LaneId, targetLane: LaneId): void {
    if (sourceLane === targetLane) return;
    if (startStep >= this.getCutoffStep()) return;
    // Refuse if a slide already exists at this source cell.
    if (this.chart.slides?.some(
      (s) => s.startStep === startStep && s.sourceLane === sourceLane,
    )) return;
    // Refuse if ANY lane the slide's finger traverses (source + target,
    // plus middle for 2-lane jumps) has an active hold at startStep —
    // the busy finger physically can't perform the drag.
    const touched = lanesTouchedBySlide(sourceLane, targetLane);
    if (this.chart.holds?.some(
      (h) => touched.includes(h.lane) && startStep >= h.startStep && startStep <= h.endStep,
    )) return;
    // Strip any conflicting tap on the source cell so the schema stays clean.
    const step = this.chart.steps[startStep];
    if (step) {
      const idx = step.lanes.indexOf(sourceLane);
      if (idx >= 0) step.lanes.splice(idx, 1);
    }
    if (!this.chart.slides) this.chart.slides = [];
    this.chart.slides.push({ startStep, sourceLane, targetLane });
    this.refreshPage();
  }

  private refreshSlides(): void {
    if (!this.chart.slides || this.chart.slides.length === 0) return;
    const visibleStart = this.scrollOffset;
    const visibleEnd = this.scrollOffset + EDITOR_VISIBLE_ROWS - 1;
    for (const slide of this.chart.slides) {
      if (slide.startStep < visibleStart || slide.startStep > visibleEnd) continue;
      const localStep = slide.startStep - visibleStart;
      const cy = this.gridTop + localStep * this.cellH + this.cellH / 2;
      const srcX = this.colCenterXs[slide.sourceLane]!;
      const tgtX = this.colCenterXs[slide.targetLane]!;
      const srcTint = darkenTowardBlack(this.laneTints[slide.sourceLane]!, 0.18);
      const tgtTint = darkenTowardBlack(this.laneTints[slide.targetLane]!, 0.18);

      // Sideways tube — match the game's rendering exactly: rotate 90°
      // and use displaySize(thickness, tubeLen) so the capsule shape
      // stays proportional and the bar spans the FULL distance from
      // source to target (the natural-vertical PSTube image has
      // transparent padding that would shrink the visible bar if we
      // stretched it horizontally without rotation). Per-vertex tint
      // paints the source→target lane gradient. After 90° CW rotation:
      // image TOP → screen RIGHT, BOTTOM → screen LEFT.
      const tubeThickness = 40;
      const tubeLen = Math.abs(tgtX - srcX);
      const tubeMidX = (srcX + tgtX) / 2;
      const tube = this.add.image(tubeMidX, cy, AssetKeys.Image.PspspsTubeWhite);
      tube.setDisplaySize(tubeThickness, tubeLen);
      tube.setRotation(Math.PI / 2);
      const topColor = slide.targetLane > slide.sourceLane ? tgtTint : srcTint;
      const bottomColor = slide.targetLane > slide.sourceLane ? srcTint : tgtTint;
      tube.setTint(topColor, topColor, bottomColor, bottomColor);
      tube.setDepth(38);
      this.root.add(tube);
      this.holdGraphics.push(tube);

      // Head fuzzball at source lane.
      const headSize = Math.min(this.cellW - 4, this.cellH + 2, 56);
      const head = this.add.image(srcX, cy, AssetKeys.Image.PspspsTargetWhite);
      head.setDisplaySize(headSize, headSize);
      head.setTint(srcTint);
      head.setDepth(40);
      this.root.add(head);
      this.holdGraphics.push(head);

      // Arrow at the target end of the tube — chevron text pointing
      // toward the target lane.
      const arrow = this.add.text(
        tgtX + (slide.targetLane > slide.sourceLane ? -10 : 10),
        cy,
        slide.targetLane > slide.sourceLane ? '▶' : '◀',
        {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '16px',
          color: '#ffd34d',
          stroke: '#1a0a2e',
          strokeThickness: 3,
        },
      ).setOrigin(0.5).setDepth(41);
      this.root.add(arrow);
      this.holdGraphics.push(arrow);
    }
  }

  private refreshHolds(): void {
    for (const g of this.holdGraphics) g.destroy();
    this.holdGraphics = [];
    if (!this.chart.holds || this.chart.holds.length === 0) return;

    const visibleStart = this.scrollOffset;
    const visibleEnd = this.scrollOffset + EDITOR_VISIBLE_ROWS - 1;

    for (const hold of this.chart.holds) {
      if (hold.endStep < visibleStart || hold.startStep > visibleEnd) continue;

      const showStart = Math.max(hold.startStep, visibleStart);
      const showEnd = Math.min(hold.endStep, visibleEnd);
      const localStart = showStart - visibleStart;
      const localEnd = showEnd - visibleStart;

      const cx = this.colCenterXs[hold.lane]!;
      const tint = darkenTowardBlack(this.laneTints[hold.lane]!, 0.18);

      // Head at the BOTTOM of the visible hold range (= endStep cell)
      // to mirror the in-game look: fuzzball at the catching position,
      // tail extending up. If endStep is past the visible window, no
      // head here — the tail just fills the visible portion.
      const headInView = hold.endStep <= visibleEnd;
      const headY = this.gridTop + localEnd * this.cellH + this.cellH / 2;
      const headSize = Math.min(this.cellW - 4, this.cellH + 2, 56);

      // Tail body + cap — same two-piece TileSprite-body + Image-cap
      // pattern the game uses so the editor preview reads the same way.
      // Width matches the TailBody tile width (44) so the TileSprite
      // shows the full tile (both fuzzy edges) without horizontal
      // cropping — otherwise the body looks left-shifted vs the head.
      // Cap aspect = 44:32 to match the source.
      const tailWidth = 44;
      const capH = 32;
      const yTop = this.gridTop + localStart * this.cellH + 2;
      const yBottom = headInView
        ? headY
        : this.gridTop + (localEnd + 1) * this.cellH - 2;
      const totalH = yBottom - yTop;
      if (totalH > 0) {
        const bodyH = Math.max(0, totalH - capH);
        if (bodyH > 0) {
          const body = this.add.tileSprite(
            cx, yBottom, tailWidth, bodyH, AssetKeys.Image.TailBody,
          );
          body.setOrigin(0.5, 1);
          body.setTint(tint);
          body.setDepth(38);
          this.root.add(body);
          this.holdGraphics.push(body);
        }
        const cap = this.add.image(cx, yTop + capH, AssetKeys.Image.TailCap);
        cap.setOrigin(0.5, 1);
        cap.setDisplaySize(tailWidth, capH);
        cap.setTint(tint);
        cap.setDepth(38);
        this.root.add(cap);
        this.holdGraphics.push(cap);
      }

      if (headInView) {
        const head = this.add.image(cx, headY, AssetKeys.Image.PspspsTargetWhite);
        head.setDisplaySize(headSize, headSize);
        head.setTint(tint);
        head.setDepth(40);
        this.root.add(head);
        this.holdGraphics.push(head);
      }
    }
  }

  private refreshPage(): void {
    const cutoffStep = this.getCutoffStep();
    for (let localStep = 0; localStep < EDITOR_VISIBLE_ROWS; localStep++) {
      const modelStep = this.scrollOffset + localStep;
      const step = this.chart.steps[modelStep];
      // Cells beyond the end of the chart render empty + dim (no note,
      // panel still visible but greyed out so the author sees where the
      // chart "ends"). Cells past the round-end cutoff get a translucent
      // red wash so authors see which rows won't actually play.
      const beyondChart = modelStep >= this.chart.stepCount;
      const restricted = !beyondChart && modelStep >= cutoffStep;
      for (let lane = 0; lane < L.LANE_COUNT; lane++) {
        const note = this.cellNotes[localStep]![lane]!;
        const active = step?.lanes.includes(lane as LaneId) ?? false;
        note.setVisible(active);
        note.setScale(1);
        const panel = this.cellPanels[localStep]![lane]!;
        panel.setAlpha(beyondChart ? 0.18 : 1);
        // Repaint the panel fill: transparent for normal cells; red
        // translucent for restricted; cell stroke + interactivity stay
        // the same so authors can still see the grid + try tapping
        // (taps just silently no-op).
        if (restricted) {
          panel.setFillStyle(0xff4444, 0.22);
        } else {
          panel.setFillStyle(0x000000, 0);
        }
      }
    }
    // Page break labels — top label = the page sitting at the top of
    // the visible view; mid label = the page after that. Hide mid label
    // when its page is past the chart's end.
    const totalPages = Math.max(1, Math.ceil(this.chart.stepCount / CHART_PAGE_SIZE));
    const topPage = Math.floor(this.scrollOffset / CHART_PAGE_SIZE) + 1;
    const midPage = topPage + 1;
    if (this.pageBreakTopLabel) {
      this.pageBreakTopLabel.setText(`PAGE ${topPage}`);
    }
    if (this.pageBreakMidLabel) {
      if (midPage <= totalPages) {
        this.pageBreakMidLabel.setText(`PAGE ${midPage}`);
        this.pageBreakMidLabel.setVisible(true);
        this.pageBreakMidLine?.setVisible(true);
      } else {
        this.pageBreakMidLabel.setVisible(false);
        this.pageBreakMidLine?.setVisible(false);
      }
    }
    this.refreshHolds();
    this.refreshSlides();
    this.refreshSlideReturns();
    this.refreshPageLabel();
  }

  private refreshPageLabel(): void {
    // Current page = the page sitting at the TOP of the visible 2-page
    // view. Total pages = chart.stepCount / CHART_PAGE_SIZE.
    const page = Math.floor(this.scrollOffset / CHART_PAGE_SIZE) + 1;
    const totalPages = Math.max(1, Math.ceil(this.chart.stepCount / CHART_PAGE_SIZE));
    this.pageLabel.setText(`${page} / ${totalPages}`);
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
    if (this.chart.holds) this.chart.holds = [];
    if (this.chart.slides) this.chart.slides = [];
    if (this.chart.slideReturns) this.chart.slideReturns = [];
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

