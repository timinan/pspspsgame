import { Scene, Scenes } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { Cat } from '@/entities/cat';
import { Note } from '@/entities/note';
import { liftTowardWhite, LANE_BRIGHTNESS_LIFT } from '@/entities/note-colors';
import { BackgroundManager } from '@/entities/background-manager';
import { ChartPlayer } from '@/systems/chart-player';
import { ScoreSystem } from '@/systems/score-system';
import { MusicSystem } from '@/systems/music-system';
import { TopHud } from '@/ui/top-hud';
import * as L from '@/constants/scene-layout';
import { AssetKeys } from '@/constants/assets';
import { Balance } from '@/constants/balance';
import { fetchState, loadChart } from '@/services/state-client';
import { CAT_CATALOG, emptyChart, CHART_PAGE_SIZE } from '@/../shared/state';
import { resolveLaneTintsFromSeatedCats } from '@/constants/cat-colors';
import type { PlayerState, LaneId, Chart, SeatId } from '@/../shared/state';
import type { CatModel } from '@/types/game';
import { generateChart, type GenDifficulty } from '@/../shared/chart-generator';
import { GenerateModal } from '@/ui/generate-modal';
import { SongPickerModal, type SongPickerResult } from '@/ui/song-picker-modal';
import { DifficultyPickerModal } from '@/ui/difficulty-picker-modal';
import { SettingsModal } from '@/ui/settings-modal';
import { CommentComposeModal } from '@/ui/comment-compose-modal';
import { PublishedModal } from '@/ui/published-modal';
import { publishChart } from '@/services/publish-client';
import { CAT_EFFECT_BY_ID, isEffectCosmeticId } from '@/effects/cat-effects';
import { getUserSettings } from '@/systems/user-settings';
import { submitPlay } from '@/services/social-client';
import { getBest, recordRun, type BestStats, type StatKey } from '@/services/rehearsal-best';
import {
  classifyScore,
  rewardWithComment,
  type PlaySummary,
  type GiftPayload,
} from '@/../shared/social-loop';

/**
 * Phase 5 Game scene — vertical lane rhythm gameplay.
 *
 * Layout (design space 320×580):
 *   0–36     TopHud strip
 *   36–226   Cat stage (3 cats seated above lanes)
 *   226–510  Lane playfield (3 vertical lanes)
 *   510–580  Bottom HUD (Task 11 wires score/combo)
 *
 * Tasks 10–11 wire ChartPlayer to real note spawning, hit detection,
 * cat reactions, and the post-round summary overlay.
 */
export class Game extends Scene {
  private playerState: PlayerState | null = null;
  // When true, this round was launched from ChartEditor's TRY button. UI
  // wording + return paths swap: Ready modal calls it a "test", Summary
  // routes both buttons back to the editor, and the TopHud drawer adds a
  // "← EDITOR" entry for mid-round bail.
  private testMode = false;
  /** True when the player landed here from a VisitPost splash (someone
   *  else's posted show). Re-enables Post Comment + finalizePlay path
   *  that's otherwise dormant in plain drawer rehearsal. */
  private visitorMode = false;
  /** Owner of the post being visited — used as the chart's authorId
   *  when the player submits a play. Empty string in non-visitor flows. */
  private visitOwnerUsername = '';
  /** Reddit postId of the post being visited — used to scope the
   *  leaderboard + inbox events server-side. */
  private visitPostId = '';
  private bg!: BackgroundManager;
  private cats: Cat[] = [];
  /** Name labels rendered below each seated cat (matches Decorate preview). */
  private seatedNameLabels: Phaser.GameObjects.Text[] = [];
  private laneRects: Phaser.GameObjects.Rectangle[] = [];
  /** Resolved tint trio for the active background — per-bg sampled colors
   *  if `bg-lane-colors.json` has an entry, otherwise the global default.
   *  Set in `drawLanes`, read by `flashTarget` (so post-tap reset uses
   *  the same color the lane started with) and by the spawner (so falling
   *  notes match their lane's target). */
  private laneTints: readonly [number, number, number] = L.LANE_COLORS;
  /** Hit targets per lane — kept separate so we can flash them on hit/miss. */
  private hitTargets: Phaser.GameObjects.Image[] = [];
  /** Base scale of each hit target so flashTarget can always reset to it
   *  instead of compounding off whatever the previous (possibly killed mid-yoyo)
   *  tween left behind. setDisplaySize sets a non-1 scale, so we capture it. */
  private hitTargetBaseScale: number[] = [];
  /** Per-lane pause flag for the BPM target pulse. tickTargetPulse skips
   *  any lane currently mid-flash so the hit/miss snap-pop tween owns the
   *  scale/alpha channels without interference. Cleared in onComplete. */
  private targetPulseFlashing: boolean[] = [false, false, false];
  /** Per-lane equipped effect cosmetic type id (e.g. 'effect-red-glow').
   *  Populated by seatCats from the seated cat's equipped cosmetics so
   *  flashLaneEffect can spawn a brief burst of the cat's own aura/
   *  particles on the hit target whenever the player lands a hit. */
  private laneEffects: (string | null)[] = [null, null, null];
  private tapZones: Phaser.GameObjects.Rectangle[] = [];
  private notes: Note[] = [];
  /** Shared GeometryMask that clips hold-note tails to the lane band
   *  [LANE_TOP_Y, HIT_LINE_Y]. Built once in create(), applied per
   *  spawn so the pill renders inside the lane only — no leak into
   *  the cat-stage area above, no draw below the catching position. */
  private holdLaneMask?: Phaser.Display.Masks.GeometryMask;
  private hud!: TopHud;
  private player!: ChartPlayer;
  private score!: ScoreSystem;
  /** Step-1 audio system. Reads the same chart ChartPlayer plays back and
   *  fires a pitched meow on every active step. Starts on the player's
   *  first lane tap (mobile / iframe audio context unlock). */
  private music: MusicSystem | null = null;
  private startTimeMs = 0;
  private roundOver = false;
  /** Set once endRound's auto-record path fires submitPlay. Stops a
   *  later POST/SKIP from the comment modal from double-submitting
   *  the same round (the leaderboard write is PB-idempotent anyway,
   *  but the inbox event would duplicate). */
  private playSubmitted = false;
  /** True between scene boot and the round actually starting. While set,
   *  update() skips chart advance and the lane tap zones are disabled.
   *  Cleared by beginRound() once the song has been resolved + music has
   *  started. */
  private pendingStart = true;
  private generateModal: GenerateModal | null = null;
  private settingsModal: SettingsModal | null = null;
  private commentModal: CommentComposeModal | null = null;
  private publishedModal: PublishedModal | null = null;
  /** Locks the PUT ON A SHOW button while a publish request is in flight
   *  so a double-tap doesn't fire two reddit.submitCustomPost calls. */
  private publishBusy = false;
  /** Chart step the round should START playing from. Editor rehearse
   *  sets this to its current page so the author lands on the section
   *  they were authoring. Plain Rehearse always uses 0. */
  private initialStartStep = 0;
  private songPicker: SongPickerModal | null = null;
  private difficultyPicker: DifficultyPickerModal | null = null;
  /** Carries the song picked in step 1 through to step 2 so the
   *  difficulty modal's START can stamp the chart with the right
   *  audioKey + bpm + vibe in one go. */
  private pendingSong: SongPickerResult | null = null;
  /** Two-piece pill (rect + text) shown in the top-right while testMode
   *  is true. Cleaned up in doCleanup so it doesn't leak into the next
   *  scene if the player taps it mid-tween. */
  private backToChartChip: Phaser.GameObjects.GameObject[] = [];

  // -----------------------------------------------------------------------
  // Live hit / miss feedback (one floating "PERFECT" / "GREAT" / "MISS"
  // text per lane, reused on every tap; one centered combo callout).
  // -----------------------------------------------------------------------
  private hitFeedbackTexts: Phaser.GameObjects.Text[] = [];
  private comboText!: Phaser.GameObjects.Text;

  // Summary overlay — built once in create(), shown by endRound()
  private summary: Phaser.GameObjects.Container | null = null;
  private summaryScoreText!: Phaser.GameObjects.Text;
  private summaryAccuracyText!: Phaser.GameObjects.Text;
  private summaryComboText!: Phaser.GameObjects.Text;
  private summaryMissesText!: Phaser.GameObjects.Text;
  private summaryHitsText!: Phaser.GameObjects.Text;
  /** Right-side primary button on the summary (POST or PUT ON A SHOW).
   *  Held so showSummary() can grey it out when the player rehearsed
   *  below the pass threshold. */
  private summaryRightBg!: Phaser.GameObjects.Rectangle;
  private summaryRightText!: Phaser.GameObjects.Text;
  /** Pass/fail blurb shown only in test mode when accuracy is below
   *  Balance.passAccuracyPct. Empty + invisible otherwise. */
  private summaryGateText!: Phaser.GameObjects.Text;
  /** Per-stat personal-best row — sits below the current stats row with
   *  a thin divider between. Mirrors the 4-col layout (accuracy / max
   *  combo / hits / misses) in smaller text. Score's best lives as a
   *  small caption under the big FINAL SCORE number. Each cell flips to
   *  mint when the just-finished run beat the stored value for that
   *  stat. Hidden on charts without (audioKey + difficulty). */
  private summaryBestDivider!: Phaser.GameObjects.Rectangle;
  private summaryBestLabel!: Phaser.GameObjects.Text;
  private summaryBestAccuracyText!: Phaser.GameObjects.Text;
  private summaryBestComboText!: Phaser.GameObjects.Text;
  private summaryBestHitsText!: Phaser.GameObjects.Text;
  private summaryBestMissesText!: Phaser.GameObjects.Text;
  /** Centered best score below the 4 per-stat values — bigger than the
   *  per-stat numbers (highlights the headline result) but smaller than
   *  the big FINAL SCORE above so it still reads as "previous best, not
   *  the run you just finished". */
  private summaryBestScoreBig!: Phaser.GameObjects.Text;
  /** Summary title — swapped between 'SHOW COMPLETE!' and
   *  'SHOW FAILED' based on the rehearsal pass gate. */
  private summaryTitleText!: Phaser.GameObjects.Text;

  // Page boundary tracking — cached chart timing so update() can spawn
  // falling page-boundary lines at the right step crossings without
  // touching ChartPlayer internals.
  private playChart: Chart | null = null;
  private playMsPerStep = 0;
  private playPagesPerLoop = 1;
  private lastEmittedPageBoundary = 0;

  constructor() {
    super(SceneKeys.Game);
  }

  init(data: {
    playerState?: PlayerState | null;
    testMode?: boolean;
    startStep?: number;
    visitorMode?: boolean;
    visitOwnerUsername?: string;
    visitPostId?: string;
  }): void {
    this.playerState = data?.playerState ?? null;
    this.testMode = data?.testMode === true;
    this.visitorMode = data?.visitorMode === true;
    this.visitOwnerUsername = data?.visitOwnerUsername ?? '';
    this.visitPostId = data?.visitPostId ?? '';
    // Editor passes its current scrollOffset here so rehearsal starts
    // at the author's working page (chart + music both seek). Defaults
    // to 0 = start at the top.
    this.initialStartStep = typeof data?.startStep === 'number' ? Math.max(0, data.startStep) : 0;
    this.cats = [];
    this.seatedNameLabels = [];
    this.laneRects = [];
    this.hitTargets = [];
    this.hitTargetBaseScale = [];
    this.tapZones = [];
    this.notes = [];
    this.laneEffects = [null, null, null];
    this.hitFeedbackTexts = [];
    this.roundOver = false;
    this.playSubmitted = false;
    this.startTimeMs = 0;
    this.cleanedUp = false;
    this.music = null;
    this.pendingStart = true;
    this.playChart = null;
    this.playMsPerStep = 0;
    this.playPagesPerLoop = 1;
    this.lastEmittedPageBoundary = 0;
  }

  async create(): Promise<void> {
    // Reset score per round
    this.score = new ScoreSystem();

    // Background — read from playerState (same source as Decorate). The
    // registry fallback drifted from Decorate's playerState.activeBackground
    // so the player saw two different backgrounds across screens.
    this.bg = new BackgroundManager(this);
    this.bg.create();
    const activeBg = this.playerState?.activeBackground ?? 'stage';
    this.bg.setBackground(activeBg);

    this.drawLanes();
    this.holdLaneMask = this.buildHoldLaneMask();
    this.seatCats();
    this.buildHud();
    this.buildFeedback();
    this.buildFpsOverlay();
    this.buildSummaryOverlay();
    this.updateHud();

    // Pre-warm note pool — avoids allocations during first 18 spawns.
    // Longer fall time + extension past the screen means more notes are
    // alive at once. Was 12; bumped after notes started "vanishing" on
    // longer sessions because the pool was being grown ad-hoc mid-play.
    for (let i = 0; i < 18; i++) {
      const n = new Note(this);
      this.add.existing(n);
      this.notes.push(n);
    }

    this.bindInput();
    // Tap zones live but disabled until PLAY is pressed. The modal
    // re-enables them in its onPlay handler.
    for (const z of this.tapZones) z.disableInteractive();

    this.events.on(Scenes.Events.SHUTDOWN, () => this.cleanup());

    // Chart-availability gate. ANY of these counts as "we have a chart,
    // run the round" — checked in priority order, same as
    // initChartPlayer's priority chain:
    //   1. registry.hostChart — set by VisitPost when an owner taps PLAY
    //      on their own post (or a visitor on someone else's). This was
    //      the missing case: VisitPost stamped the chart on the
    //      registry but the gate only looked at playerState.chart, so
    //      Game fell through to showSongPicker even though the chart
    //      was sitting right there.
    //   2. playerState.chart with notes — Drawer REHEARSE path.
    const registryChart = this.registry.get('hostChart') as Chart | undefined;
    const hasRegistryChart = registryChart?.steps?.some((s) => s.lanes.length > 0);
    const hasStateChart = this.playerState?.chart?.steps?.some((s) => s.lanes.length > 0);

    if (this.testMode) {
      // Editor → REHEARSE path: chart is already authored. Tim's rule:
      // hitting REHEARSE in the editor starts the round immediately —
      // no Ready modal. We wire the chart + music + kick beginRound the
      // moment the scene boots.
      await this.initChartPlayer();
      void this.beginRound();
    } else if (hasRegistryChart || hasStateChart) {
      // Drawer REHEARSE or visitor PLAY: chart is in hand, run it.
      await this.initChartPlayer();
      void this.beginRound();
    } else {
      // Fresh Rehearse entry with no authored chart yet: two-step picker.
      // SongPicker (vibe → song list → preview + select) →
      // DifficultyPicker (easy/normal/hard → START) → generate a chart
      // at that song + difficulty, set chart.audioKey so MusicSystem
      // locks to the picked backing, attach + begin the round.
      this.showSongPicker();
    }
  }

  override update(_time: number, delta: number): void {
    this.updateFpsOverlay();
    if (this.pendingStart || this.roundOver) return;
    this.player.advance(delta);
    this.tickHolds();
    this.updateHoldVisuals();
    this.checkMisses();
    this.tickPageTracking();
    this.tickTargetPulse();
    // Wall-clock is the sole end signal. `initChartPlayer` already loops
    // the chart enough times to comfortably fill the cap — `isFinished()`
    // is intentionally NOT checked so a short chart that runs out of
    // loops early would never end the round before the 30s cap.
    if (this.time.now - this.startTimeMs >= Balance.maxRoundMs) {
      this.endRound();
    }
  }

