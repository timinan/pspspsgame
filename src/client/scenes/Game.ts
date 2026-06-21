import { Scene, Scenes } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { Cat } from '@/entities/cat';
import { BackgroundManager } from '@/entities/background-manager';
import { ChartPlayer } from '@/systems/chart-player';
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
  private hud!: TopHud;
  private player!: ChartPlayer;
  private spawnCount = 0; // dev counter — replaced by real score in Task 10

  constructor() {
    super(SceneKeys.Game);
  }

  init(data: { playerState?: PlayerState | null }): void {
    this.playerState = data?.playerState ?? null;
    this.spawnCount = 0;
    this.cats = [];
    this.laneRects = [];
  }

  async create(): Promise<void> {
    // Background
    this.bg = new BackgroundManager(this);
    this.bg.create();
    const activeBg = this.registry.get('activeBackground') ?? 'default';
    this.bg.setBackground(activeBg);

    this.drawLanes();
    this.seatCats();
    this.buildHud();
    this.bindInput();
    await this.initChartPlayer();

    this.events.on(Scenes.Events.SHUTDOWN, () => this.cleanup());
  }

  override update(_time: number, delta: number): void {
    this.player.advance(delta);
    // Task 10: checkMisses, endRound when player.isFinished()
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
    // Task 10 wires tap zones per lane. Nothing live here yet.
    // Input listeners are registered in SHUTDOWN-safe pattern:
    // they will be removed in cleanup() via input.removeAllListeners().
  }

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
      chart = emptyChart('dev', 'dev');
    }

    this.player = new ChartPlayer(chart, {
      loopCount: Balance.loopCount,
      noteFallMs: Balance.noteFallMs,
    });

    this.player.onSpawn((lane, hitAt) => this.spawnNoteStub(lane, hitAt));
  }

  private spawnNoteStub(_lane: LaneId, _hitAt: number): void {
    // Task 10 replaces this with real note pool spawning.
    this.spawnCount++;
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
    for (const c of this.cats) c.destroy();
    this.cats = [];
    this.bg?.destroy();
    this.hud?.destroy();
  }
}
