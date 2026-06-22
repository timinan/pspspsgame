import { Scene, Scenes } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { Cat } from '@/entities/cat';
import { Note } from '@/entities/note';
import { BackgroundManager } from '@/entities/background-manager';
import { ChartPlayer } from '@/systems/chart-player';
import { ScoreSystem } from '@/systems/score-system';
import { TopHud } from '@/ui/top-hud';
import * as L from '@/constants/scene-layout';
import { AssetKeys } from '@/constants/assets';
import { Balance } from '@/constants/balance';
import { fetchState, loadChart } from '@/services/state-client';
import { CAT_CATALOG } from '@/../shared/state';
import type { PlayerState, LaneId, Chart, SeatId } from '@/../shared/state';
import type { CatModel } from '@/types/game';

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
  private bg!: BackgroundManager;
  private cats: Cat[] = [];
  /** Name labels rendered below each seated cat (matches Decorate preview). */
  private seatedNameLabels: Phaser.GameObjects.Text[] = [];
  private laneRects: Phaser.GameObjects.Rectangle[] = [];
  /** Hit targets per lane — kept separate so we can flash them on hit/miss. */
  private hitTargets: Phaser.GameObjects.Image[] = [];
  /** Base scale of each hit target so flashTarget can always reset to it
   *  instead of compounding off whatever the previous (possibly killed mid-yoyo)
   *  tween left behind. setDisplaySize sets a non-1 scale, so we capture it. */
  private hitTargetBaseScale: number[] = [];
  private tapZones: Phaser.GameObjects.Rectangle[] = [];
  private notes: Note[] = [];
  private hud!: TopHud;
  private player!: ChartPlayer;
  private score!: ScoreSystem;
  private startTimeMs = 0;
  private roundOver = false;

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

  constructor() {
    super(SceneKeys.Game);
  }

  init(data: { playerState?: PlayerState | null }): void {
    this.playerState = data?.playerState ?? null;
    this.cats = [];
    this.seatedNameLabels = [];
    this.laneRects = [];
    this.hitTargets = [];
    this.hitTargetBaseScale = [];
    this.tapZones = [];
    this.notes = [];
    this.hitFeedbackTexts = [];
    this.roundOver = false;
    this.startTimeMs = 0;
    this.cleanedUp = false;
  }

  async create(): Promise<void> {
    // Reset score per round
    this.score = new ScoreSystem();

    // Background
    this.bg = new BackgroundManager(this);
    this.bg.create();
    const activeBg = this.registry.get('activeBackground') ?? 'default';
    this.bg.setBackground(activeBg);

    this.drawLanes();
    this.seatCats();
    this.buildHud();
    this.buildFeedback();
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

    await this.initChartPlayer();

    this.bindInput();

    this.startTimeMs = this.time.now;

    this.events.on(Scenes.Events.SHUTDOWN, () => this.cleanup());
  }

  override update(_time: number, delta: number): void {
    if (this.roundOver) return;
    this.player.advance(delta);
    this.checkMisses();
    if (this.player.isFinished()) this.endRound();
  }

  // -----------------------------------------------------------------------
  // Private — layout
  // -----------------------------------------------------------------------

  /**
   * Draw 3 vertical lane backdrops + the original "fuzzy ball" hit target
   * for each lane. Reuses the Phase 1 rhythm assets (RhythmBarBackground,
   * PspspsTarget) so the visuals match the rest of the game.
   */
  private drawLanes(): void {
    const { width, height } = this.scale;
    const scaleY = height / L.DESIGN_H;
    const laneTopY = L.LANE_TOP_Y * scaleY;
    const laneH = (L.LANE_BOTTOM_Y - L.LANE_TOP_Y) * scaleY;
    const hitLineY = L.HIT_LINE_Y * scaleY;

    const inner = width - L.LANE_GUTTER_PX * 2;
    const colW = (inner - L.LANE_GAP_PX * (L.LANE_COUNT - 1)) / L.LANE_COUNT;

    for (let i = 0; i < L.LANE_COUNT; i++) {
      const cx = L.laneCenterX(i as 0 | 1 | 2, width);
      const color = L.LANE_COLORS[i]!;

      // Lane backdrop: the original Phase 1 rhythm bar track rotated -90°
      // (was +90°, which rendered the track upside down — the texture's
      // "open" end pointed up instead of down). Pre-rotation
      // displayWidth/Height are swapped from the visual we want — after
      // rotation the texture's horizontal axis becomes the lane's vertical
      // axis.
      const bar = this.add.image(cx, laneTopY + laneH / 2, AssetKeys.Image.RhythmBarBackground);
      bar.displayWidth = laneH;
      bar.displayHeight = colW;
      bar.setRotation(-Math.PI / 2);
      bar.setTint(color);
      this.laneRects.push(bar as unknown as Phaser.GameObjects.Rectangle);

      // Hit target at the bottom of the lane — the original "fuzzy ball"
      // target from horizontal rhythm. Notes get consumed when they reach it.
      const target = this.add.image(cx, hitLineY, AssetKeys.Image.PspspsTarget);
      target.setDisplaySize(72, 72);
      target.setTint(color);
      this.hitTargets[i] = target;
      // Snapshot the base scale after setDisplaySize so flash tweens always
      // start from the same value instead of compounding off prior inflations.
      this.hitTargetBaseScale[i] = target.scaleX;
    }
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

  private buildSummaryOverlay(): void {
    const { width, height } = this.scale;
    const cx = width / 2;
    const cy = height / 2;

    const container = this.add.container(0, 0).setDepth(300).setVisible(false);

    // Full-canvas semi-transparent backdrop
    const backdrop = this.add.rectangle(cx, cy, width, height, 0x000000, 0.7);
    container.add(backdrop);

    // Centered panel
    const panelW = Math.min(280, width - 32);
    const panelH = 300;
    const panel = this.add.rectangle(cx, cy, panelW, panelH, 0x1a0a2e, 1);
    panel.setStrokeStyle(2, 0xc678ff, 0.8);
    container.add(panel);

    const fontBase = { fontFamily: 'Pixeloid Sans, sans-serif' };

    // Title
    const title = this.add.text(cx, cy - 122, 'CHALLENGE COMPLETE', {
      ...fontBase,
      fontStyle: 'bold',
      fontSize: '13px',
      color: '#ffd34d',
    }).setOrigin(0.5, 0);
    container.add(title);

    // Divider line
    const divider = this.add.rectangle(cx, cy - 104, panelW - 32, 1, 0xc0a0e6, 0.3);
    container.add(divider);

    // Final score label + value
    const scoreLabel = this.add.text(cx, cy - 94, 'FINAL SCORE', {
      ...fontBase,
      fontSize: '10px',
      color: '#c0a0e6',
    }).setOrigin(0.5, 0);
    container.add(scoreLabel);

    this.summaryScoreText = this.add.text(cx, cy - 78, '0', {
      ...fontBase,
      fontStyle: 'bold',
      fontSize: '32px',
      color: '#ffffff',
    }).setOrigin(0.5, 0);
    container.add(this.summaryScoreText);

    // Stats row: accuracy / max combo / misses
    const statsY = cy - 18;
    const col = panelW / 3;
    const statLabels = ['ACCURACY', 'MAX COMBO', 'MISSES'];
    const statXs = [cx - col, cx, cx + col];

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
      fontSize: '16px',
      color: '#4dffb4',
    }).setOrigin(0.5, 0);
    container.add(this.summaryAccuracyText);

    this.summaryComboText = this.add.text(statXs[1]!, statsY + 14, 'x0', {
      ...fontBase,
      fontStyle: 'bold',
      fontSize: '16px',
      color: '#ffd34d',
    }).setOrigin(0.5, 0);
    container.add(this.summaryComboText);

    this.summaryMissesText = this.add.text(statXs[2]!, statsY + 14, '0', {
      ...fontBase,
      fontStyle: 'bold',
      fontSize: '16px',
      color: '#ff6b6b',
    }).setOrigin(0.5, 0);
    container.add(this.summaryMissesText);

    // Buttons
    const btnY = cy + 86;
    const btnW = 110;
    const btnH = 38;
    const btnGap = 12;

    // Skip button
    const skipBg = this.add.rectangle(
      cx - btnW / 2 - btnGap / 2, btnY, btnW, btnH, 0x2c1856, 1,
    ).setInteractive({ useHandCursor: true });
    skipBg.setStrokeStyle(1, 0xc0a0e6, 0.5);
    const skipText = this.add.text(
      cx - btnW / 2 - btnGap / 2, btnY, 'Skip', {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '14px',
        color: '#c0a0e6',
      },
    ).setOrigin(0.5);
    container.add([skipBg, skipText]);
    skipBg.on('pointerover', () => skipBg.setFillStyle(0x3d2566, 1));
    skipBg.on('pointerout', () => skipBg.setFillStyle(0x2c1856, 1));
    skipBg.on('pointerdown', this.onSkipClicked);

    // Post Comment button
    const postBg = this.add.rectangle(
      cx + btnW / 2 + btnGap / 2, btnY, btnW, btnH, 0xffd34d, 1,
    ).setInteractive({ useHandCursor: true });
    const postText = this.add.text(
      cx + btnW / 2 + btnGap / 2, btnY, 'Post Comment', {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '11px',
        color: '#1a0a2e',
      },
    ).setOrigin(0.5);
    container.add([postBg, postText]);
    postBg.on('pointerover', () => postBg.setFillStyle(0xffe680, 1));
    postBg.on('pointerout', () => postBg.setFillStyle(0xffd34d, 1));
    postBg.on('pointerdown', this.onPostCommentClicked);

    this.summary = container;
  }

  private buildHud(): void {
    this.hud = new TopHud(this, {
      showStats: true,
      items: [
        // PLAY (self) is omitted — no point reloading the current scene
        {
          label: 'DECORATE',
          description: 'Cats & background',
          icon: '😺',
          onTap: () => this.scene.start(SceneKeys.Decorate, { playerState: this.playerState }),
        },
        {
          label: 'POST',
          description: 'Build a beat',
          icon: '🎼',
          onTap: () => this.scene.start(SceneKeys.ChartEditor, { playerState: this.playerState }),
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
          fontSize: '14px',
          color: '#ffffff',
          stroke: '#000000',
          strokeThickness: 3,
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
  }

  /** Refresh score / coins / best in the TopHud. Cheap — call after every
   *  judged tap or miss instead of every frame. */
  private updateHud(): void {
    const coins = this.playerState?.coins ?? 0;
    const best = this.playerState?.bestScore ?? 0;
    this.hud.setStats(this.score.get(), coins, Math.max(best, this.score.get()));
  }

  /** Punch the lane's hit target on a tap so the player sees their action
   *  registered even if no note was present. Grade controls the tint flash.
   *  Always reads from `hitTargetBaseScale` so back-to-back taps that kill
   *  a mid-yoyo tween don't compound the scale. */
  private flashTarget(laneId: LaneId, grade: 'perfect' | 'great' | 'miss'): void {
    const target = this.hitTargets[laneId];
    const base = this.hitTargetBaseScale[laneId];
    if (!target || base === undefined) return;
    const baseTint = L.LANE_COLORS[laneId]!;
    const flashTint =
      grade === 'perfect' ? 0xffffff : grade === 'great' ? 0xffd34d : 0xff6b6b;
    target.setTint(flashTint);
    this.tweens.killTweensOf(target);
    // Reset to the captured base scale BEFORE tweening so a killed mid-yoyo
    // can't leave the target permanently inflated.
    target.setScale(base);
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
      },
    });
  }

  /** Pop the lane's grade text and float it upward. Reuses the same Text
   *  object — last tween wins if the player double-taps in the same lane. */
  private showHitFeedback(laneId: LaneId, grade: 'perfect' | 'great' | 'miss'): void {
    const txt = this.hitFeedbackTexts[laneId];
    if (!txt) return;
    const label =
      grade === 'perfect' ? 'PERFECT!' : grade === 'great' ? 'GREAT' : 'MISS';
    const color =
      grade === 'perfect' ? '#ffffff' : grade === 'great' ? '#ffd34d' : '#ff6b6b';
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

  /** Pop the combo callout. Hides itself when combo drops to 0. */
  private pulseCombo(): void {
    const combo = this.score.getCombo();
    if (combo <= 0) {
      this.tweens.killTweensOf(this.comboText);
      this.comboText.setAlpha(0);
      return;
    }
    this.comboText.setText(`x${combo} COMBO`);
    this.tweens.killTweensOf(this.comboText);
    this.comboText.setAlpha(1);
    this.comboText.setScale(1.3);
    this.tweens.add({
      targets: this.comboText,
      scale: 1,
      duration: 140,
      ease: 'Back.easeOut',
    });
  }

  private bindInput(): void {
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
      zone.on('pointerdown', () => this.registerTap(laneId));
      this.tapZones.push(zone);
    }

    // Keyboard mirrors: 1/2/3 keys map to lanes 0/1/2
    this.input.keyboard?.on('keydown-ONE', () => this.registerTap(0));
    this.input.keyboard?.on('keydown-TWO', () => this.registerTap(1));
    this.input.keyboard?.on('keydown-THREE', () => this.registerTap(2));
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
    this.showSummary();
  }

  private showSummary(): void {
    if (!this.summary) return;
    this.summaryScoreText.setText(String(this.score.get()));
    const accuracyPct = this.score.getAccuracy();
    this.summaryAccuracyText.setText(`${accuracyPct.toFixed(0)}%`);
    this.summaryComboText.setText(`x${this.score.getMaxCombo()}`);
    this.summaryMissesText.setText(String(this.score.getMisses()));
    this.summary.setVisible(true);
  }

  // Skip = "play again" for now. Decorate has its own nav via the hamburger.
  // Both buttons restart the scene with the same playerState so the player
  // can immediately retry without bouncing through Decorate.
  private onSkipClicked = (): void => {
    this.scene.restart({ playerState: this.playerState });
  };

  private onPostCommentClicked = (): void => {
    console.info('[Game] Post Comment clicked. Score:', this.score.get());
    // Real Devvit comment post wiring comes later. Same retry behavior for now.
    this.scene.restart({ playerState: this.playerState });
  };

  // -----------------------------------------------------------------------
  // Private — chart
  // -----------------------------------------------------------------------

  /**
   * Load the chart and wire ChartPlayer.
   * Priority: registry.hostChart → loadChart(hostUsername) → emptyChart dev stub.
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

    // If we got a chart but it's empty (player hasn't authored one yet),
    // generate a random pattern so they can play immediately. Authored
    // charts (with any non-empty step) bypass this and play as-is.
    const isEmptyChart = !chart || chart.steps.every((s) => s.lanes.length === 0);
    const playChart: Chart = isEmptyChart ? makeRandomChart() : chart!;

    this.player = new ChartPlayer(playChart, {
      loopCount: Balance.loopCount,
      noteFallMs: Balance.noteFallMs,
    });

    this.player.onSpawn((lane, hitAt) => this.spawnNote(lane, hitAt));
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
    note.configure(laneId, x, startY, endY, totalFallMs, hitAtMs);
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

  private registerTap(laneId: LaneId): void {
    if (this.roundOver) return;
    const now = this.time.now - this.startTimeMs;
    const note = this.activeNoteInLane(laneId, now);
    if (!note) return; // empty lane — no penalty, just no-op
    // Any tap on an active note in the lane registers. Tight window =
    // perfect, anything else along the ball's fall is a great. Miss is
    // reserved for balls that leave the screen entirely.
    const dt = Math.abs(now - note.hitAtMs);
    const grade: 'perfect' | 'great' = dt <= Balance.perfectWindowMs ? 'perfect' : 'great';
    this.score.registerHit(grade);
    this.cats[laneId]?.playMeow(Balance.catReactionMs);
    note.consumed = true;
    note.recycle();
    this.showHitFeedback(laneId, grade);
    this.flashTarget(laneId, grade);
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
    // Miss is now position-based — the ball must leave the screen
    // entirely before it counts. A late tap as the ball exits the target
    // still counts as a great in registerTap.
    const offScreenY = this.scale.height + 20;
    let anyMissed = false;
    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i]!;
      if (!n.active || n.consumed) continue;
      if (n.y > offScreenY) {
        this.score.registerHit('miss');
        this.cats[n.laneId]?.playAngry(Balance.catReactionMs);
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

    // Now safe to wipe any remaining tweens / timers / input.
    tearDown('tweens', () => this.tweens.killAll());
    tearDown('timers', () => this.time.removeAllEvents());
    tearDown('input', () => {
      this.input.removeAllListeners();
      this.input.keyboard?.removeAllListeners();
    });
    tearDown('scale-resize', () => this.scale.off('resize'));
  }
}

/**
 * Generate a random 8-step chart for players who haven't authored one yet.
 * Faithful to the Phase 1 RhythmSystem feel — 80% of steps fire a note,
 * lanes chosen randomly. Replays deterministically once loaded into
 * ChartPlayer (the player just sees one fresh pattern per round).
 */
function makeRandomChart(): Chart {
  const steps: { lanes: LaneId[] }[] = [];
  for (let i = 0; i < 8; i++) {
    const lanes: LaneId[] = [];
    // 60% spawn rate (was 80%) — gives breathing room while learning.
    if (Math.random() < 0.6) {
      lanes.push(Math.floor(Math.random() * 3) as LaneId);
      // 10% double-tap (was 18%) — two-lane reach is hard to land
      // first-time, save it for authored charts.
      if (Math.random() < 0.1) {
        const second = Math.floor(Math.random() * 3) as LaneId;
        if (!lanes.includes(second)) lanes.push(second);
      }
    }
    steps.push({ lanes });
  }
  return {
    authorId: 'random',
    title: 'random',
    stepCount: 8,
    // 90bpm (was 120) — feels like a slow groove instead of a sprint.
    // Pairs with noteFallMs 2400 so peak density is ~6 notes on screen.
    bpm: 90,
    steps,
    updatedAt: Date.now(),
  };
}