  /** Spawn page-boundary lines at SPAWN time so they fall with the
   *  notes and visually mark where the next page begins. Test mode
   *  only — rehearsing from the drawer doesn't get markers since the
   *  player didn't author the chart. Also gated on the user-settings
   *  showPageMarkers flag, so toggling PAGES off in the editor also
   *  hides the falling page lines during the very next rehearsal. */
  private tickPageTracking(): void {
    if (!this.testMode) return;
    if (!getUserSettings().showPageMarkers) return;
    if (!this.playChart || this.playMsPerStep <= 0) return;
    const elapsedMs = this.time.now - this.startTimeMs;
    const spawnStep = Math.floor(elapsedMs / this.playMsPerStep);
    const spawnPageBoundary = Math.floor(spawnStep / CHART_PAGE_SIZE);
    while (this.lastEmittedPageBoundary < spawnPageBoundary) {
      this.lastEmittedPageBoundary += 1;
      // Don't emit ANY page lines past the first loop's last page.
      // Tim's call: "if you have page numbers on at the end of the song
      // the page numbers repeats just get rid of the line after the
      // last page is supposed to end and dont have this repeat". The
      // chart loops 30s of round filler under the hood; without this
      // gate, every loop pass would re-emit pages 1..N.
      if (this.lastEmittedPageBoundary >= this.playPagesPerLoop) continue;
      const pageIdx = this.lastEmittedPageBoundary;
      // Skip page 0 — round start needs no marker.
      if (pageIdx === 0) continue;
      this.spawnPageBoundaryLine(pageIdx);
    }
  }

  // -----------------------------------------------------------------------
  // Private — layout
  // -----------------------------------------------------------------------

  /**
   * Draw 3 vertical lane backdrops + the original "fuzzy ball" hit target
   * for each lane. Reuses the Phase 1 rhythm assets (RhythmBarBackground,
   * MeowcertTarget) so the visuals match the rest of the game.
   */
  private drawLanes(): void {
    const { width, height } = this.scale;
    const scaleY = height / L.DESIGN_H;
    const laneTopY = L.LANE_TOP_Y * scaleY;
    const laneH = (L.LANE_BOTTOM_Y - L.LANE_TOP_Y) * scaleY;
    const hitLineY = L.HIT_LINE_Y * scaleY;

    const inner = width - L.LANE_GUTTER_PX * 2;
    const colW = (inner - L.LANE_GAP_PX * (L.LANE_COUNT - 1)) / L.LANE_COUNT;

    // Resolve the lane tint trio for the active background and cache on
    // the scene so flashTarget + spawnNote use the SAME colors. Per-bg
    // sampled colors win, fall back to the global LANE_COLORS default.
    // Sampled values come from `atlas/bg-lane-colors.json`.
    this.laneTints = this.resolveLaneTints();

    for (let i = 0; i < L.LANE_COUNT; i++) {
      const cx = L.laneCenterX(i as 0 | 1 | 2, width);
      const color = this.laneTints[i]!;

      // Lane backdrop: the original Phase 1 rhythm bar track rotated -90°
      // (was +90°, which rendered the track upside down — the texture's
      // "open" end pointed up instead of down). Pre-rotation
      // displayWidth/Height are swapped from the visual we want — after
      // rotation the texture's horizontal axis becomes the lane's vertical
      // axis. Alpha 0.55 lets the bg's floor read through (same translucent
      // treatment ChartEditor uses).
      const bar = this.add.image(cx, laneTopY + laneH / 2, AssetKeys.Image.RhythmBarBackgroundWhite);
      bar.displayWidth = laneH;
      bar.displayHeight = colW;
      bar.setRotation(-Math.PI / 2);
      // Pastel the lane (lift toward white) so the raw-color falling ball +
      // hit target read as the darker shape against a lighter wash. Easier
      // to spot than lifting the ball — same hue, just lower saturation.
      // Lane fill kept a touch translucent so the show bg ghosts
      // through behind the playfield, but bumped from 0.45 → 0.78 —
      // 0.45 was washing the cat color out completely.
      bar.setTint(liftTowardWhite(color, LANE_BRIGHTNESS_LIFT));
      bar.setAlpha(0.78);
      this.laneRects.push(bar as unknown as Phaser.GameObjects.Rectangle);

      // Hit target at the bottom of the lane — the original "fuzzy ball"
      // target from horizontal rhythm. Notes get consumed when they reach it.
      // Targets stay opaque (they need to read against the lane).
      const target = this.add.image(cx, hitLineY, AssetKeys.Image.MeowcertTargetWhite);
      target.setDisplaySize(72, 72);
      target.setTint(color);
      target.setDepth(6);
      this.hitTargets[i] = target;
      // Snapshot the base scale after setDisplaySize so flash tweens always
      // start from the same value instead of compounding off prior inflations.
      this.hitTargetBaseScale[i] = target.scaleX;
    }
  }

  /** Lane tints follow the seated cats: each lane takes the primary
   *  color of the cat on that seat. Empty seats inherit the color of
   *  the nearest occupied lane (so a lone cat colors all three lanes
   *  the same shade). Falls back to the bg-sampled or default trio
   *  when no cats are seated at all. */
  private resolveLaneTints(): readonly [number, number, number] {
    const fromCats = resolveLaneTintsFromSeatedCats(this.playerState);
    if (fromCats) return fromCats;
    const sampled = this.cache.json.get(AssetKeys.Json.BgLaneColors) as
      | Record<string, [string, string, string]>
      | undefined;
    const activeBg = this.playerState?.activeBackground ?? 'stage';
    const trio = sampled?.[activeBg];
    if (!trio || trio.length !== 3) return L.LANE_COLORS;
    return trio.map((hex) => parseInt(hex.replace('#', ''), 16)) as unknown as readonly [number, number, number];
  }

  /**
   * Seat up to 3 cats above the lanes in the cat-stage band.
   * Reads from `playerState.seatedCats`, falls back to a fresh fetchState
   * if `playerState` wasn't passed. Positions cats at laneCenterX(i)
   * horizontally and in the vertical center of the cat-stage band.
   */
  private seatCats(): void {
    const { width, height } = this.scale;
    const scaleY = height / L.DESIGN_H;
    // Cats are scaled up 1.4× so they read at the same visual weight as the
    // 72px lane targets. Anchor (origin 0.5, 1) is bottom-center, so to
    // move them up we just lower the catY value. 0.78 (vs the previous
    // 0.88) plus the taller scaled sprite keeps their feet clear of the
    // lane top while shifting their bodies up into the cat-stage band.
    const catY = (L.TOP_HUD_H + L.CAT_STAGE_H * 0.78) * scaleY;
    const CAT_SCALE = 1.4;

    const seatedCats = this.playerState?.seatedCats ?? {};
    // seatedCats maps seatId → cat instance id.
    const SEAT_ORDER: SeatId[] = ['seat-left', 'seat-center', 'seat-right'];

    // Iterate SEAT_ORDER directly so each cat renders in the lane that
    // matches its seat position. Filtering empty seats first and using the
    // filtered array index would put a lone 'seat-right' cat into lane 0.
    for (let i = 0; i < SEAT_ORDER.length; i++) {
      const seatId = SEAT_ORDER[i]!;
      const instanceId = seatedCats[seatId];
      if (!instanceId) continue;

      const catInstance = this.playerState?.ownedCats.find((cat) => cat.id === instanceId);
      if (!catInstance) continue;
      const catEntry = CAT_CATALOG.find((c) => c.id === catInstance.breed);
      if (!catEntry) continue;

      const laneIndex = i as 0 | 1 | 2;
      const cx = L.laneCenterX(laneIndex, width);

      const model: CatModel = {
        id: `lane-cat-${i}`,
        breed: catInstance.breed,
        animation: 'idle',
        restingAnimation: 'idle',
        x: cx,
        y: catY,
        scale: CAT_SCALE,
      };
      // Resolve cosmetic INSTANCE ids → catalog TYPE ids via the sidecar
      // before handing the model to Cat. Cat's renderer looks up
      // COSMETIC_CATALOG by type id; instance ids wouldn't match anything.
      const slots = this.playerState?.equippedCosmetics?.[instanceId];
      const typeMap = this.playerState?.equippedCosmeticTypes ?? {};
      if (slots && Object.keys(slots).length > 0) {
        const resolved: Partial<Record<string, string>> = {};
        for (const [slotKey, cosInstanceId] of Object.entries(slots)) {
          if (!cosInstanceId) continue;
          const typeId = typeMap[cosInstanceId];
          if (typeId) resolved[slotKey] = typeId;
        }
        if (Object.keys(resolved).length > 0) {
          model.equippedCosmetics = resolved;
        }
        // First effect cosmetic equipped on this cat wins for the lane.
        // Slots are unordered; we only ever spawn one effect per hit so a
        // cat with two effects equipped (rare, but possible) just picks
        // whichever shows up first.
        for (const typeId of Object.values(resolved)) {
          if (typeId && isEffectCosmeticId(typeId)) {
            this.laneEffects[laneIndex] = typeId;
            break;
          }
        }
      }

      const cat = new Cat(this, model);
      cat.setPosition(cx, catY);
      this.cats.push(cat);

      // Cat's custom name right under their feet so players can match the
      // lane they're tapping to the cat reacting above it.
      const nameLabel = this.add
        .text(cx, catY + 4, catInstance.name.toUpperCase(), {
          fontFamily: '"Courier New", monospace',
          fontStyle: 'bold',
          fontSize: '10px',
          color: '#ffffff',
          stroke: '#000000',
          strokeThickness: 3,
        })
        .setOrigin(0.5, 0);
      this.seatedNameLabels.push(nameLabel);
    }
  }

