import { Scene, Scenes } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { Cat } from '@/entities/cat';
import { Note } from '@/entities/note';
import { BackgroundManager } from '@/entities/background-manager';
import { ChartPlayer } from '@/systems/chart-player';
import { ScoreSystem } from '@/systems/score-system';
import { TopHud } from '@/ui/top-hud';
import * as L from '@/constants/scene-layout';
import { Balance } from '@/constants/balance';
import { fetchState, loadChart } from '@/services/state-client';
import { CAT_CATALOG, emptyChart } from '@/../shared/state';
import type { PlayerState, LaneId, Chart, CatBreed, SeatId } from '@/../shared/state';
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
  private laneRects: Phaser.GameObjects.Rectangle[] = [];
  private tapZones: Phaser.GameObjects.Rectangle[] = [];
  private notes: Note[] = [];
  private hud!: TopHud;
  private player!: ChartPlayer;
  private score!: ScoreSystem;
  private startTimeMs = 0;
  private roundOver = false;

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
    this.laneRects = [];
    this.tapZones = [];
    this.notes = [];
    this.roundOver = false;
    this.startTimeMs = 0;
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
    this.buildSummaryOverlay();

    // Pre-warm note pool — avoids allocations during first 12 spawns
    for (let i = 0; i < 12; i++) {
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

  /** Draw 3 translucent vertical lane backdrops + hit line for each lane. */
  private drawLanes(): void {
    const { width, height } = this.scale;
    // Scale design coords to actual canvas size.
    const scaleY = height / L.DESIGN_H;
    const laneTopY = L.LANE_TOP_Y * scaleY;
    const laneH = (L.LANE_BOTTOM_Y - L.LANE_TOP_Y) * scaleY;
    const hitLineY = L.HIT_LINE_Y * scaleY;

    const inner = width - L.LANE_GUTTER_PX * 2;
    const colW = (inner - L.LANE_GAP_PX * (L.LANE_COUNT - 1)) / L.LANE_COUNT;

    for (let i = 0; i < L.LANE_COUNT; i++) {
      const cx = L.laneCenterX(i as 0 | 1 | 2, width);
      const color = L.LANE_COLORS[i]!;

      // Translucent lane backdrop
      const lane = this.add.rectangle(cx, laneTopY + laneH / 2, colW, laneH, color, 0.12);
      lane.setStrokeStyle(1.5, color, 0.35);
      this.laneRects.push(lane);

      // Solid hit line at the bottom of the lane
      const hitLine = this.add.rectangle(cx, hitLineY, colW - 4, 3, color, 0.9);
      hitLine.setStrokeStyle(0);
      this.laneRects.push(hitLine);
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
    // Cat anchor: bottom-center of sprite, placed in the lower half of the
    // cat stage so the cat body sits above the lane top.
    const catY = (L.TOP_HUD_H + L.CAT_STAGE_H * 0.88) * scaleY;

    const seatedCats = this.playerState?.seatedCats ?? {};
    // Collect seated cats in a deterministic left-to-right seat order, capped at 3.
    const SEAT_ORDER: SeatId[] = ['seat-left', 'seat-center', 'seat-right'];
    const catIds = SEAT_ORDER
      .map((seatId) => seatedCats[seatId])
      .filter((id): id is CatBreed => Boolean(id))
      .slice(0, 3);

    for (let i = 0; i < catIds.length; i++) {
      const catId = catIds[i]!;
      const catEntry = CAT_CATALOG.find((c) => c.id === catId);
      if (!catEntry) continue;

      const laneIndex = i as 0 | 1 | 2;
      const cx = L.laneCenterX(laneIndex, width);

      const model: CatModel = {
        id: `lane-cat-${i}`,
        breed: catId,
        animation: 'idle',
        restingAnimation: 'idle',
        x: cx,
        y: catY,
      };
      // Equip cosmetic if the player has one for this cat.
      const equippedCosmetic = this.playerState?.equippedCosmetics?.[catId];
      if (equippedCosmetic) {
        model.equippedCosmetic = equippedCosmetic;
      }

      const cat = new Cat(this, model);
      cat.setPosition(cx, catY);
      this.cats.push(cat);
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
        {
          label: 'Edit Chart',
          description: 'Compose your beat',
          icon: '🎵',
          onTap: () => this.scene.start(SceneKeys.Game), // placeholder; Task 12 routes to ChartEditor
        },
        {
          label: 'Buy Boxes',
          description: 'Unlock cats and cosmetics',
          icon: '📦',
          onTap: () => this.scene.start(SceneKeys.Boxes, { playerState: this.playerState }),
        },
      ],
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

  private onSkipClicked = (): void => {
    this.scene.start(SceneKeys.HouseEditor); // routes to Decorate (Task 13 rename)
  };

  private onPostCommentClicked = (): void => {
    console.info('[Game] Post Comment clicked. Score:', this.score.get());
    // Real Devvit comment post wiring comes later (out of scope for Task 11).
    this.onSkipClicked();
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

    if (!chart) {
      // dev fallback chart — gives the player something to hit during local dev
      const dev = emptyChart('dev', 'test');
      dev.steps[0] = { lanes: [0] };
      dev.steps[2] = { lanes: [1] };
      dev.steps[4] = { lanes: [2] };
      dev.steps[6] = { lanes: [0, 2] };
      chart = dev;
    }

    this.player = new ChartPlayer(chart, {
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
    note.configure(
      laneId,
      x,
      L.LANE_TOP_Y * scaleY,
      L.HIT_LINE_Y * scaleY,
      Balance.noteFallMs,
      hitAtMs,
    );
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
    if (!note) return; // mistaps don't reset combo in v1
    const dt = Math.abs(now - note.hitAtMs);
    if (dt <= Balance.perfectWindowMs) {
      this.score.registerHit('perfect');
      this.cats[laneId]?.playHappy(Balance.catReactionMs);
    } else if (dt <= Balance.greatWindowMs) {
      this.score.registerHit('great');
      this.cats[laneId]?.playHappy(Balance.catReactionMs);
    } else {
      return; // out of window — leave the note for miss detection
    }
    note.consumed = true;
    note.recycle();
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
    const now = this.time.now - this.startTimeMs;
    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i]!;
      if (!n.active || n.consumed) continue;
      if (now - n.hitAtMs > Balance.greatWindowMs) {
        this.score.registerHit('miss');
        this.cats[n.laneId]?.playAngry(Balance.catReactionMs);
        n.recycle();
      }
    }
  }

  // -----------------------------------------------------------------------
  // Private — cleanup
  // -----------------------------------------------------------------------

  private cleanup(): void {
    this.tweens.killAll();
    this.time.removeAllEvents();
    this.input.removeAllListeners();
    this.input.keyboard?.removeAllListeners();
    this.scale.off('resize');
    for (const r of this.laneRects) r.destroy();
    this.laneRects = [];
    for (const z of this.tapZones) z.destroy();
    this.tapZones = [];
    for (const n of this.notes) n.recycle();
    this.notes = [];
    for (const c of this.cats) c.destroy();
    this.cats = [];
    this.bg?.destroy();
    this.hud?.destroy();
    this.summary?.destroy(true);
    this.summary = null;
  }
}