  /**
   * Pre-round modal — gates chart advance + tap input until the player
   * taps PLAY. The PLAY click is also the user gesture WebAudio needs
   * to unlock the audio context; Phaser's sound manager handles that
   * unlock transparently on the first user interaction.
   */
  private buildSummaryOverlay(): void {
    const { width, height } = this.scale;
    const scaleY = height / L.DESIGN_H;
    const cx = width / 2;
    // Center the panel inside the lane area instead of at the canvas
    // mid-point so the seated cats' end-round celebration stays visible
    // above it. Backdrop is clipped to the lane band for the same
    // reason — a full-canvas scrim would dim the cats too.
    const laneTopY = L.LANE_TOP_Y * scaleY;
    const laneBottomY = L.LANE_BOTTOM_Y * scaleY;
    const laneBandH = laneBottomY - laneTopY;
    const cy = laneTopY + laneBandH / 2;

    const container = this.add.container(0, 0).setDepth(300).setVisible(false);

    // Backdrop covers only the lane band — the cat-stage strip up top
    // stays untouched so the celebration animation reads clearly.
    const backdrop = this.add.rectangle(cx, cy, width, laneBandH, 0x000000, 0.7);
    container.add(backdrop);

    // Panel sized to fit cleanly inside the lane band on the 580px
    // design height. Trimmed from 300 → 280 so the score / stats /
    // buttons stack without any clip against the HIT_LINE region.
    const panelW = Math.min(280, width - 32);
    const panelH = Math.min(280, laneBandH - 12);
    const panel = this.add.rectangle(cx, cy, panelW, panelH, 0x1a0a2e, 1);
    panel.setStrokeStyle(2, 0xc678ff, 0.8);
    container.add(panel);

    const fontBase = { fontFamily: 'Pixeloid Sans, sans-serif' };

    // Title — defaults to the success copy; showSummary() overrides for
    // the test-mode fail case.
    this.summaryTitleText = this.add.text(cx, cy - 112, 'SHOW COMPLETE!', {
      ...fontBase,
      fontStyle: 'bold',
      fontSize: '13px',
      color: '#ffd34d',
    }).setOrigin(0.5, 0);
    container.add(this.summaryTitleText);

    // Divider line
    const divider = this.add.rectangle(cx, cy - 94, panelW - 32, 1, 0xc0a0e6, 0.3);
    container.add(divider);

    // Final score label + value
    const scoreLabel = this.add.text(cx, cy - 84, 'FINAL SCORE', {
      ...fontBase,
      fontSize: '10px',
      color: '#c0a0e6',
    }).setOrigin(0.5, 0);
    container.add(scoreLabel);

    this.summaryScoreText = this.add.text(cx, cy - 68, '0', {
      ...fontBase,
      fontStyle: 'bold',
      fontSize: '32px',
      color: '#ffffff',
    }).setOrigin(0.5, 0);
    container.add(this.summaryScoreText);

    // Stats row: accuracy / max combo / hits / misses. Four equal cols
    // so the player can read landed-vs-missed at a glance instead of
    // just inferring it from the percentage.
    const statsY = cy - 24;
    const statLabels = ['ACCURACY', 'MAX COMBO', 'HITS', 'MISSES'];
    const margin = 8;
    const slotW = (panelW - margin * 2) / 4;
    const statXs = statLabels.map((_, i) => cx - panelW / 2 + margin + slotW * (i + 0.5));

    for (let i = 0; i < statLabels.length; i++) {
      const lbl = this.add.text(statXs[i]!, statsY, statLabels[i]!, {
        ...fontBase,
        fontSize: '8px',
        color: '#c0a0e6',
      }).setOrigin(0.5, 0);
      container.add(lbl);
    }

    this.summaryAccuracyText = this.add.text(statXs[0]!, statsY + 14, '0%', {
      ...fontBase,
      fontStyle: 'bold',
      fontSize: '15px',
      color: '#4dffb4',
    }).setOrigin(0.5, 0);
    container.add(this.summaryAccuracyText);

    this.summaryComboText = this.add.text(statXs[1]!, statsY + 14, 'x0', {
      ...fontBase,
      fontStyle: 'bold',
      fontSize: '15px',
      color: '#ffd34d',
    }).setOrigin(0.5, 0);
    container.add(this.summaryComboText);

    this.summaryHitsText = this.add.text(statXs[2]!, statsY + 14, '0', {
      ...fontBase,
      fontStyle: 'bold',
      fontSize: '15px',
      color: '#a4ffb4',
    }).setOrigin(0.5, 0);
    container.add(this.summaryHitsText);

    this.summaryMissesText = this.add.text(statXs[3]!, statsY + 14, '0', {
      ...fontBase,
      fontStyle: 'bold',
      fontSize: '15px',
      color: '#ff6b6b',
    }).setOrigin(0.5, 0);
    container.add(this.summaryMissesText);

    // Buttons
    const btnY = cy + 100;
    const btnW = 110;
    const btnH = 38;
    const btnGap = 12;

    // Left button: "← Editor" in test mode (route back to ChartEditor),
    // "Play Again" in rehearsal (replay this exact chart).
    const leftLabel = this.testMode ? '← Editor' : 'Play Again';
    const leftBg = this.add.rectangle(
      cx - btnW / 2 - btnGap / 2, btnY, btnW, btnH, 0x2c1856, 1,
    ).setInteractive({ useHandCursor: true });
    leftBg.setStrokeStyle(1, 0xc0a0e6, 0.5);
    const leftText = this.add.text(
      cx - btnW / 2 - btnGap / 2, btnY, leftLabel, {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '14px',
        color: '#c0a0e6',
      },
    ).setOrigin(0.5);
    container.add([leftBg, leftText]);
    leftBg.on('pointerover', () => leftBg.setFillStyle(0x3d2566, 1));
    leftBg.on('pointerout', () => leftBg.setFillStyle(0x2c1856, 1));
    leftBg.on(
      'pointerdown',
      this.testMode ? this.onBackToEditorClicked : this.onPlayAgainClicked,
    );

    // Right button: "PUT ON A SHOW" in test mode (post the chart),
    // "Change Song" in rehearsal (back to the SongPicker). The Post
    // Comment / social-loop path is gone from rehearsal entirely —
    // rehearsal is single-player practice, social play lives elsewhere.
    // In test mode the right button hides entirely when the author
    // rehearsed below Balance.passAccuracyPct — they get auto-routed
    // back to the editor via the left button instead.
    // Right button label by mode:
    //   testMode (editor rehearsal) → 'PUT ON A SHOW' (publish flow)
    //   visitorMode (playing someone else's post) → 'Post Comment'
    //     (re-enables the dormant social-loop submit path)
    //   drawer rehearsal → 'Change Song' (back to song picker)
    const rightLabel = this.testMode
      ? 'PUT ON A SHOW'
      : this.visitorMode ? 'Post Comment' : 'Change Song';
    const rightBg = this.add.rectangle(
      cx + btnW / 2 + btnGap / 2, btnY, btnW, btnH, 0xffd34d, 1,
    ).setInteractive({ useHandCursor: true });
    const rightText = this.add.text(
      cx + btnW / 2 + btnGap / 2, btnY, rightLabel, {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '11px',
        color: '#1a0a2e',
        align: 'center',
        wordWrap: { width: btnW - 12 },
      },
    ).setOrigin(0.5);
    container.add([rightBg, rightText]);
    rightBg.on('pointerover', () => rightBg.setFillStyle(0xffe680, 1));
    rightBg.on('pointerout', () => rightBg.setFillStyle(0xffd34d, 1));
    rightBg.on('pointerdown', () => {
      if (this.testMode) this.onPostFromTestClicked();
      else if (this.visitorMode) this.onPostCommentClicked();
      else this.onChangeSongClicked();
    });
    this.summaryRightBg = rightBg;
    this.summaryRightText = rightText;

    // Per-stat personal-best section. Layout (top to bottom):
    //   1. Thin yellow divider just below the big stat values.
    //   2. "BEST" label centered just below the divider — sits clearly
    //      under the line so the row reads as a labeled block, not a
    //      label glued onto the line itself.
    //   3. Four small per-stat values (accuracy / max combo / hits /
    //      misses) in the same column X positions as the big values.
    //   4. Centered best-score number a step bigger than the per-stat
    //      values but still smaller than the BIG FINAL SCORE — reads
    //      as supporting context, not the headline result.
    // Per-cell coloring (showSummary fills these): default yellow,
    // mint when the just-finished run beat the stored value for that
    // stat. Hidden when the chart has no audioKey + difficulty.
    const bestDividerY = statsY + 30;
    this.summaryBestDivider = this.add
      .rectangle(cx, bestDividerY, panelW - 32, 1, 0xc0a0e6, 0.35)
      .setVisible(false);
    container.add(this.summaryBestDivider);

    this.summaryBestLabel = this.add
      .text(cx, bestDividerY + 6, 'BEST', {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '9px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5, 0)
      .setVisible(false);
    container.add(this.summaryBestLabel);

    const bestRowY = bestDividerY + 24;
    const bestFont = {
      ...fontBase,
      fontStyle: 'bold',
      fontSize: '11px',
      color: '#ffd34d',
    };
    this.summaryBestAccuracyText = this.add.text(statXs[0]!, bestRowY, '', bestFont).setOrigin(0.5).setVisible(false);
    this.summaryBestComboText = this.add.text(statXs[1]!, bestRowY, '', bestFont).setOrigin(0.5).setVisible(false);
    this.summaryBestHitsText = this.add.text(statXs[2]!, bestRowY, '', bestFont).setOrigin(0.5).setVisible(false);
    this.summaryBestMissesText = this.add.text(statXs[3]!, bestRowY, '', bestFont).setOrigin(0.5).setVisible(false);
    container.add([
      this.summaryBestAccuracyText,
      this.summaryBestComboText,
      this.summaryBestHitsText,
      this.summaryBestMissesText,
    ]);

    this.summaryBestScoreBig = this.add
      .text(cx, bestRowY + 14, '', {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '17px',
        color: '#ffd34d',
        align: 'center',
      })
      .setOrigin(0.5, 0)
      .setVisible(false);
    container.add(this.summaryBestScoreBig);

    // Pass/fail message that sits between the stats row and the buttons.
    // Anchored to the BOTTOM of its bounding box so the text grows
    // upward — keeps the bottom edge well clear of the buttons no matter
    // how many lines wrap. Visible only in test mode.
    this.summaryGateText = this.add
      .text(cx, btnY - 24, '', {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '9px',
        color: '#ff8b8b',
        align: 'center',
        lineSpacing: 1,
        wordWrap: { width: panelW - 18 },
      })
      .setOrigin(0.5, 1);
    container.add(this.summaryGateText);

    this.summary = container;
  }

  private buildHud(): void {
    this.hud = new TopHud(this, {
      showStats: true,
      showCoins: false,
      bigStats: this.testMode,
      // In test mode the player came from the editor's REHEARSE button,
      // so the drawer's "you are here" marker stays on PUT ON A SHOW
      // (= ChartEditor). Normal-mode rehearse marks REHEARSE.
      currentKey: this.testMode ? SceneKeys.ChartEditor : SceneKeys.Game,
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
        {
          label: 'SETTINGS',
          description: 'Tune effects + audio to taste',
          icon: '⚙️',
          onTap: () => this.openSettings(),
        },
      ],
    });

    // Test-mode escape hatch: a visible chip in the top-right (just left
    // of the hamburger trigger) that jumps straight back to the editor.
    // Hamburger nav still shows the same pages so the player has the
    // normal global nav too — this is the fast path for "I'm just
    // previewing my chart, get me out of here."
    if (this.testMode) this.buildBackToChartChip();
    else this.buildRehearsalControls();
  }

  /** Two stacked floating chips in the top-right during drawer-rehearse
   *  mode — BACK (exits to Decorate) and RESTART (in-place replay of
   *  the current chart). Mirrors the testMode "← EDITOR" chip's
   *  position so the escape-hatch surface is consistent across modes.
   *  Hidden in testMode (the BACK TO EDITOR chip covers that flow). */
  private buildRehearsalControls(): void {
    const { width } = this.scale;
    const padX = 10;
    const padY = TopHud.HEIGHT + 6;
    const chipW = 108;
    const chipH = 32;
    const gap = 6;
    const chipCx = width - padX - chipW / 2;

    // BACK chip — light-purple stroke to read as a navigation action.
    const backCy = padY + chipH / 2;
    const backBg = this.add
      .rectangle(chipCx, backCy, chipW, chipH, 0x1a0a2e, 0.95)
      .setStrokeStyle(2, 0xc678ff, 0.9)
      .setDepth(60)
      .setInteractive({ useHandCursor: true });
    const backTxt = this.add
      .text(chipCx, backCy, '← BACK', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '13px',
        color: '#c678ff',
      })
      .setOrigin(0.5)
      .setDepth(61);
    backBg.on('pointerover', () => backBg.setFillStyle(0x2c1856, 0.95));
    backBg.on('pointerout', () => backBg.setFillStyle(0x1a0a2e, 0.95));
    backBg.on('pointerup', () => {
      // Re-enter the rehearse pre-round flow at the song selection
      // step. scene.restart with no replayChart hits create()'s
      // non-testMode branch which calls showSongPicker — same path
      // the Change Song button on the summary uses.
      this.scene.restart({ playerState: this.playerState });
    });

    // RESTART chip — yellow stroke matches the primary action color
    // (same in-place replay path Play Again uses on the summary).
    const restartCy = backCy + chipH + gap;
    const restartBg = this.add
      .rectangle(chipCx, restartCy, chipW, chipH, 0x1a0a2e, 0.95)
      .setStrokeStyle(2, 0xffd34d, 0.9)
      .setDepth(60)
      .setInteractive({ useHandCursor: true });
    const restartTxt = this.add
      .text(chipCx, restartCy, '↻ RESTART', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '13px',
        color: '#ffd34d',
      })
      .setOrigin(0.5)
      .setDepth(61);
    restartBg.on('pointerover', () => restartBg.setFillStyle(0x2c1856, 0.95));
    restartBg.on('pointerout', () => restartBg.setFillStyle(0x1a0a2e, 0.95));
    restartBg.on('pointerup', () => {
      if (this.playChart) this.replayInPlace(this.playChart);
    });

    // Reuse the existing cleanup array (backToChartChip) since both
    // overlays live and die on the same scene lifecycle — no need to
    // add a second tearDown step.
    this.backToChartChip = [backBg, backTxt, restartBg, restartTxt];
  }

  /** Floating "← EDITOR" pill rendered on top of the playfield while in
   *  test mode. Sits in the top-right corner just under the HUD strip
   *  so it never collides with the hit lanes. */
  private buildBackToChartChip(): void {
    const { width } = this.scale;
    const padX = 10;
    const padY = TopHud.HEIGHT + 6;
    const w = 124;
    const h = 36;
    const cx = width - padX - w / 2;
    const cy = padY + h / 2;
    const bg = this.add
      .rectangle(cx, cy, w, h, 0x1a0a2e, 0.95)
      .setStrokeStyle(2, 0xffd34d, 0.9)
      .setDepth(60)
      .setInteractive({ useHandCursor: true });
    const txt = this.add
      .text(cx, cy, '← EDITOR', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '15px',
        color: '#ffd34d',
      })
      .setOrigin(0.5)
      .setDepth(61);
    bg.on('pointerover', () => bg.setFillStyle(0x2c1856, 0.95));
    bg.on('pointerout', () => bg.setFillStyle(0x1a0a2e, 0.95));
    bg.on('pointerup', () => {
      this.scene.start(SceneKeys.ChartEditor, {
        playerState: this.playerState,
        initialPage: this.currentPlayPage(),
        resume: true,
      });
    });
    this.backToChartChip = [bg, txt];
  }

  /**
   * Build the per-lane floating grade text and the centered combo callout.
   * One Text per lane is reused across the round so taps don't allocate.
   * Combo text sits in the cat-stage band, just above the lanes — same
   * spot Phase 1 used for combo milestones.
   */
  private buildFeedback(): void {
    const { width, height } = this.scale;
    const scaleY = height / L.DESIGN_H;
    const hitLineY = L.HIT_LINE_Y * scaleY;
    const fontBase = { fontFamily: 'Pixeloid Sans, sans-serif' };

    for (let i = 0; i < L.LANE_COUNT; i++) {
      const cx = L.laneCenterX(i as 0 | 1 | 2, width);
      const txt = this.add
        .text(cx, hitLineY - 36, '', {
          ...fontBase,
          fontStyle: 'bold',
          fontSize: '11px',
          color: '#ffffff',
          stroke: '#000000',
          strokeThickness: 2,
        })
        .setOrigin(0.5)
        .setAlpha(0)
        .setDepth(50);
      this.hitFeedbackTexts.push(txt);
    }

    const cx = width / 2;
    // Combo sits just above the lane top — visible without covering the cats.
    const comboY = (L.LANE_TOP_Y - 18) * scaleY;
    this.comboText = this.add
      .text(cx, comboY, '', {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '22px',
        color: '#ffd34d',
        stroke: '#1a0a2e',
        strokeThickness: 4,
      })
      .setOrigin(0.5)
      .setAlpha(0)
      .setDepth(50);

    // (Hits indicator lives in the TopHud now — the previous combo-
    // side pill was retired so combo stays the only thing on this row.)
  }

  /** Refresh score / coins / hits in the TopHud. Cheap — call after every
   *  judged tap or miss instead of every frame. */
  private updateHud(): void {
    const coins = this.playerState?.coins ?? 0;
    const landed = this.score.getLanded();
    const judged = this.score.getJudged();
    this.hud.setStats(this.score.get(), coins, landed, judged);
  }

  /** Punch the lane's hit target on a tap so the player sees their action
   *  registered even if no note was present. Grade controls the tint flash.
   *  Always reads from `hitTargetBaseScale` so back-to-back taps that kill
   *  a mid-yoyo tween don't compound the scale. */
  private flashTarget(laneId: LaneId, grade: 'perfect' | 'great' | 'miss'): void {
    const target = this.hitTargets[laneId];
    const base = this.hitTargetBaseScale[laneId];
    if (!target || base === undefined) return;
    // Reset to the SAMPLED lane tint, not the hardcoded default — otherwise
    // every post-tap reset reverts to cyan/magenta/gold and the lane's
    // bg-derived color is lost after the first hit.
    const baseTint = this.laneTints[laneId]!;
    // Perfect → cyan, Great → mint, Miss → red. Cyan/mint pop against the
    // dark stage; mint matches the accuracy stat color in the summary so
    // the cue feels consistent across the round.
    const flashTint =
      grade === 'perfect' ? 0x4dffff : grade === 'great' ? 0x4dffb4 : 0xff6b6b;
    target.setTint(flashTint);
    this.tweens.killTweensOf(target);
    // Pause the per-frame BPM pulse on this lane so it doesn't fight
    // the flash tween for the scale/alpha channels. Resumed on complete.
    this.targetPulseFlashing[laneId] = true;
    target.setScale(base);
    target.setAlpha(1);
    this.tweens.add({
      targets: target,
      scaleX: base * 1.25,
      scaleY: base * 1.25,
      yoyo: true,
      duration: 110,
      ease: 'Quad.easeOut',
      onComplete: () => {
        target.setTint(baseTint);
        target.setScale(base);
        target.setAlpha(1);
        this.targetPulseFlashing[laneId] = false;
      },
    });
  }

  /** Fire the lane effect's `burst` at 4 evenly-spaced points along
   *  the visible portion of an active hold's tail — all simultaneously,
   *  not staggered, at a small scale so the column reads as actively
   *  emitting without overwhelming other interactions. Each burst gets
   *  its own throwaway target Image (self-destroyed after the burst's
   *  animation window). */
  private burstEffectOnTail(n: Note): void {
    const effectId = this.laneEffects[n.laneId];
    if (!effectId) return;
    const effect = CAT_EFFECT_BY_ID[effectId];
    if (!effect) return;
    const scaleY = this.scale.height / L.DESIGN_H;
    const laneTopY = L.LANE_TOP_Y * scaleY;
    const targetY = L.HIT_LINE_Y * scaleY;
    // 1 burst point along the tail — was 4 → 2 → 1. Each cadence
    // tick used to spawn 2 tmp Images + 2 bursts + their particles
    // per hold; on busy charts with 2-3 simultaneous holds this was
    // the loudest perf hit. One mid-tail point reads as "tail still
    // emitting" without the GameObject churn.
    const points = n.getVisibleTailWorldPoints(laneTopY, targetY, 1);
    for (const p of points) {
      const tmp = this.add.image(p.x, p.y, AssetKeys.Image.MeowcertTargetWhite);
      tmp.setVisible(false);
      effect.burst(this, tmp, 0.25);
      this.time.delayedCall(800, () => tmp.destroy());
    }
  }

  /** Echo the seated cat's equipped effect out of the lane's fuzzball
   *  target as a one-shot radial burst. Glow effects pulse a colored
   *  halo outward; particle effects (hearts, fire, etc.) shoot the
   *  emoji in all directions around the ball. The effect's `burst`
   *  is self-cleaning — no handle to track. */
  private flashLaneEffect(laneId: LaneId): void {
    const effectId = this.laneEffects[laneId];
    if (!effectId) return;
    const target = this.hitTargets[laneId];
    if (!target) return;
    const effect = CAT_EFFECT_BY_ID[effectId];
    if (!effect) return;
    effect.burst(this, target);
  }

  /** Pop the lane's grade text and float it upward. Reuses the same Text
   *  object — last tween wins if the player double-taps in the same lane. */
  private showHitFeedback(laneId: LaneId, grade: 'perfect' | 'great' | 'miss'): void {
    const txt = this.hitFeedbackTexts[laneId];
    if (!txt) return;
    // Score-popup style — the +points payload is the headline, grade
    // word kept as a small companion below it via newline. Per-lane
    // placement (existing) so popups don't compete with the centered
    // combo callout above the lanes.
    const label =
      grade === 'perfect'
        ? `+${Balance.pointsPerfect}\nPERFECT`
        : grade === 'great'
        ? `+${Balance.pointsGreat}\nGREAT`
        : 'MISS';
    const color =
      grade === 'perfect' ? '#4dffff' : grade === 'great' ? '#4dffb4' : '#ff6b6b';
    txt.setText(label);
    txt.setColor(color);
    const startY = txt.y;
    // Reset every tween-driven prop before re-running the animation.
    this.tweens.killTweensOf(txt);
    txt.setAlpha(1);
    txt.setScale(1.4);
    txt.y = startY;
    this.tweens.add({
      targets: txt,
      scale: 1,
      duration: 110,
      ease: 'Quad.easeOut',
    });
    this.tweens.add({
      targets: txt,
      y: startY - 22,
      alpha: 0,
      duration: 520,
      ease: 'Quad.easeIn',
      onComplete: () => {
        txt.y = startY;
      },
    });
  }

  /** Escalating tier for the combo callout — 12 progressive tiers
   *  layer size + color + vibration + rotation + rainbow color cycle
   *  as combo climbs. Each layer composes on its own tween so they
   *  don't clobber each other (different target properties). */
  private getComboTier(combo: number): {
    fontSize: string;
    color: string;
    strokeThickness: number;
    vibrate: boolean;
    vibrateAmp: number;
    vibrateMs: number;
    rotate: boolean;
    rotateAmp: number; // radians
    cycleColor: boolean;
  } {
    // Tier 12 — apex
    if (combo >= 500) return { fontSize: '44px', color: '#ffffff', strokeThickness: 8, vibrate: true, vibrateAmp: 5, vibrateMs: 40, rotate: true, rotateAmp: 0.12, cycleColor: true };
    // Tier 11
    if (combo >= 300) return { fontSize: '42px', color: '#44ffff', strokeThickness: 7, vibrate: true, vibrateAmp: 5, vibrateMs: 50, rotate: true, rotateAmp: 0.10, cycleColor: true };
    // Tier 10
    if (combo >= 200) return { fontSize: '40px', color: '#cc44ff', strokeThickness: 7, vibrate: true, vibrateAmp: 4, vibrateMs: 55, rotate: true, rotateAmp: 0.08, cycleColor: false };
    // Tier 9
    if (combo >= 150) return { fontSize: '38px', color: '#ff44dd', strokeThickness: 6, vibrate: true, vibrateAmp: 4, vibrateMs: 55, rotate: false, rotateAmp: 0, cycleColor: false };
    // Tier 8
    if (combo >= 100) return { fontSize: '36px', color: '#ff44aa', strokeThickness: 6, vibrate: true, vibrateAmp: 3, vibrateMs: 60, rotate: false, rotateAmp: 0, cycleColor: false };
    // Tier 7
    if (combo >= 75) return { fontSize: '34px', color: '#ff4444', strokeThickness: 6, vibrate: true, vibrateAmp: 2, vibrateMs: 80, rotate: false, rotateAmp: 0, cycleColor: false };
    // Tier 6
    if (combo >= 50) return { fontSize: '32px', color: '#ff6644', strokeThickness: 5, vibrate: false, vibrateAmp: 0, vibrateMs: 0, rotate: false, rotateAmp: 0, cycleColor: false };
    // Tier 5
    if (combo >= 30) return { fontSize: '30px', color: '#ff8800', strokeThickness: 5, vibrate: false, vibrateAmp: 0, vibrateMs: 0, rotate: false, rotateAmp: 0, cycleColor: false };
    // Tier 4
    if (combo >= 20) return { fontSize: '28px', color: '#ffa000', strokeThickness: 5, vibrate: false, vibrateAmp: 0, vibrateMs: 0, rotate: false, rotateAmp: 0, cycleColor: false };
    // Tier 3
    if (combo >= 10) return { fontSize: '26px', color: '#ffb000', strokeThickness: 4, vibrate: false, vibrateAmp: 0, vibrateMs: 0, rotate: false, rotateAmp: 0, cycleColor: false };
    // Tier 2
    if (combo >= 5) return { fontSize: '24px', color: '#ffd34d', strokeThickness: 4, vibrate: false, vibrateAmp: 0, vibrateMs: 0, rotate: false, rotateAmp: 0, cycleColor: false };
    // Tier 1 — base
    return { fontSize: '22px', color: '#ffd34d', strokeThickness: 4, vibrate: false, vibrateAmp: 0, vibrateMs: 0, rotate: false, rotateAmp: 0, cycleColor: false };
  }

  /** Scale-punch tween for the combo text — tracked by ref so the
   *  vibration tween (separate, targets x) doesn't get clobbered. */
  private comboPulseTween: Phaser.Tweens.Tween | undefined;
  /** Continuous wobble tween on the combo text's x (high tiers). */
  private comboVibrationTween: Phaser.Tweens.Tween | undefined;
  /** Continuous rotation wobble on the combo text (top 3 tiers). */
  private comboRotateTween: Phaser.Tweens.Tween | undefined;
  /** Rainbow color-cycle timer (top 2 tiers). */
  private comboColorCycleTimer: Phaser.Time.TimerEvent | undefined;
  /** Cached tier key so we only restyle / start-stop the recurring
   *  effects on tier transitions, not every tap. */
  private currentComboTierKey = '';
  /** Palette for the rainbow color cycle at tier 11+. */
  private static readonly COMBO_RAINBOW = [
    '#ff44ff', '#ff8844', '#ffff44', '#44ff88', '#44aaff', '#aa44ff',
  ];
  private comboColorCycleIdx = 0;

  /** Pop the combo callout — escalates size + color + vibration with
   *  combo count. Hides on combo === 0. Milestone touches (10/25/50/
   *  100/200) also trigger a camera shake. */
  private pulseCombo(): void {
    const combo = this.score.getCombo();
    if (combo <= 0) {
      this.comboPulseTween?.remove();
      this.comboPulseTween = undefined;
      this.comboVibrationTween?.remove();
      this.comboVibrationTween = undefined;
      this.comboRotateTween?.remove();
      this.comboRotateTween = undefined;
      this.comboColorCycleTimer?.remove();
      this.comboColorCycleTimer = undefined;
      this.comboText.setAlpha(0);
      this.comboText.setScale(1);
      this.comboText.rotation = 0;
      this.comboText.x = this.scale.width / 2;
      this.currentComboTierKey = '';
      return;
    }

    const tier = this.getComboTier(combo);
    const tierKey = `${tier.fontSize}|${tier.color}|${tier.vibrate}|${tier.vibrateAmp}|${tier.vibrateMs}|${tier.rotate}|${tier.rotateAmp}|${tier.cycleColor}`;
    if (tierKey !== this.currentComboTierKey) {
      this.currentComboTierKey = tierKey;
      this.comboText.setStyle({
        fontSize: tier.fontSize,
        color: tier.color,
        strokeThickness: tier.strokeThickness,
      });
      // Vibration tween — kill + recreate on tier change so amp/speed
      // can escalate at higher tiers.
      if (this.comboVibrationTween) {
        this.comboVibrationTween.remove();
        this.comboVibrationTween = undefined;
      }
      this.comboText.x = this.scale.width / 2;
      if (tier.vibrate) {
        this.comboVibrationTween = this.tweens.add({
          targets: this.comboText,
          x: this.scale.width / 2 + tier.vibrateAmp,
          duration: tier.vibrateMs,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.inOut',
        });
      }
      // Rotation tween — same pattern; runs at top 3 tiers.
      if (this.comboRotateTween) {
        this.comboRotateTween.remove();
        this.comboRotateTween = undefined;
      }
      this.comboText.rotation = 0;
      if (tier.rotate) {
        this.comboRotateTween = this.tweens.add({
          targets: this.comboText,
          rotation: { from: -tier.rotateAmp, to: tier.rotateAmp },
          duration: 220,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.inOut',
        });
      }
      // Rainbow color cycle — top 2 tiers swap through a palette every
      // 100 ms via setColor (faster than setStyle, no layout recalc).
      if (this.comboColorCycleTimer) {
        this.comboColorCycleTimer.remove();
        this.comboColorCycleTimer = undefined;
      }
      if (tier.cycleColor) {
        this.comboColorCycleIdx = 0;
        this.comboColorCycleTimer = this.time.addEvent({
          delay: 100,
          loop: true,
          callback: () => {
            this.comboColorCycleIdx = (this.comboColorCycleIdx + 1) % Game.COMBO_RAINBOW.length;
            this.comboText.setColor(Game.COMBO_RAINBOW[this.comboColorCycleIdx]!);
          },
        });
      }
    }

    this.comboText.setText(`x${combo} COMBO`);
    this.comboText.setAlpha(1);

    const isMilestone = (Balance.comboMilestones as readonly number[]).includes(combo);
    const scaleFrom = isMilestone ? 1.9 : 1.3;
    const duration = isMilestone ? 280 : 140;
    this.comboPulseTween?.remove();
    this.comboText.setScale(scaleFrom);
    this.comboPulseTween = this.tweens.add({
      targets: this.comboText,
      scale: 1,
      duration,
      ease: 'Back.easeOut',
    });
    // Milestone — combo text alone handles the "wow" via the bigger
    // scale-punch above. Camera shake removed per Tim's request — the
    // tier escalation (size + color heat + 100+ vibration) is the
    // visual cue, no screen-wide motion.
    void isMilestone;
  }

  private bindInput(): void {
    // Phaser defaults to a single touch pointer, so a second finger landing
    // on a different lane during a double-tap step gets dropped — one of
    // the notes will always miss even with perfect timing. Add two more
    // active pointers so the player can hit all 3 lanes simultaneously.
    this.input.addPointer(2);

    const { width, height } = this.scale;
    const scaleY = height / L.DESIGN_H;
    const laneTopY = L.LANE_TOP_Y * scaleY;
    const laneBottomY = L.LANE_BOTTOM_Y * scaleY;
    const laneH = laneBottomY - laneTopY;
    const midY = laneTopY + laneH / 2;

    const inner = width - L.LANE_GUTTER_PX * 2;
    const colW = (inner - L.LANE_GAP_PX * (L.LANE_COUNT - 1)) / L.LANE_COUNT;

    for (let i = 0; i < L.LANE_COUNT; i++) {
      const laneId = i as LaneId;
      const cx = L.laneCenterX(laneId, width);
      const zone = this.add.rectangle(cx, midY, colW, laneH, 0x000000, 0);
      zone.setInteractive();
      zone.on('pointerdown', (pointer: Phaser.Input.Pointer) => this.registerTap(laneId, pointer));
      // Hold notes track pointerup (and pointerout as a slide-off proxy)
      // so the player's finger leaving the lane ends the hold cleanly.
      // Slides use scene-level pointer events (need to track across lanes).
      zone.on('pointerup', () => this.releaseHoldIfAny(laneId));
      zone.on('pointerout', () => this.releaseHoldIfAny(laneId));
      this.tapZones.push(zone);
    }

    // Keyboard mirrors: 1/2/3 keys map to lanes 0/1/2
    this.input.keyboard?.on('keydown-ONE', () => this.registerTap(0));
    this.input.keyboard?.on('keydown-TWO', () => this.registerTap(1));
    this.input.keyboard?.on('keydown-THREE', () => this.registerTap(2));
    this.input.keyboard?.on('keyup-ONE', () => this.releaseHoldIfAny(0));
    this.input.keyboard?.on('keyup-TWO', () => this.releaseHoldIfAny(1));
    this.input.keyboard?.on('keyup-THREE', () => this.releaseHoldIfAny(2));

    // Slides use scene-level pointer events because the drag crosses
    // lane boundaries — per-zone handlers would miss the transition.
    this.input.on('pointermove', this.onScenePointerMoveSlide, this);
    this.input.on('pointerup', this.onScenePointerUpSlide, this);
  }

  /** Per-frame-ish pointer update for active slide notes. Updates the
   *  head ball's local x so it follows the finger; an immediate miss
   *  fires if the player drags in the wrong direction past a small
   *  threshold. Branches on `isSlideReturn` for the out-and-back variant. */
  private onScenePointerMoveSlide = (pointer: Phaser.Input.Pointer): void => {
    if (this.roundOver || !pointer.isDown) return;
    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i]!;
      if (!n.active || !n.isSlide || !n.slideActive || n.slidePointerId !== pointer.id) continue;
      const localX = pointer.x - n.x;
      if (n.isSlideReturn) {
        // Phase 1 (outbound, not yet reached target): finger must move
        // toward target. EXTREMELY FORGIVING per Tim — this is the
        // hardest move in the game. We do NOT immediately fail on
        // wrong-direction; if the player wiggles back briefly before
        // committing, the gesture still counts. We only mark target
        // reached when the finger genuinely crossed enough.
        if (!n.slideReturnReachedTarget) {
          // Lowered from 0.7 → 0.5 — touching halfway is enough to count
          // as "they made it" in the slide-and-return's outbound phase.
          const fractionOut = n.slideDeltaX !== 0 ? localX / n.slideDeltaX : 0;
          if (fractionOut >= 0.5) {
            n.slideReturnReachedTarget = true;
          }
        }
        // Clamp to [0, deltaX] regardless of phase so the ball can't
        // teleport past either endpoint when the finger drifts wide.
        const clamped = n.slideDeltaX > 0
          ? Math.max(0, Math.min(n.slideDeltaX, localX))
          : Math.min(0, Math.max(n.slideDeltaX, localX));
        n.setSlideReturnHeadX(clamped);
        continue;
      }
      // Regular slide path (one-way to target).
      // Wrong-direction guard — drag opposite to the slide's required
      // direction past 10 px is an immediate miss.
      if (
        (n.slideDeltaX > 0 && localX < -10) ||
        (n.slideDeltaX < 0 && localX > 10)
      ) {
        this.failSlide(n);
        return;
      }
      // Clamp so the ball can't overshoot past the target lane center.
      const clamped = n.slideDeltaX > 0
        ? Math.max(0, Math.min(n.slideDeltaX, localX))
        : Math.min(0, Math.max(n.slideDeltaX, localX));
      n.setSlideHeadX(clamped);
    }
  };

  /** Pointerup handler for slides. Regular slides: success if ≥70% of
   *  the way to target. Slide-and-returns: success if target was
   *  reached AND ball is back to ≤15% of deltaX (= near source). */
  private onScenePointerUpSlide = (pointer: Phaser.Input.Pointer): void => {
    if (this.roundOver) return;
    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i]!;
      if (!n.active || !n.isSlide || !n.slideActive || n.slidePointerId !== pointer.id) continue;
      if (n.isSlideReturn) {
        if (!n.slideReturnReachedTarget) {
          // Released without ever reaching target = miss.
          this.failSlide(n);
          continue;
        }
        // EXTREMELY FORGIVING return threshold per Tim — the hardest
        // move in the game shouldn't drop on a near-miss. As long as
        // they made the out-and-back gesture (target reached + ball
        // back at ≤50% of deltaX), count it as a pass even if the
        // finger didn't perfectly return to source.
        const fraction = n.slideDeltaX !== 0
          ? Math.abs(n.getSlideHeadX() / n.slideDeltaX)
          : 0;
        if (fraction <= 0.5) {
          this.completeSlide(n);
        } else {
          this.failSlide(n);
        }
        continue;
      }
      // Regular slide — head must have crossed at least 70 % of the way
      // toward the target lane. Anything less = miss.
      const fraction = n.getSlideHeadX() / n.slideDeltaX; // always positive when on the right side
      if (fraction >= 0.7) {
        this.completeSlide(n);
      } else {
        this.failSlide(n);
      }
    }
  };

  /** Grade a successful slide release as a tap-grade hit. Grade perfect
   *  vs great based on the engage timing (tap-down vs hitAtMs) — the
   *  RELEASE timing happens much later, after the drag completes, so
   *  it's not a meaningful precision signal. For a regular slide,
   *  feedback fires on the TARGET lane (where the finger ended). For a
   *  slide-and-return, the finger ends BACK at the source — so feedback
   *  fires on the source lane instead. The player's eye lands wherever
   *  the gesture actually ended. */
  private completeSlide(n: Note): void {
    const targetLane: LaneId = n.isSlideReturn
      ? n.laneId
      : ((n.slideTargetLane >= 0 ? n.slideTargetLane : n.laneId) as LaneId);
    const engageDt = n.slideEngageMs > 0
      ? Math.abs(n.slideEngageMs - n.hitAtMs)
      : Balance.perfectWindowMs + 1; // unknown engage → fall back to great
    const grade: 'perfect' | 'great' = engageDt <= Balance.perfectWindowMs
      ? 'perfect'
      : 'great';
    this.score.registerHit(grade);
    this.showHitFeedback(targetLane, grade);
    this.flashTarget(targetLane, grade);
    this.cats[targetLane]?.playMeow(Balance.catReactionMs);
    this.cats[targetLane]?.pulseEffectHit();
    this.flashLaneEffect(targetLane);
    this.music?.playTapForLane(targetLane);
    n.consumed = true;
    n.recycle();
    this.pulseCombo();
    this.updateHud();
  }

  /** Mark a slide as missed — original-lane miss feedback, recycle.
   *  Used both on wrong-direction drag and on incomplete release. */
  private failSlide(n: Note): void {
    this.score.registerHit('miss');
    this.showHitFeedback(n.laneId, 'miss');
    this.flashTarget(n.laneId, 'miss');
    this.cats[n.laneId]?.playAngry(Balance.catReactionMs);
    this.cats[n.laneId]?.pulseEffectMiss();
    this.music?.playMiss();
    n.consumed = true;
    n.recycle();
    this.pulseCombo();
    this.updateHud();
  }

  // -----------------------------------------------------------------------
  // Private — round end
  // -----------------------------------------------------------------------

  private endRound(): void {
    if (this.roundOver) return;
    this.roundOver = true;
    // Disable tap zones individually so the overlay buttons still work.
    for (const z of this.tapZones) z.disableInteractive();
    this.input.keyboard?.removeAllListeners();
    // Recycle all live notes — stops their fall tweens immediately.
    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i]!;
      if (n.active) n.recycle();
    }
    // Backing track keeps playing through the summary — Phaser's scene
    // shutdown will tear it down via `cleanup` when the player closes
    // the scene. Round-end isn't a hard "cut off the music" moment;
    // letting it ride keeps the room feeling alive.
    // Branch on pass/fail BEFORE celebration kicks in. Cats either
    // start a happy cycle (pass) or a hissing droop (fail) so the
    // emotional read matches the show outcome. Stagger by 200ms
    // per cat so the reaction feels like a crowd, not a chorus.
    const finalAccuracyPct = this.score.getAccuracy();
    const failed = finalAccuracyPct < Balance.passAccuracyPct;
    this.cats.forEach((c, i) => {
      this.time.delayedCall(i * 200, () => {
        if (failed) c.startDisappointed();
        else c.startCelebration();
      });
    });
    // Repurpose the combo callout into the cats' end-of-show line. Same
    // slot above the lanes, shrunk and untweened so the message reads
    // calmly instead of pulsing like a fresh combo. The Text was
    // already alpha-0 — flip it to 1 once we've set the content.
    this.tweens.killTweensOf(this.comboText);
    this.comboText.setText('💕 thank you for coming to our show 💕');
    this.comboText.setStyle({
      fontFamily: 'Pixeloid Sans, sans-serif',
      fontStyle: 'bold',
      fontSize: '11px',
      color: '#ff9ed4',
      stroke: '#1a0a2e',
      strokeThickness: 4,
    });
    this.comboText.setScale(1);
    this.comboText.setAlpha(1);
    this.showSummary();

    // Visitor mode (including owner self-play): record the score
    // IMMEDIATELY at round end, regardless of whether the player goes
    // through the Post Comment flow. Previously submitPlay only fired
    // from the comment modal's POST/SKIP — if the modal froze or the
    // player closed without action, the leaderboard never updated.
    // Tim: "afterwards my score was not updated on the leaderboards
    // but it should as it should count as a run even if i was the
    // creator". The comment modal still re-fires submitPlay on POST so
    // the comment_posted inbox event lands; the leaderboard write is
    // idempotent (only stores personal best) so the double-submit is
    // safe.
    if (this.visitorMode && !this.playSubmitted) {
      this.playSubmitted = true;
      const summary = this.buildPlaySummary();
      // recordPlay submits the score WITHOUT scene-restart so the
      // player keeps seeing the summary. finalizePlay (used by the
      // Post Comment flow) is the variant that ALSO routes the scene
      // afterward.
      void this.recordPlay(summary, undefined, undefined);
    }
  }

  private showSummary(): void {
    if (!this.summary) return;
    this.summaryScoreText.setText(String(this.score.get()));
    const accuracyPct = this.score.getAccuracy();
    this.summaryAccuracyText.setText(`${accuracyPct.toFixed(0)}%`);
    this.summaryComboText.setText(`x${this.score.getMaxCombo()}`);
    this.summaryHitsText.setText(String(this.score.getLanded()));
    this.summaryMissesText.setText(String(this.score.getMisses()));

    // Pass / fail gate. Only test mode (editor rehearsal) enforces it.
    // Below the threshold: hide PUT ON A SHOW entirely so the
    // author can only route back to the editor. Tim's rule: don't let
    // a failed rehearsal post — fix the chart and rehearse again.
    // Pass/fail logic applies to ALL rehearsals (test mode, drawer
    // rehearse, future visit-shows). Tim's rule: mad cats on every
    // failed performance — encourages players to author levels they
    // and others can actually play. Only the PUT ON A SHOW button
    // is gated to test mode (post flow doesn't exist outside it yet).
    const passed = accuracyPct >= Balance.passAccuracyPct;
    if (passed) {
      this.summaryTitleText.setText('SHOW COMPLETE!');
      this.summaryTitleText.setColor('#ffd34d');
      this.summaryGateText.setText(
        this.testMode ? 'Nice — your show is ready to post.' : '',
      );
      this.summaryGateText.setColor('#a4ffb4');
      this.summaryRightBg.setVisible(true);
      this.summaryRightText.setVisible(true);
      this.comboText.setText('💕 thank you for coming to our show 💕');
      this.comboText.setColor('#ff9ed4');
    } else {
      this.summaryTitleText.setText('SHOW FAILED');
      this.summaryTitleText.setColor('#ff8b8b');
      this.summaryGateText.setText(
        this.testMode
          ? 'Please up your performance or fix your chart and try again.'
          : 'Better luck next time — practice this one and try again!',
      );
      this.summaryGateText.setColor('#ff8b8b');
      // PUT ON A SHOW only exists in test mode; hide it on test-mode
      // fails to enforce the "fix your chart" rule. Non-test rehearse
      // keeps the right button visible (Post Comment, future post flow).
      this.summaryRightBg.setVisible(!this.testMode);
      this.summaryRightText.setVisible(!this.testMode);
      this.comboText.setText('😿 we expected more, please try again 😿');
      this.comboText.setColor('#c6b3ff');
    }

    this.updateBestScoreLine(passed);

    this.summary.setVisible(true);
  }

  /** Per-stat personal-best row. Visible in all rehearsal modes (test
   *  mode + drawer rehearse) as long as the chart has both audioKey +
   *  difficulty — scratch charts have no difficulty so they skip
   *  best-tracking (would be misleading since they're authored ad-hoc).
   *  Only passing runs get recorded as bests; failing runs still display
   *  the previously stored row for reference. */
  private updateBestScoreLine(passed: boolean): void {
    const chart = this.playChart;
    const audioKey = chart?.audioKey;
    const difficulty = chart?.difficulty;
    const allBestObjs = [
      this.summaryBestDivider,
      this.summaryBestLabel,
      this.summaryBestAccuracyText,
      this.summaryBestComboText,
      this.summaryBestHitsText,
      this.summaryBestMissesText,
      this.summaryBestScoreBig,
    ];
    if (!audioKey || !difficulty) {
      for (const o of allBestObjs) o.setVisible(false);
      return;
    }
    const run: BestStats = {
      score: this.score.get(),
      accuracy: Math.round(this.score.getAccuracy()),
      maxCombo: this.score.getMaxCombo(),
      hits: this.score.getLanded(),
      misses: this.score.getMisses(),
    };
    const prev = getBest(audioKey, difficulty);
    // Only passing runs count toward the stored best (failed runs are
    // junk-time — we don't want a "best misses" of 87 because the
    // player rage-quit the first try). Failing runs still see the
    // previously stored row so they know what they're chasing.
    const newBests: Set<StatKey> = passed
      ? recordRun(audioKey, difficulty, run)
      : new Set<StatKey>();
    // After recordRun, the stored value reflects the new best where the
    // run beat it. For display we want what's stored now (with current
    // run merged) — or the pre-run stored value if we didn't record.
    const stored = passed ? getBest(audioKey, difficulty) : prev;
    if (!stored) {
      // Shouldn't happen — first-pass recordRun creates the row — but
      // defensive guard in case the failing-first-run case lands here.
      for (const o of allBestObjs) o.setVisible(false);
      return;
    }
    const colorFor = (key: StatKey): string => (newBests.has(key) ? '#4dffb4' : '#ffd34d');

    this.summaryBestAccuracyText.setText(`${stored.accuracy}%`).setColor(colorFor('accuracy'));
    this.summaryBestComboText.setText(`x${stored.maxCombo}`).setColor(colorFor('maxCombo'));
    this.summaryBestHitsText.setText(String(stored.hits)).setColor(colorFor('hits'));
    this.summaryBestMissesText.setText(String(stored.misses)).setColor(colorFor('misses'));
    this.summaryBestScoreBig.setText(stored.score.toLocaleString()).setColor(colorFor('score'));

    for (const o of allBestObjs) o.setVisible(true);
  }

  /** Replay the chart the player just finished. Avoids scene.restart
   *  entirely — restart was dropping the chart somewhere along the
   *  Phaser lifecycle (tried both data-payload and registry-carry,
   *  both Tim-confirmed blank/silent on the playtest). In-place reset
   *  is simpler and lets us reuse the existing chart object reference
   *  with no carry channel at all. */
  private onPlayAgainClicked = (): void => {
    if (!this.playChart) {
      // Defensive — no chart means we somehow lost the round we just
      // played; fall back to a full restart so the SongPicker re-opens.
      console.warn('[Game] Play Again with no playChart — falling back to restart');
      this.scene.restart({ playerState: this.playerState });
      return;
    }
    const chart = this.playChart;
    console.info(`[Game] Play Again — in-place replay audioKey=${chart.audioKey} stepCount=${chart.stepCount}`);
    this.replayInPlace(chart);
  };

  /** Hard-reset the round state inside the same scene instance + re-
   *  attach the chart. Mirrors what create()'s replay branch would do
   *  on a restart, minus the scene teardown / rebuild. */
  private replayInPlace(chart: Chart): void {
    // Tear down the live music + chart-player so the new attach can
    // build fresh ones against the same chart.
    this.music?.destroy();
    this.music = null;
    // Recycle any live notes left over from the previous run.
    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i]!;
      if (n.active) n.recycle();
    }
    // Reset round state — score, end flag, start clock, page tracking.
    // Anything that's per-round and consulted by update() needs to go
    // back to its init() value.
    this.score = new ScoreSystem();
    this.roundOver = false;
    this.startTimeMs = 0;
    this.pendingStart = true;
    this.lastEmittedPageBoundary = 0;
    // Hide the summary modal so the new round isn't drawing over it.
    this.summary?.setVisible(false);
    // Clear feedback texts in case any are mid-tween.
    for (const t of this.hitFeedbackTexts) t.setVisible(false);
    // Reset combo text to its pre-round empty state so the celebratory
    // "thank you for coming" line doesn't linger across rounds.
    this.tweens.killTweensOf(this.comboText);
    this.comboText.setText('');
    this.comboText.setAlpha(0);
    // Reset cats from celebration/disappointment back to idle.
    for (const c of this.cats) c.playIdle?.();
    // Re-update HUD so score zeroes back out.
    this.updateHud();
    // Re-attach + kick the round. Same pipeline that the initial play
    // used — attachChartAndMusic builds a fresh ChartPlayer + Music
    // System; beginRound seeks music + enables tap zones.
    this.attachChartAndMusic(chart);
    void this.beginRound().catch((err: unknown) => {
      console.error('[Game] beginRound threw on in-place replay:', err);
    });
  }

  /** Bounce back through the SongPicker by restarting without a
   *  replayChart — Game.create's non-testMode path will showSongPicker
   *  again. The previously played chart is dropped. */
  private onChangeSongClicked = (): void => {
    this.scene.restart({ playerState: this.playerState });
  };

  // Skip = "play again" for now. Decorate has its own nav via the hamburger.
  // Both buttons restart the scene with the same playerState so the player
  // can immediately retry without bouncing through Decorate.
  private onSkipClicked = (): void => {
    this.scene.restart({ playerState: this.playerState });
  };

  private onPostCommentClicked = (): void => {
    // Open the social-loop comment composer. Player gets one screen
    // to add free-text + optional gift, then POST (=2x reward) or
    // SKIP (=base reward). Both paths call submitPlay() to record the
    // run on the leaderboard + inbox + earn coins. Owner defaults to
    // the chart's authorId; for self-rehearse the server rejects
    // self-gifting and self-inboxing but the comment flow still runs
    // through the same UI for now (visitor-mode entry comes next).
    const summary = this.buildPlaySummary();
    if (!this.commentModal) this.commentModal = new CommentComposeModal(this);
    this.commentModal.open({
      summary,
      onPost: (commentBody: string, gift: GiftPayload | undefined) => {
        void this.finalizePlay(summary, commentBody, gift);
      },
      onSkip: () => {
        void this.finalizePlay(summary, undefined, undefined);
      },
    });
  };

  /** Build the PlaySummary blob from the round's score + chart context.
   *  Used by the comment modal preview + submit pipeline. */
  private buildPlaySummary(): PlaySummary {
    const visitor = this.playerState?.username ?? 'anon';
    // Visitor mode: owner + postId came from the VisitPost splash (the
    // post the player tapped into). Falling back to chart.authorId
    // covers the legacy paths where the splash never ran (test mode,
    // drawer rehearsal which doesn't reach this code anyway).
    const owner = this.visitorMode && this.visitOwnerUsername
      ? this.visitOwnerUsername
      : this.playChart?.authorId ?? visitor;
    const postId = this.visitorMode && this.visitPostId
      ? this.visitPostId
      : (this.registry.get('postId') as string | undefined) ?? 'preview';
    const totalNotes = this.score.getJudged();
    const notesHit = this.score.getLanded();
    const accuracyPct = this.score.getAccuracy();
    const accuracy = accuracyPct / 100;
    const passed = accuracyPct >= Balance.passAccuracyPct;
    const { tier, baseReward } = classifyScore(accuracy, passed);
    return {
      visitor,
      owner,
      postId,
      score: this.score.get(),
      totalNotes,
      notesHit,
      maxCombo: this.score.getMaxCombo(),
      accuracy,
      passed,
      tier,
      baseReward,
    };
  }

  /** Pure play submission — no scene navigation. Used by endRound's
   *  auto-record path (player still sees the summary afterward) and by
   *  finalizePlay (which adds the scene-restart on top). Server returns
   *  the canonical tier + baseReward and writes the leaderboard +
   *  inbox entries. */
  private async recordPlay(
    summary: PlaySummary,
    commentBody: string | undefined,
    gift: GiftPayload | undefined,
  ): Promise<void> {
    try {
      const result = await submitPlay({
        postId: summary.postId,
        owner: summary.owner,
        score: summary.score,
        totalNotes: summary.totalNotes,
        notesHit: summary.notesHit,
        maxCombo: summary.maxCombo,
        accuracy: summary.accuracy,
        ...(commentBody ? { commentBody } : {}),
        ...(gift ? { gift } : {}),
      });
      if (result.ok) {
        const final = rewardWithComment(result.baseReward, !!commentBody);
        console.info(`[Game] play submitted — ${result.tier} (+${final} coins)`);
      } else {
        console.warn('[Game] submitPlay failed:', result.reason);
      }
    } catch (err) {
      console.warn('[Game] submitPlay threw:', err);
    }
  }

  /** POST or SKIP path from the comment modal — record the play then
   *  route the scene back. Idempotent w.r.t. recordPlay: the
   *  leaderboard write is PB-only, the inbox events guard on
   *  visitor !== owner, so re-submitting (the case where endRound
   *  already auto-recorded) won't double-count. */
  private async finalizePlay(
    summary: PlaySummary,
    commentBody: string | undefined,
    gift: GiftPayload | undefined,
  ): Promise<void> {
    await this.recordPlay(summary, commentBody, gift);
    if (!this.scene.isActive()) return;
    this.scene.restart({ playerState: this.playerState });
  }

  // Test-mode summary handlers. Both currently return to ChartEditor since
  // POST is a stub — when the real post flow lands, only onPostFromTestClicked
  // will diverge.
  private onBackToEditorClicked = (): void => {
    this.scene.start(SceneKeys.ChartEditor, {
      playerState: this.playerState,
      initialPage: this.currentPlayPage(),
      resume: true,
    });
  };

  /** What page the playhead is on right now — used so jumping back to
   *  the editor opens on the section the player was rehearsing instead
   *  of always page 1. Clamped to the chart's actual page count. */
  private currentPlayPage(): number {
    if (!this.playChart || this.playMsPerStep <= 0) return 0;
    const elapsedMs = this.time.now - this.startTimeMs;
    const playStepFloat = Math.max(0, (elapsedMs - Balance.noteFallMs) / this.playMsPerStep);
    const playStep = Math.floor(playStepFloat);
    const playPage = Math.floor(playStep / CHART_PAGE_SIZE);
    const totalPages = Math.max(1, Math.ceil(this.playChart.stepCount / CHART_PAGE_SIZE));
    return Math.max(0, Math.min(totalPages - 1, playPage % totalPages));
  }

  private onPostFromTestClicked = (): void => {
    console.info('[Game] PUT ON A SHOW tapped');
    if (this.publishBusy) {
      console.info('[Game] publish already in flight, ignoring');
      return;
    }
    this.publishBusy = true;
    // Flash the right button so the player sees the click registered
    // while the network round-trip happens (Reddit's submitCustomPost
    // can take 1-2 s). On success the PublishedModal shows the link;
    // on failure we briefly recolor the button to indicate the error.
    const origLabel = this.summaryRightText.text;
    this.summaryRightText.setText('POSTING…');
    this.summaryRightBg.setFillStyle(0xc0a0e6, 1);
    console.info('[Game] hitting /api/publish/chart');
    // Tim's call: capture the cat-stage snapshot AT publish time
    // (not on every Decorate leave) — cats are in their celebration
    // animation right now from the round just finished, and the
    // captured image belongs to THIS specific show, not the player's
    // current Decorate state. Capture happens async; the publish
    // call waits for it (or proceeds without if capture fails).
    // Capture the cat-stage snapshot + grab the player's just-finished
    // rehearsal score (seeded as the post's first leaderboard entry
    // server-side so visitors see something to beat instead of an
    // empty board).
    const creatorScore = this.score.get();
    const creatorAccuracy = this.score.getAccuracy() / 100;
    void this.captureStagePreview().then((previewImage) => {
      return publishChart({
        ...(previewImage ? { previewImage } : {}),
        creatorScore,
        creatorAccuracy,
      });
    }).then((result) => {
      this.publishBusy = false;
      console.info('[Game] publishChart result:', result);
      if (!result.ok) {
        console.warn('[Game] publishChart failed:', result.reason);
        // Surface the actual reason so Tim can see what broke without
        // opening DevTools. Truncated to fit the button width.
        const errLabel = `× ${result.reason}`.slice(0, 18);
        this.summaryRightText.setText(errLabel);
        this.summaryRightBg.setFillStyle(0xff6b6b, 1);
        this.time.delayedCall(3000, () => {
          if (!this.scene.isActive()) return;
          this.summaryRightText.setText(origLabel);
          this.summaryRightBg.setFillStyle(0xffd34d, 1);
        });
        return;
      }
      // Success — show the confirmation modal with the post URL.
      if (!this.publishedModal) this.publishedModal = new PublishedModal(this);
      this.publishedModal.open({
        url: result.url,
        permalink: result.permalink,
        onClose: () => {
          // After the player closes the confirmation, route back to
          // the editor at the page they were rehearsing — same UX
          // beat as ← Editor so they can keep iterating.
          this.scene.start(SceneKeys.ChartEditor, {
            playerState: this.playerState,
            initialPage: this.currentPlayPage(),
            resume: true,
          });
        },
      });
    }).catch((err: unknown) => {
      this.publishBusy = false;
      console.error('[Game] publishChart threw:', err);
      this.summaryRightText.setText('× THREW');
      this.summaryRightBg.setFillStyle(0xff6b6b, 1);
    });
  };

  /** Snapshot the cat-stage band of the canvas (below the TopHud,
   *  above the lane area) as a JPEG data URL. Used at publish time to
   *  capture the cats for the post's feed-preview backdrop.
   *
   *  Programmatic compose, not a frozen moment from the round:
   *  - each seated cat is posed into 'meow' so the snapshot reads as
   *    "performing" rather than whatever idle frame the round happened
   *    to land on
   *  - lanes that have an equipped effect get a burst fired at the
   *    cat's sprite so the splash thumbnail shows the cosmetic doing
   *    its thing (sparkle / glow / emoji burst)
   *  - the floating "← EDITOR" chip + the "thank you for coming"
   *    combo text are hidden so no in-round UI bleeds into the image
   *  - we wait two animation frames after posing + bursting so the
   *    anim swap renders and the burst particles have time to draw
   *  - animations restored after the snapshot so the visible scene is
   *    unchanged
   */
  private captureStagePreview(): Promise<string | null> {
    return new Promise((resolve) => {
      const renderer = this.game.renderer as Phaser.Renderer.WebGL.WebGLRenderer | undefined;
      if (!renderer || typeof renderer.snapshotArea !== 'function') {
        resolve(null);
        return;
      }
      // Hide UI overlays. Track originals so we can restore after.
      const chipOriginalVisibles: boolean[] = [];
      for (const g of this.backToChartChip) {
        const v = (g as { visible?: boolean }).visible ?? true;
        chipOriginalVisibles.push(v);
        (g as { setVisible?: (b: boolean) => void }).setVisible?.(false);
      }
      const comboOriginalAlpha = this.comboText?.alpha ?? 0;
      this.comboText?.setAlpha(0);

      // Freeze every seated cat on the MIDDLE frame of the meow cycle
      // for the snapshot. setAnimation('meow') alone wasn't enough —
      // meow is a looping animation, so the 120 ms snapshot delay
      // landed on whatever frame the loop happened to be on (often the
      // closed-mouth or eyes-down frame, which reads as "lick" /
      // "idle" instead of "performing"). freezeMeowFrame() snaps the
      // sprite via setFrame() and stops the anim so the captured pose
      // is deterministically the mouth-open expressive frame.
      // Gracefully no-ops for breeds with no meow atlas frames.
      console.info('[Game] snapshot: freezing', this.cats.length, 'cats on meow frame');
      const restoreCatAnims: Array<() => void> = [];
      const effectHandles: Array<{ destroy(): void }> = [];
      for (let i = 0; i < this.cats.length; i++) {
        const cat = this.cats[i]!;
        const prevAnim = cat.model.animation;
        cat.freezeMeowFrame();
        restoreCatAnims.push(() => cat.setAnimation(prevAnim));

        // Light the cat's equipped effect using the CONTINUOUS
        // behind-cat aura (`apply`) instead of the radial fuzzball-
        // style burst we previously used. Tim's call: "dont do the
        // effect on the front echoing the fuzzball effects just show
        // the effects behind the cat with teh amplified version".
        // Scale 1.6 = amplified vs in-round default 1.0. The handle
        // is destroyed in restore() so the splash particles don't
        // leak into the editor scene after we transition back.
        const effectId = this.laneEffects[i];
        if (effectId) {
          const effect = CAT_EFFECT_BY_ID[effectId];
          if (effect) {
            const handle = effect.apply(this, cat.sprite, 1.6);
            // Pulse to the loud state so the snapshot grabs the
            // pronounced version of the aura, not the resting baseline.
            handle.pulseHit?.();
            effectHandles.push(handle);
          }
        }
      }

      const restore = (): void => {
        this.backToChartChip.forEach((g, i) => {
          (g as { setVisible?: (b: boolean) => void }).setVisible?.(chipOriginalVisibles[i] ?? true);
        });
        this.comboText?.setAlpha(comboOriginalAlpha);
        for (const fn of restoreCatAnims) fn();
        // Stop the splash-only aura emitters so they don't keep
        // spawning particles into the next scene.
        for (const h of effectHandles) h.destroy();
      };

      const scaleY = this.scale.height / L.DESIGN_H;
      const x = 0;
      const y = TopHud.HEIGHT * scaleY;
      const w = this.scale.width;
      // Capture down to LANE_TOP_Y — the full cat-stage band including
      // the bottom edge of the stage. We already hide comboText via
      // setAlpha(0) so the 'thank you' text won't show in the frame
      // (was previously cropping 30 px shy as belt-and-suspenders;
      // the alpha hide is enough on its own and Tim wants the
      // taller image to fill more splash whitespace).
      const h = (L.LANE_TOP_Y - TopHud.HEIGHT) * scaleY;
      // 320 ms gives the continuous `apply` effects enough time to
      // spawn their first wave of particles (most use a 150-250 ms
      // spawn interval). Shorter waits captured the cats before any
      // particles had drawn behind them. The pulseHit also takes ~120
      // ms to ramp the aura to its peak; we want the snapshot to land
      // there.
      const SNAPSHOT_DELAY_MS = 320;
      this.time.delayedCall(SNAPSHOT_DELAY_MS, () => {
        try {
          renderer.snapshotArea(x, y, w, h, (img) => {
          if (!(img instanceof HTMLImageElement)) {
            restore();
            resolve(null);
            return;
          }
          const sendWhenReady = (): void => {
            try {
              const targetW = 320;
              const targetH = Math.round((img.height / img.width) * targetW);
              const canvas = document.createElement('canvas');
              canvas.width = targetW;
              canvas.height = targetH;
              const ctx = canvas.getContext('2d');
              if (!ctx) { restore(); resolve(null); return; }
              ctx.drawImage(img, 0, 0, targetW, targetH);
              const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
              restore();
              resolve(dataUrl);
            } catch (err) {
              console.warn('[Game] preview capture encode failed:', err);
              restore();
              resolve(null);
            }
          };
          if (img.complete) sendWhenReady();
          else img.onload = sendWhenReady;
        });
        } catch (err) {
          console.warn('[Game] snapshotArea threw:', err);
          restore();
          resolve(null);
        }
      });
    });
  }

  // -----------------------------------------------------------------------
  // Private — chart
  // -----------------------------------------------------------------------

  /**
   * Resolve the test-mode chart and wire ChartPlayer.
   * Priority: registry.hostChart → playerState.chart → loadChart(host) →
   * fetchState → empty stub.
   */
  private async initChartPlayer(): Promise<void> {
    let chart: Chart | undefined = this.registry.get('hostChart');

    if (!chart) {
      // Try the player's own chart from state.
      const stateChart = this.playerState?.chart;
      if (stateChart) {
        chart = stateChart;
      }
    }

    if (!chart) {
      const host = this.registry.get('hostUsername') as string | undefined;
      if (host) {
        try {
          chart = await loadChart(host);
          if (!this.scene.isActive()) return;
        } catch (err) {
          console.warn('[Game] loadChart failed, using empty chart:', err);
        }
      }
    }

    if (!chart) {
      // No state was passed and no host — pull a fresh state so we have
      // the player's own chart at minimum.
      try {
        const fresh = await fetchState();
        if (!this.scene.isActive()) return;
        this.playerState = fresh;
        chart = fresh.chart;
        // Re-seat cats with the freshly loaded state.
        for (const c of this.cats) c.destroy();
        this.cats = [];
        this.seatCats();
      } catch (err) {
        console.warn('[Game] fetchState failed, falling back to empty chart:', err);
      }
    }

    // Play whatever the player saved — including an empty chart. The
    // random-chart fallback was scaffolding from before the editor
    // existed and made "I authored a beat, why am I hearing something
    // else?" too easy to hit. If the user has zero notes they'll see a
    // silent round, which is the truth.
    const playChart: Chart = chart ?? emptyChart(this.playerState?.username ?? 'anon', 'Untitled');
    this.attachChartAndMusic(playChart);
  }

  /** Build ChartPlayer + MusicSystem from a fully-resolved chart. The
   *  TRY path resolves via initChartPlayer; the Generate path passes the
   *  freshly generated chart directly. */
  private attachChartAndMusic(playChart: Chart): void {
    // Spawn cutoff so the LAST possible note (tap, hold, or slide)
    // fully resolves before the round-end wall-clock fires. Otherwise
    // the summary screen yanks notes still on-screen mid-fall.
    //
    // Buffer = noteFallMs (fall time) + maxHoldMs (from the actual
    // chart's holds[]) + roundWindDownMs (final silence). Editor
    // reads the same Balance constant so its restricted-zone overlay
    // matches what actually plays.
    const msPerStep = 60000 / (playChart.bpm * 2);
    const onePassMs = msPerStep * playChart.stepCount;
    let maxHoldMs = 0;
    if (playChart.holds) {
      for (const h of playChart.holds) {
        const dur = (h.endStep - h.startStep) * msPerStep;
        if (dur > maxHoldMs) maxHoldMs = dur;
      }
    }
    const spawnCutoffMs = Math.max(
      msPerStep, // at least one step so very short rounds still emit something
      Balance.maxRoundMs - Balance.noteFallMs - maxHoldMs - Balance.roundWindDownMs,
    );
    const loopCount = Math.max(1, Math.ceil(Balance.maxRoundMs / onePassMs) + 1);

    this.player = new ChartPlayer(playChart, {
      loopCount,
      noteFallMs: Balance.noteFallMs,
      maxTotalMs: spawnCutoffMs,
      // Editor rehearse passes initialStartStep so the chart begins
      // at the page the author was working on. Plain Rehearse leaves
      // it at 0 (full chart from the top).
      startStep: this.initialStartStep,
    });

    this.player.onSpawn((lane, hitAt) => this.spawnNote(lane, hitAt));
    this.player.onHoldSpawn((lane, hitAt, releaseAt) => this.spawnHoldNote(lane, hitAt, releaseAt));
    this.player.onSlideSpawn((src, tgt, hitAt) => this.spawnSlideNote(src, tgt, hitAt));
    this.player.onSlideReturnSpawn((src, tgt, hitAt) => this.spawnSlideReturnNote(src, tgt, hitAt));

    // Cache chart-derived timing so update() can drive the page-boundary
    // lines without going through ChartPlayer internals. Test mode only —
    // rehearsing from the drawer doesn't get page markers since the
    // player didn't author the chart.
    this.playChart = playChart;
    this.playMsPerStep = 60000 / (playChart.bpm * 2);
    this.playPagesPerLoop = Math.max(
      1,
      Math.ceil(playChart.stepCount / CHART_PAGE_SIZE),
    );

    // Music for the round: real backing track from BACKING_CATALOG
    // (selected by chart.bpm + vibe + author hash). Backings are lazy-
    // loaded, so kick the download off RIGHT NOW — in the editor TRY
    // path the Ready modal gives it plenty of time to land; in the
    // Generate path showGenerateModal awaits start() before begin.
    this.music = new MusicSystem(this, playChart);
    void this.music.preload();

    // Lane pulse to beat — each lane's alpha oscillates 0.78↔0.92 at
    // BPM cadence so the playfield feels alive between notes. One
    // continuous yoyo tween per lane, started together so they sync.
    this.startLanePulse();
  }

  /** Live FPS readout in the top-left corner. Mint on dark stroke so
   *  it's visible against any bg. Updates 4×/sec (cheap). Doubles as
   *  a perf canary — if the number tanks during heavy combos / lots
   *  of effects, we know to dial something back. */
  private fpsText: Phaser.GameObjects.Text | undefined;
  private lastFpsUpdate = 0;
  private buildFpsOverlay(): void {
    this.fpsText = this.add
      .text(8, 8, '— FPS', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#4dffb4',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0, 0)
      .setDepth(1000);
  }
  private updateFpsOverlay(): void {
    if (!this.fpsText) return;
    if (this.time.now - this.lastFpsUpdate < 250) return;
    this.lastFpsUpdate = this.time.now;
    this.fpsText.setText(`${Math.round(this.game.loop.actualFps)} FPS`);
  }

  /** Continuous BPM-locked alpha pulse on every lane backdrop. Cheap —
   *  three yoyo tweens total, running for the whole round. Killed
   *  inside cleanup via the scene's tween manager. */
  private startLanePulse(): void {
    // Bumped amplitude back up (0.95↔0.68) — the 0.82↔0.90 range was
    // too subtle to read. Compounding the lane pulse with a
    // COUNTER-PHASE hit-target scale pulse so the playfield breathes:
    // lane dims → target swells, lane brightens → target shrinks.
    // Together they create a heartbeat rhythm tied to the BPM.
    for (const lane of this.laneRects) {
      this.tweens.add({
        targets: lane,
        alpha: { from: 0.95, to: 0.68 },
        duration: this.playMsPerStep * 2,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.inOut',
      });
    }
    // Hit-target pulse is clock-driven in tickTargetPulse() instead of
    // per-lane tween. Reason: the tween approach got phase-shifted every
    // time flashTarget restarted it (each lane drifted independently),
    // so the 3 lanes looked random instead of beat-synced. Sampling a
    // single sine of (time.now) keeps all 3 lanes on the same phase
    // forever, and pausing any one lane during its hit-flash is a flag
    // check instead of a tween restart.
  }

  /** Per-frame BPM-locked pulse on the catching fuzz-balls. Reads a
   *  single sine of game time so all 3 lanes share the exact same
   *  phase — they breathe together with the song's beat. Each lane
   *  skipped while mid hit/miss flash (flashTarget owns the channels).
   *  Subtle by design: ±3% scale + ±4% alpha (toned way down per Tim,
   *  the previous +12.5% was overpowering). Period matches the lane
   *  pulse (msPerStep × 4 = 2 beats per full breath). */
  private tickTargetPulse(): void {
    if (this.playMsPerStep <= 0) return;
    const cycleMs = this.playMsPerStep * 4;
    const phase = (this.time.now % cycleMs) / cycleMs;
    const wave = Math.sin(phase * Math.PI); // 0..1..0 over one cycle
    for (let i = 0; i < this.hitTargets.length; i++) {
      if (this.targetPulseFlashing[i]) continue;
      const target = this.hitTargets[i]!;
      const base = this.hitTargetBaseScale[i]!;
      const scaleMul = 1 + wave * 0.03;
      target.setScale(base * scaleMul);
      target.setAlpha(0.92 + wave * 0.08);
    }
  }

  /** Spawn a page-boundary line that falls top → hit line over the
   *  same noteFallMs the notes use, so it visually marks where the next
   *  page begins. Carries a 'PAGE N' chip centered on the line for
   *  parity with the editor's static page labels. Skip page 0 (round
   *  start needs no marker). */
  private spawnPageBoundaryLine(pageIdx: number): void {
    if (!this.scene.isActive() || this.roundOver) return;
    const { width, height } = this.scale;
    const scaleY = height / L.DESIGN_H;
    const laneTopY = L.LANE_TOP_Y * scaleY;
    const hitLineY = L.HIT_LINE_Y * scaleY;
    const fallMs = Balance.noteFallMs;

    const cx = width / 2;
    // Depth above notes (depth 40) so the boundary line + label read over
    // the falling balls instead of getting hidden behind them.
    const line = this.add
      .rectangle(cx, laneTopY, width - 12, 2, 0xffd34d, 0.85)
      .setDepth(48);
    const label = this.add
      .text(cx, laneTopY, `PAGE ${pageIdx + 1}`, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '11px',
        color: '#1a0a2e',
        backgroundColor: '#ffd34d',
        padding: { x: 6, y: 1 },
      })
      .setOrigin(0.5)
      .setDepth(49);

    const fallTween = (target: Phaser.GameObjects.GameObject) =>
      this.tweens.add({
        targets: target,
        y: hitLineY,
        duration: fallMs,
        ease: 'Linear',
        onComplete: () => {
          this.tweens.add({
            targets: target,
            y: hitLineY + 28,
            alpha: 0,
            duration: 240,
            onComplete: () => target.destroy(),
          });
        },
      });
    fallTween(line);
    fallTween(label);
  }

  /** Step 1 of the Rehearse pre-round flow: pick a song. Player picks
   *  a vibe, then a specific backing from the list at that vibe. The
   *  catalog id is carried forward as chart.audioKey so MusicSystem
   *  locks to that exact song instead of hash-bucketing. */
  private showSongPicker(): void {
    if (!this.songPicker) this.songPicker = new SongPickerModal(this);
    this.songPicker.open({
      initial: {
        ...(this.pendingSong?.audioKey ? { audioKey: this.pendingSong.audioKey } : {}),
        ...(this.pendingSong?.vibe
          ? { vibe: this.pendingSong.vibe }
          : this.playerState?.chart?.vibe
            ? { vibe: this.playerState.chart.vibe }
            : {}),
      },
      // Rehearsal-only entry so the custom-song option only surfaces here
      // (catalog-only on the ChartEditor entry — anything that gets
      // posted publicly has to use a known catalog song).
      showCustomSong: true,
      onPick: (result) => {
        this.pendingSong = result;
        this.showDifficultyPicker();
      },
      onCancel: () => {
        this.scene.start(SceneKeys.Decorate, { playerState: this.playerState });
      },
    });
  }

  /** Step 2 of the Rehearse pre-round flow: pick a difficulty. Generates
   *  the chart at the chosen song + difficulty, stamps audioKey, attaches
   *  player + music, and kicks the round. */
  private showDifficultyPicker(): void {
    const song = this.pendingSong;
    if (!song) {
      this.showSongPicker();
      return;
    }
    if (!this.difficultyPicker) this.difficultyPicker = new DifficultyPickerModal(this);
    this.difficultyPicker.open({
      initial: 'medium',
      onStart: (difficulty: GenDifficulty) => {
        const chart = generateChart({
          authorId: this.playerState?.username ?? 'anon',
          title: 'Rehearsal',
          difficulty,
          bpm: song.bpm,
          vibe: song.vibe,
          targetDurationMs: Balance.maxRoundMs,
          audioKey: song.audioKey,
        });
        chart.audioKey = song.audioKey;
        this.attachChartAndMusic(chart);
        void this.beginRound();
      },
      onBack: () => this.showSongPicker(),
    });
  }

  /** Common round kick-off used after the Generate path. Awaits the
   *  music start, then unblocks input + records startTimeMs. Music
   *  seeks to the chart-player's startOffsetMs so editor-rehearse
   *  lands chart + music in sync at the author's current page. */
  private async beginRound(): Promise<void> {
    if (!this.scene.isActive()) return;
    const startOffsetMs = this.player?.startOffsetMs ?? 0;
    await this.music?.start(startOffsetMs);
    if (!this.scene.isActive()) return;
    for (const z of this.tapZones) z.setInteractive();
    this.startTimeMs = this.time.now - startOffsetMs;
    this.pendingStart = false;
  }

  // -----------------------------------------------------------------------
  // Private — note pool
  // -----------------------------------------------------------------------

  private spawnNote(laneId: LaneId, hitAtMs: number): void {
    const note = this.acquireNote();
    const x = L.laneCenterX(laneId, this.scale.width);
    const scaleY = this.scale.height / L.DESIGN_H;
    const startY = L.LANE_TOP_Y * scaleY;
    const hitY = L.HIT_LINE_Y * scaleY;
    // Ball falls all the way OFF the screen — miss is detected by
    // position (n.y past the screen edge), so a slightly late tap as
    // the ball exits the target still lands. Tween speed is calibrated
    // to keep hit timing locked to Balance.noteFallMs at the target.
    const endY = this.scale.height + 80;
    const totalFallMs = ((endY - startY) / (hitY - startY)) * Balance.noteFallMs;
    note.configure(laneId, x, startY, endY, totalFallMs, hitAtMs, this.laneTints[laneId]);
  }

  /** Spawn a hold note — head ball + tail of stacked fuzzballs extending
   *  upward. Tail height is derived from fall speed so the tail's TOP
   *  reaches the target exactly at `releaseAtMs` (the trailing edge's
   *  crossing time). */
  private spawnHoldNote(laneId: LaneId, hitAtMs: number, releaseAtMs: number): void {
    const note = this.acquireNote();
    const x = L.laneCenterX(laneId, this.scale.width);
    const scaleY = this.scale.height / L.DESIGN_H;
    const startY = L.LANE_TOP_Y * scaleY;
    const hitY = L.HIT_LINE_Y * scaleY;
    // fallSpeed (px/ms) is constant — derived from noteFallMs so the
    // head always crosses (startY → hitY) in exactly Balance.noteFallMs.
    const fallSpeedPxPerMs = (hitY - startY) / Balance.noteFallMs;
    const tailHeightPx = Math.max(0, (releaseAtMs - hitAtMs) * fallSpeedPxPerMs);
    // Container needs to keep falling past the trailing-edge crossing —
    // otherwise the tween ends, the container freezes, and any tail
    // balls still in [laneTop, target] stay stuck on-screen until
    // auto-end recycles everything at once. Push endY past the worst
    // case: trailing crossing + 100px buffer for the visual to drain
    // cleanly before recycle fires.
    const endY = Math.max(this.scale.height + 80, hitY + tailHeightPx + 100);
    const totalFallMs = (endY - startY) / fallSpeedPxPerMs;
    // Tail width matches the visual width of the lane wash — narrower
    // than the 54px ball so the ball still reads as the "head" cap.
    const tailWidthPx = 40;
    note.configure(
      laneId, x, startY, endY, totalFallMs, hitAtMs, this.laneTints[laneId],
      { tailHeightPx, tailWidthPx, releaseAtMs },
    );
    if (this.holdLaneMask) note.applyTailMask(this.holdLaneMask);
  }

  /** Spawn a slide note — head ball at `sourceLane` with a sideways tube
   *  + arrow pointing toward `targetLane`. Falls like a tap; the slide
   *  gesture is detected on tap-down in the source lane's hit window
   *  and tracked via scene-level pointermove until release. */
  private spawnSlideNote(sourceLane: LaneId, targetLane: LaneId, hitAtMs: number): void {
    const note = this.acquireNote();
    const sourceX = L.laneCenterX(sourceLane, this.scale.width);
    const targetX = L.laneCenterX(targetLane, this.scale.width);
    const deltaX = targetX - sourceX;
    const scaleY = this.scale.height / L.DESIGN_H;
    const startY = L.LANE_TOP_Y * scaleY;
    const hitY = L.HIT_LINE_Y * scaleY;
    const endY = this.scale.height + 80;
    const totalFallMs = ((endY - startY) / (hitY - startY)) * Balance.noteFallMs;
    note.configure(
      sourceLane, sourceX, startY, endY, totalFallMs, hitAtMs,
      this.laneTints[sourceLane],
      undefined,
      {
        deltaX,
        sourceTint: this.laneTints[sourceLane],
        targetTint: this.laneTints[targetLane],
      },
    );
    note.slideTargetLane = targetLane;
  }

  /** Spawn a slide-and-return note. Same setup as a regular slide but
   *  with `isReturn: true` so the Note's tube + arrow render the round-
   *  trip variant. The pointer-move + pointer-up handlers route to
   *  different completion logic for these (see updateSlideReturnDrag +
   *  releaseSlideReturn). Adjacent-lane only — schema validates that. */
  private spawnSlideReturnNote(sourceLane: LaneId, targetLane: LaneId, hitAtMs: number): void {
    const note = this.acquireNote();
    const sourceX = L.laneCenterX(sourceLane, this.scale.width);
    const targetX = L.laneCenterX(targetLane, this.scale.width);
    const deltaX = targetX - sourceX;
    const scaleY = this.scale.height / L.DESIGN_H;
    const startY = L.LANE_TOP_Y * scaleY;
    const hitY = L.HIT_LINE_Y * scaleY;
    const endY = this.scale.height + 80;
    const totalFallMs = ((endY - startY) / (hitY - startY)) * Balance.noteFallMs;
    note.configure(
      sourceLane, sourceX, startY, endY, totalFallMs, hitAtMs,
      this.laneTints[sourceLane],
      undefined,
      {
        deltaX,
        sourceTint: this.laneTints[sourceLane],
        targetTint: this.laneTints[targetLane],
        isReturn: true,
      },
    );
    note.slideTargetLane = targetLane;
  }

  /** Build the lane-band GeometryMask used to clip hold tails. The
   *  mask Graphics needs to participate in the render pass so Phaser
   *  populates the stencil buffer — `setVisible(false)` skips that
   *  entirely (mask never built, tails render unclipped). `setAlpha(0)`
   *  keeps it in the pipeline but invisible on screen. */
  private buildHoldLaneMask(): Phaser.Display.Masks.GeometryMask {
    const scaleY = this.scale.height / L.DESIGN_H;
    const laneTopY = L.LANE_TOP_Y * scaleY;
    const targetY = L.HIT_LINE_Y * scaleY;
    const shape = this.add.graphics();
    shape.fillStyle(0xffffff);
    shape.fillRect(0, laneTopY, this.scale.width, targetY - laneTopY);
    shape.setAlpha(0);
    return shape.createGeometryMask();
  }

  /** Hot path: scan pre-allocated pool for an inactive note. Allocates only
   *  when pool is exhausted (shouldn't happen after pre-warm). */
  private acquireNote(): Note {
    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i]!;
      if (!n.active) return n;
    }
    const n = new Note(this);
    this.add.existing(n);
    this.notes.push(n);
    return n;
  }

  // -----------------------------------------------------------------------
  // Private — hit / miss detection
  // -----------------------------------------------------------------------

  private registerTap(laneId: LaneId, pointer?: Phaser.Input.Pointer): void {
    if (this.roundOver) return;
    const now = this.time.now - this.startTimeMs;
    const note = this.activeNoteInLane(laneId, now);

    // Position-based hit detection. The big target is 72px and the small
    // note is 54px (radii 36 and 27). dy is the gap between centers:
    //   dy <= ~15  → perfect (small ball nestled inside the target)
    //   dy <= ~60  → great   (sprites are visually touching)
    //   dy >  ~60  → miss    (tap penalty, but note keeps falling)
    // No active note in the lane at all → also miss. Taps now always
    // commit to a judgment so spamming the lane costs combo.
    const scaleY = this.scale.height / L.DESIGN_H;
    const targetY = L.HIT_LINE_Y * scaleY;
    const perfectDistance = 15;
    // Slides (single, double, slide-and-return) get a much wider perfect
    // window — the gesture is harder than a single tap and players
    // naturally start the drag early. Midpoint between perfect (15) and
    // great (60) = 37, so a slide tap up to 37 px from the target still
    // grades perfect instead of great. Encourages "start early rather
    // than late" without giving away free perfects on regular taps.
    const slidePerfectDistance = 37;
    // Asymmetric great window: more forgiving on the way IN, tighter on
    // the way OUT. Tapping a ball that has already half-cleared the
    // fuzzball is treated harshly — should grade as miss.
    const enterMaxHitDistance = 60;
    const exitMaxHitDistance = 30;
    // Slides get a wider exit window too — the tap is the START of a
    // multi-step gesture, so a slightly late tap still has time to drag
    // through. Symmetric 60 above / 60 below vs taps + holds' 60 / 30.
    // Pairs with the wider auto-miss line in checkMisses so engagement
    // and auto-miss windows line up.
    const slideExitMaxHitDistance = 60;

    let grade: 'perfect' | 'great' | 'miss' = 'miss';
    if (note) {
      const dySigned = note.y - targetY;
      const absDy = Math.abs(dySigned);
      const perfectWin = note.isSlide ? slidePerfectDistance : perfectDistance;
      const exitWin = note.isSlide ? slideExitMaxHitDistance : exitMaxHitDistance;
      const greatWindow = dySigned <= 0 ? enterMaxHitDistance : exitWin;
      if (absDy <= perfectWin) grade = 'perfect';
      else if (absDy <= greatWindow) grade = 'great';
    }

    // Fire audio feedback before grading-side effects so the sound
    // lands as close to the tap moment as possible.
    //   non-miss: per-lane tap sample / synth — backing-amp pulse is
    //             pre-scheduled at note spawn time so it lands on the
    //             beat regardless of when this tap fires
    //   miss:     low buzz tone — noticeable but doesn't ruin the song
    if (grade !== 'miss') {
      this.music?.playTapForLane(laneId);
    } else {
      this.music?.playMiss();
    }

    this.score.registerHit(grade);
    this.showHitFeedback(laneId, grade);
    this.flashTarget(laneId, grade);
    if (grade === 'miss') {
      this.cats[laneId]?.playAngry(Balance.catReactionMs);
      this.cats[laneId]?.pulseEffectMiss();
      // Intentionally don't consume the note — the player can still land
      // a real hit on it when it actually reaches the target. Premature
      // tap costs combo but doesn't burn the note.
    } else {
      this.cats[laneId]?.playMeow(Balance.catReactionMs);
      this.cats[laneId]?.pulseEffectHit();
      this.flashLaneEffect(laneId);
      if (note!.isHold) {
        // Hold engaged. Don't consume — tickHolds + releaseHoldIfAny
        // own the lifecycle from here. Per-step bonus accumulates while
        // the player keeps the lane pressed. holdLastEffectMs seeds the
        // recurring lane-effect cadence (see tickHolds). Tail color
        // flips to the mint "success" tint so the column visibly
        // signals "you're doing it right, keep holding".
        note!.holdActive = true;
        note!.holdLastEffectMs = this.time.now - this.startTimeMs;
        note!.setHoldTint(Balance.holdActiveTint);
      } else if (note!.isSlide && pointer) {
        // Slide engaged. Lock to this pointer id; scene-level pointermove
        // tracks the head's local x until pointerup decides success/miss.
        // Tube tint flips to the same mint "great" color a tap hit
        // flashes so the player gets immediate "you caught it" feedback.
        note!.slideActive = true;
        note!.slidePointerId = pointer.id;
        note!.slideEngageMs = this.time.now;
        note!.setSlideEngagedTint(Balance.holdActiveTint);
      } else {
        note!.consumed = true;
        note!.recycle();
      }
    }
    this.pulseCombo();
    this.updateHud();
  }

  /** Hot path: find the closest active, unconsumed note in the given lane.
   *  Iterates the pre-allocated pool — no allocation. */
  private activeNoteInLane(laneId: LaneId, now: number): Note | undefined {
    let best: Note | undefined;
    let bestDt = Infinity;
    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i]!;
      if (!n.active || n.consumed || n.laneId !== laneId) continue;
      const dt = Math.abs(now - n.hitAtMs);
      if (dt < bestDt) {
        bestDt = dt;
        best = n;
      }
    }
    return best;
  }

  /** Called every update — detects notes that have passed the hit window
   *  without being tapped. No allocation. */
  private checkMisses(): void {
    if (this.roundOver) return;
    // Tighter miss boundary — fire the moment the note drops past the
    // great window's bottom edge (i.e. just behind the fuzzball) instead
    // of waiting for it to clear the screen. Tim's rule: less forgiving;
    // once the note slips behind the target it's a miss.
    const scaleY = this.scale.height / L.DESIGN_H;
    const targetY = L.HIT_LINE_Y * scaleY;
    // Asymmetric miss boundary — Tim's rule: less forgiving on the way
    // OUT than on the way in. Auto-miss fires once the ball center is
    // ~30 px past the target (more than half the ball outside the fuzz
    // circle), even though the entry-side great window stays at 60 px.
    const missY = targetY + 30;
    // Slides (single, double, slide-and-return) get a wider auto-miss
    // line — the gesture takes longer than a tap, so the player needs a
    // little more fall room to engage it before it auto-misses. Same
    // 60-px below-target threshold for both 1-lane and 2-lane variants
    // so they feel equally forgiving. Once engaged, slideActive bypasses
    // the check entirely (see below).
    const slideMissY = targetY + 60;
    let anyMissed = false;
    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i]!;
      if (!n.active || n.consumed) continue;
      // Holds being actively held don't auto-miss when the head passes
      // the miss line — the player has already tapped and the tail is
      // what's being judged now. tickHolds handles auto-end when the
      // tail crosses.
      if (n.isHold && n.holdActive) continue;
      // Slides being actively dragged get a much more forgiving miss
      // line (off-screen) since the gesture takes longer than a tap.
      // Released slides fall through to the normal miss check.
      if (n.isSlide && n.slideActive) continue;
      const noteMissY = n.isSlide ? slideMissY : missY;
      if (n.y > noteMissY) {
        this.score.registerHit('miss');
        // Same miss-buzz as a tap-but-missed grade so the player feels
        // a consistent "you lost that note" signal whether they tapped
        // wrong or didn't tap at all.
        this.music?.playMiss();
        this.cats[n.laneId]?.playAngry(Balance.catReactionMs);
        this.cats[n.laneId]?.pulseEffectMiss();
        this.showHitFeedback(n.laneId, 'miss');
        this.flashTarget(n.laneId, 'miss');
        n.recycle();
        anyMissed = true;
      }
    }
    if (anyMissed) {
      this.pulseCombo();
      this.updateHud();
    }
  }

  // -----------------------------------------------------------------------
  // Private — hold tracking
  // -----------------------------------------------------------------------

  /** Per-frame visibility + jitter pass for ALL alive hold notes
   *  (engaged or not). Clips the tail to the lane band so nothing
   *  bleeds into the cat-stage area, hides the head once it's past
   *  the disappear line, and applies the vibration cue to engaged
   *  hold tails. Cheap — short iteration over the pool. */
  private updateHoldVisuals(): void {
    if (this.roundOver) return;
    const scaleY = this.scale.height / L.DESIGN_H;
    const laneTopY = L.LANE_TOP_Y * scaleY;
    const targetY = L.HIT_LINE_Y * scaleY;
    const disappearY = targetY + 30;
    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i]!;
      if (!n.active || !n.isHold) continue;
      n.updateHoldVisuals(laneTopY, targetY, disappearY, Balance.holdJitterPx);
    }
  }

  /** Per-frame check for active holds whose trailing edge has reached
   *  the target. Auto-ends those with full credit. Also re-fires the
   *  lane effect + cat pulse on a fixed cadence so the hold feels
   *  satisfying instead of static. Release-on-finger-up is handled
   *  by releaseHoldIfAny. */
  private tickHolds(): void {
    if (this.roundOver) return;
    const now = this.time.now - this.startTimeMs;
    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i]!;
      if (!n.active || !n.isHold || !n.holdActive) continue;
      // Recurring effect burst while held — same flashLaneEffect +
      // cat pulse the head tap fires, throttled to ~220 ms. Each tick
      // also accrues a chunk of hold score proportional to elapsed
      // time (replaces the old end-of-hold lump sum) and pops a tiny
      // "+N" popup at the catch line so the player sees the score
      // climbing live — makes holds feel rewarding while in progress.
      const dt = now - n.holdLastEffectMs;
      if (dt >= Balance.holdEffectIntervalMs) {
        const points = Math.round(dt * (Balance.pointsPerHoldStep / this.playMsPerStep));
        if (points > 0) {
          this.score.add(points);
          this.showHoldScorePop(n, points);
        }
        this.flashLaneEffect(n.laneId);
        this.cats[n.laneId]?.pulseEffectHit();
        this.burstEffectOnTail(n);
        n.holdLastEffectMs = now;
        this.updateHud();
      }
      if (now >= n.holdEndAtMs) {
        this.endActiveHold(n, /* fullCredit */ true);
      }
    }
  }

  /** Called from per-lane pointerup / pointerout / keyup. Ends any
   *  active hold in that lane with partial credit (forgiving rule). */
  private releaseHoldIfAny(laneId: LaneId): void {
    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i]!;
      if (!n.active || !n.isHold || !n.holdActive || n.laneId !== laneId) continue;
      this.endActiveHold(n, /* fullCredit */ false);
    }
  }

  /** Flush any unfired time since the last cadence tick and recycle
   *  the note. Scoring is now continuous via tickHolds, so endActive
   *  only needs to award the trailing remainder between the last tick
   *  and the release/auto-end moment (max ~220 ms worth). */
  private endActiveHold(note: Note, _fullCredit: boolean): void {
    const now = this.time.now - this.startTimeMs;
    const dt = now - note.holdLastEffectMs;
    if (dt > 0) {
      const points = Math.round(dt * (Balance.pointsPerHoldStep / this.playMsPerStep));
      if (points > 0) {
        this.score.add(points);
        this.showHoldScorePop(note, points);
      }
    }
    note.holdActive = false;
    note.consumed = true;
    note.recycle();
    this.updateHud();
  }

  /** One-shot tiny "+N" popup at the TOP of the hold's visible tail
   *  (not at the catch) — used by hold ticks to show score climbing
   *  where the player's eye is following the tail's trailing edge.
   *  Auto-destroys after the float-up + fade. */
  private showHoldScorePop(note: Note, points: number): void {
    const scaleY = this.scale.height / L.DESIGN_H;
    const laneTopY = L.LANE_TOP_Y * scaleY;
    const cx = L.laneCenterX(note.laneId, this.scale.width);
    // Tail top in world space, clipped to the lane band (so the popup
    // doesn't spawn above the lane). Falls back to a sensible spot at
    // the lane top if the tail isn't measurable yet.
    const tailTopWorld = Math.max(note.y - note.currentTailHeight, laneTopY);
    const txt = this.add
      .text(cx, tailTopWorld, `+${points}`, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '9px',
        color: '#4dffb4',
        stroke: '#1a0a2e',
        strokeThickness: 2,
      })
      .setOrigin(0.5)
      .setDepth(50);
    this.tweens.add({
      targets: txt,
      y: tailTopWorld - 24,
      alpha: 0,
      duration: 450,
      ease: 'Quad.easeOut',
      onComplete: () => txt.destroy(),
    });
  }

  // -----------------------------------------------------------------------
  // Private — cleanup
  // -----------------------------------------------------------------------

  private cleanedUp = false;
  private cleanup(): void {
    // Guard against double-fire. Phaser only fires SHUTDOWN once per
    // shutdown, but if scene.start is called from inside a tween's
    // onComplete (or from a drawer item that's mid-animation), edge cases
    // can re-enter. Better to short-circuit than to destroy twice.
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    console.info('[Game] cleanup start');
    try {
      this.doCleanup();
      console.info('[Game] cleanup done');
    } catch (err) {
      // If any cleanup step throws, the rest gets skipped — that's how
      // input listeners leak into the next scene and freeze it. Log
      // loudly so we can see which step failed in the playtest console.
      console.error('[Game] cleanup threw — next scene may be broken:', err);
    }
  }

  private doCleanup(): void {

    // hud FIRST so its drawer panel/scrim get force-destroyed before any
    // tweens.killAll wipes the close animation that would otherwise
    // destroy them. The orphaned interactive scrim eats every click in
    // the next scene and the game appears frozen.
    // Each step is wrapped so one throw can't halt the rest — that's
    // exactly what was leaking Game's input listeners into Decorate and
    // freezing it. tearDown() logs the failing step name so the playtest
    // console points at the culprit on the next freeze report.
    const tearDown = (name: string, fn: () => void): void => {
      try {
        fn();
      } catch (err) {
        console.error(`[Game] cleanup step "${name}" threw:`, err);
      }
    };

    tearDown('hud', () => this.hud?.destroy());
    tearDown('summary', () => {
      this.summary?.destroy(true);
      this.summary = null;
    });
    tearDown('generate-modal', () => {
      this.generateModal?.destroy();
      this.generateModal = null;
    });
    tearDown('settings-modal', () => {
      this.settingsModal?.destroy();
      this.settingsModal = null;
    });
    tearDown('comment-modal', () => {
      this.commentModal?.destroy();
      this.commentModal = null;
    });
    tearDown('published-modal', () => {
      this.publishedModal?.destroy();
      this.publishedModal = null;
    });
    tearDown('song-picker', () => {
      this.songPicker?.destroy();
      this.songPicker = null;
    });
    tearDown('difficulty-picker', () => {
      this.difficultyPicker?.destroy();
      this.difficultyPicker = null;
    });
    tearDown('back-to-chart-chip', () => {
      for (const g of this.backToChartChip) g.destroy();
      this.backToChartChip = [];
    });

    // Destroy entities BEFORE tweens.killAll so each owner can cleanly
    // stop+remove its own tweens. Cat → effect.destroy() calls
    // `tween.stop()` / `tween.remove()` — if we'd killed the tween
    // already, those calls on a freed tween instance can throw.
    tearDown('cats', () => {
      for (const c of this.cats) c.destroy();
      this.cats = [];
    });
    tearDown('notes', () => {
      for (const n of this.notes) n.recycle();
      this.notes = [];
    });
    tearDown('lane-rects', () => {
      for (const r of this.laneRects) r.destroy();
      this.laneRects = [];
    });
    tearDown('hit-targets', () => {
      for (const t of this.hitTargets) t.destroy();
      this.hitTargets = [];
    });
    tearDown('hit-feedback', () => {
      for (const t of this.hitFeedbackTexts) t.destroy();
      this.hitFeedbackTexts = [];
    });
    tearDown('combo-text', () => this.comboText?.destroy());
    tearDown('tap-zones', () => {
      for (const z of this.tapZones) z.destroy();
      this.tapZones = [];
    });
    tearDown('name-labels', () => {
      for (const l of this.seatedNameLabels) l.destroy();
      this.seatedNameLabels = [];
    });
    tearDown('background', () => this.bg?.destroy());
    tearDown('song-player', () => {
      this.music?.destroy();
      this.music = null;
    });

    // Now safe to wipe any remaining tweens / timers / input.
    tearDown('tweens', () => this.tweens.killAll());
    tearDown('timers', () => this.time.removeAllEvents());
    tearDown('input', () => {
      this.input.removeAllListeners();
      this.input.keyboard?.removeAllListeners();
    });
    tearDown('scale-resize', () => this.scale.off('resize'));
  }

  /** Open the SETTINGS modal from the hamburger drawer. Lazy-instantiated
   *  so the modal + its preview timer only spin up when the player opens
   *  it. Scene cleanup tears it down via the tearDown('settings-modal')
   *  block above. */
  private openSettings(): void {
    if (!this.settingsModal) this.settingsModal = new SettingsModal(this);
    this.settingsModal.open();
  }
}


