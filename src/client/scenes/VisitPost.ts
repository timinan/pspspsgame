import { Scene, Scenes, GameObjects } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { BackgroundManager } from '@/entities/background-manager';
import { Cat } from '@/entities/cat';
import { TopHud } from '@/ui/top-hud';
import * as L from '@/constants/scene-layout';
import { CAT_CATALOG } from '@/../shared/state';
import type { Chart, PlayerState, SeatId } from '@/../shared/state';
import type { CatModel } from '@/types/game';
import { fetchVisit, type VisitData } from '@/services/visit-client';
import { loadChart } from '@/services/state-client';
import { fetchLeaderboard } from '@/services/social-client';
import type { LeaderboardEntry } from '@/../shared/social-loop';
import { requestExpandedMode } from '@devvit/web/client';

/**
 * Visitor splash for a posted show. Boot routing lands here when a
 * player opens someone else's Devvit post. Mirrors Honk's PLAY-screen
 * pattern but uses the OWNER's stage (their seated cats + chosen
 * background) as the splash backdrop so the visitor immediately reads
 * "this is alice's stage" instead of a generic Meowcert wallpaper.
 *
 * Layout (top → bottom):
 *   1. Top strip — brand mark + "X PLAYS" + ⋯ menu
 *   2. Cat-stage band (upper) — owner's background + seated cats
 *      rendered exactly like Decorate
 *   3. Info panel (lower, where lanes would normally be) — author
 *      attribution, song name, play count, top 3 leaderboard, your
 *      best on this post (if any)
 *   4. Big PLAY button — primary CTA
 *   5. Bottom-left "MAKE YOUR OWN" link — converts viewers into
 *      creators (Honk's BUILD equivalent)
 *
 * Fetch strategy: visit + chart + leaderboard fire in PARALLEL the
 * moment create() runs. Splash paints with placeholders immediately;
 * each section fills in as its fetch resolves. Player can tap PLAY
 * any time — the only hard blocker is the chart fetch (we need the
 * chart to start the round).
 */
const SEAT_ORDER: SeatId[] = ['seat-left', 'seat-center', 'seat-right'];

interface VisitInitData {
  postId: string;
  playerState?: PlayerState | null;
}

export class VisitPost extends Scene {
  private postId = '';
  private playerState: PlayerState | null = null;
  private bg!: BackgroundManager;
  private hud!: TopHud;
  private cats: Cat[] = [];

  // Data state — populated by parallel fetches.
  private visit: VisitData | null = null;
  private chart: Chart | null = null;
  private leaderboardTop: LeaderboardEntry[] = [];
  private leaderboardTotal = 0;
  private leaderboardYourRank: number | null = null;
  private leaderboardYourScore: number | null = null;

  // UI refs that get refreshed when fetches land.
  private playsText!: GameObjects.Text;
  private authorText!: GameObjects.Text;
  private songText!: GameObjects.Text;
  private statsText!: GameObjects.Text;
  private leaderboardRows: GameObjects.Text[] = [];
  private yourBestText!: GameObjects.Text;
  private playBtnBg!: GameObjects.Rectangle;
  private playBtnText!: GameObjects.Text;
  private playBusy = false;
  /** Invisible native <button> overlaid on the Phaser PLAY visual so
   *  its click is a trusted DOM gesture (Devvit requires this for
   *  requestExpandedMode). Torn down on cleanup. */
  private htmlPlayButton: HTMLButtonElement | null = null;
  private btnPositionHandler: (() => void) | null = null;

  constructor() {
    super(SceneKeys.VisitPost);
  }

  init(data: VisitInitData): void {
    this.postId = data.postId ?? '';
    this.playerState = data.playerState ?? null;
    this.cats = [];
    this.visit = null;
    this.chart = null;
    this.leaderboardTop = [];
    this.leaderboardTotal = 0;
    this.leaderboardYourRank = null;
    this.leaderboardYourScore = null;
    this.leaderboardRows = [];
    this.playBusy = false;
  }

  create(): void {
    this.bg = new BackgroundManager(this);
    this.bg.create();
    // Start with a default background; swap in owner's choice when the
    // visit fetch lands. Splash never goes blank.
    this.bg.setBackground('stage');

    this.buildHud();
    this.buildInfoPanel();
    this.buildPlayButton();
    this.buildBuildLink();

    this.events.once(Scenes.Events.SHUTDOWN, () => this.cleanup());

    // Fire all three fetches in parallel — visit is the heaviest payload
    // and gates the visual (bg + cats), chart unlocks PLAY, leaderboard
    // fills the info panel. Each resolves independently so the visitor
    // sees data trickle in instead of one big wait.
    void this.loadVisit();
    void this.loadLeaderboard();
    // chart load needs the owner username from visit — chained inside
    // loadVisit once the username is known. Faster than blocking here.
  }

  private async loadVisit(): Promise<void> {
    const data = await fetchVisit(this.postId);
    if (!this.scene.isActive() || !data) return;
    this.visit = data;
    // Update bg + seat cats once we know the owner's stage config.
    this.bg.setBackground(data.stage.activeBackground);
    this.seatOwnerCats();
    // Refresh author label.
    this.authorText.setText(`Created by u/${data.ownerUsername}`);
    // Chain the chart fetch off the visit fetch — owner username comes
    // from visit. Fire-and-forget; the play handler waits on this.chart.
    void this.loadChart(data.ownerUsername);
  }

  private async loadChart(authorUsername: string): Promise<void> {
    try {
      const chart = await loadChart(authorUsername);
      if (!this.scene.isActive()) return;
      this.chart = chart;
      this.songText.setText(this.formatSongLine(chart));
    } catch (err) {
      console.warn('[VisitPost] chart load failed:', err);
      this.songText.setText('— song unavailable —');
    }
  }

  private async loadLeaderboard(): Promise<void> {
    const lb = await fetchLeaderboard(this.postId);
    if (!this.scene.isActive() || !lb.ok) return;
    this.leaderboardTop = lb.top ?? [];
    // The leaderboard endpoint doesn't return a totalPlays field today
    // — fall back to top.length for now. (Future: extend the endpoint
    // with a zCard count for the precise total.)
    this.leaderboardTotal = lb.top?.length ?? 0;
    this.leaderboardYourRank = lb.yourRank;
    this.leaderboardYourScore = lb.yourScore;
    this.refreshLeaderboardUi();
  }

  // ─── Visual builders ─────────────────────────────────────────────────

  private buildHud(): void {
    // Minimal TopHud — no stats, no drawer items beyond the global nav.
    // The visitor's hamburger keeps the cross-scene escape hatch so they
    // can leave the post and check their own house.
    this.hud = new TopHud(this, {
      showStats: false,
      currentKey: SceneKeys.VisitPost,
      items: [
        {
          label: 'SET STAGE',
          description: 'Dress your own band',
          icon: '😺',
          key: SceneKeys.Decorate,
          onTap: () => this.scene.start(SceneKeys.Decorate, { playerState: this.playerState }),
        },
        {
          label: 'REHEARSE',
          description: 'Practice on your own time',
          icon: '🎵',
          key: SceneKeys.Game,
          onTap: () => this.scene.start(SceneKeys.Game, { playerState: this.playerState }),
        },
        {
          label: 'PUT ON A SHOW',
          description: 'Cook up your own hit',
          icon: '🎼',
          key: SceneKeys.ChartEditor,
          onTap: () => this.scene.start(SceneKeys.ChartEditor, { playerState: this.playerState }),
        },
      ],
    });

    // "X PLAYS" centered in the TopHud strip. Same depth/stroke pattern
    // as Decorate's SET STAGE label so it reads against any bg.
    const { width } = this.scale;
    this.playsText = this.add.text(width / 2, TopHud.HEIGHT / 2, '— PLAYS', {
      fontFamily: '"Courier New", monospace',
      fontStyle: 'bold',
      fontSize: '12px',
      color: '#ffd34d',
      stroke: '#0b041a',
      strokeThickness: 3,
    }).setOrigin(0.5).setDepth(2010);
  }

  /** Construct a minimal PlayerState-shape from the visit payload so
   *  the existing Cat + cosmetics renderer pipelines work unchanged.
   *  Only seated cats render — the owner's full ownedCats list is
   *  trimmed server-side. */
  private seatOwnerCats(): void {
    for (const c of this.cats) c.destroy();
    this.cats = [];
    if (!this.visit) return;
    const { stage } = this.visit;

    const { width, height } = this.scale;
    const scaleY = height / L.DESIGN_H;
    const catY = (L.TOP_HUD_H + L.CAT_STAGE_H * 0.78) * scaleY;

    for (let i = 0; i < SEAT_ORDER.length; i++) {
      const seatId = SEAT_ORDER[i]!;
      const instanceId = stage.seatedCats[seatId];
      if (!instanceId) continue;

      const catInstance = stage.ownedCats.find((cat) => cat.id === instanceId);
      if (!catInstance) continue;
      if (!CAT_CATALOG.some((c) => c.id === catInstance.breed)) continue;

      const laneIndex = i as 0 | 1 | 2;
      const cx = L.laneCenterX(laneIndex, width);

      const model: CatModel = {
        id: `visit-cat-${i}`,
        breed: catInstance.breed,
        animation: 'idle',
        restingAnimation: 'idle',
        x: cx,
        y: catY,
        scale: 1.4,
      };

      // Resolve cosmetic instance ids → catalog type ids, same as Decorate.
      const slots = stage.equippedCosmetics[instanceId];
      const typeMap = stage.equippedCosmeticTypes ?? {};
      if (slots && Object.keys(slots).length > 0) {
        const resolved: Partial<Record<string, string>> = {};
        for (const [slotKey, cosInstanceId] of Object.entries(slots)) {
          if (!cosInstanceId) continue;
          const typeId = typeMap[instanceId]?.[cosInstanceId];
          if (typeId) resolved[slotKey] = typeId;
        }
        if (Object.keys(resolved).length > 0) model.equippedCosmetics = resolved;
      }

      const cat = new Cat(this, model);
      cat.setPosition(cx, catY);
      this.cats.push(cat);
    }
  }

  private buildInfoPanel(): void {
    const { width, height } = this.scale;
    const scaleY = height / L.DESIGN_H;
    // The info panel takes the TOP portion of the lane band. The
    // bottom ~80 px is reserved for the PLAY button + MAKE YOUR OWN
    // link so they're visible inside the canvas instead of being
    // pushed off-screen below LANE_BOTTOM_Y.
    const laneTopY = L.LANE_TOP_Y * scaleY;
    const laneBottomY = L.LANE_BOTTOM_Y * scaleY;
    const panelW = Math.min(300, width - 24);
    const panelX = (width - panelW) / 2;
    const ctaReservedH = 80 * scaleY;
    const panelH = laneBottomY - laneTopY - ctaReservedH - 12;
    const panelY = laneTopY + 6;

    // Translucent dark panel so cats above still read through subtly.
    const panel = this.add
      .rectangle(panelX + panelW / 2, panelY + panelH / 2, panelW, panelH, 0x1a0a2e, 0.78)
      .setStrokeStyle(2, 0xffd34d, 0.6);
    void panel;

    // Layout inside the panel, top to bottom:
    //   author (15px) → song (10px) → stats (10px) → LB header (10px)
    //   → 3 LB rows (11px each) → your best (10px)
    const padTop = panelY + 16;

    this.authorText = this.add.text(panelX + panelW / 2, padTop, 'Loading…', {
      fontFamily: 'Pixeloid Sans, sans-serif',
      fontStyle: 'bold',
      fontSize: '14px',
      color: '#ffd34d',
    }).setOrigin(0.5, 0);

    this.songText = this.add.text(panelX + panelW / 2, padTop + 22, '— song —', {
      fontFamily: 'Pixeloid Sans, sans-serif',
      fontSize: '10px',
      color: '#c0a0e6',
    }).setOrigin(0.5, 0);

    this.statsText = this.add.text(panelX + panelW / 2, padTop + 40, '', {
      fontFamily: 'Pixeloid Sans, sans-serif',
      fontSize: '10px',
      color: '#ffffff',
    }).setOrigin(0.5, 0);

    // Leaderboard subsection
    const lbY = padTop + 64;
    this.add.text(panelX + 14, lbY, 'TOP SCORES', {
      fontFamily: 'Pixeloid Sans, sans-serif',
      fontStyle: 'bold',
      fontSize: '9px',
      color: '#c0a0e6',
    }).setOrigin(0, 0);

    // Three slots, fill in as data lands. Pre-create the Text objects
    // so refreshLeaderboardUi just updates strings without re-allocing.
    for (let i = 0; i < 3; i++) {
      const row = this.add.text(panelX + 14, lbY + 14 + i * 14, `${i + 1}.   —`, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '11px',
        color: '#ffffff',
      }).setOrigin(0, 0);
      this.leaderboardRows.push(row);
    }

    this.yourBestText = this.add.text(panelX + panelW / 2, lbY + 14 * 3 + 18, '', {
      fontFamily: 'Pixeloid Sans, sans-serif',
      fontStyle: 'bold',
      fontSize: '10px',
      color: '#4dffb4',
    }).setOrigin(0.5, 0);
  }

  private refreshLeaderboardUi(): void {
    // Plays + average accuracy in the stats line.
    this.statsText.setText(`${this.leaderboardTotal} plays`);
    this.playsText.setText(`${this.leaderboardTotal.toLocaleString()} PLAYS`);

    // Fill the 3 LB slots, or show "—" placeholders if fewer entries.
    for (let i = 0; i < 3; i++) {
      const entry = this.leaderboardTop[i];
      if (entry) {
        const rank = `${i + 1}.`.padEnd(3);
        const name = entry.username.length > 18 ? entry.username.slice(0, 16) + '…' : entry.username;
        const score = entry.score.toLocaleString().padStart(7);
        this.leaderboardRows[i]!.setText(`${rank}${name.padEnd(20)}${score}`);
      } else {
        this.leaderboardRows[i]!.setText(`${i + 1}.   —`);
      }
    }

    if (this.leaderboardYourRank !== null && this.leaderboardYourScore !== null) {
      this.yourBestText.setText(`Your best: #${this.leaderboardYourRank} · ${this.leaderboardYourScore.toLocaleString()}`);
    } else {
      this.yourBestText.setText('');
    }
  }

  private buildPlayButton(): void {
    const { width, height } = this.scale;
    const scaleY = height / L.DESIGN_H;
    // PLAY CTA sits in the reserved 80-px band at the bottom of the
    // lane area (was previously below LANE_BOTTOM_Y which is itself
    // DESIGN_H, so the button rendered off-screen and was untappable).
    const ctaY = (L.LANE_BOTTOM_Y * scaleY) - 48;
    const btnW = Math.min(220, width - 56);
    const btnH = 48;

    this.playBtnBg = this.add.rectangle(width / 2, ctaY, btnW, btnH, 0xffd34d, 1);
    this.playBtnText = this.add.text(width / 2, ctaY, '▶  TAP TO PLAY', {
      fontFamily: 'Pixeloid Sans, sans-serif',
      fontStyle: 'bold',
      fontSize: '18px',
      color: '#1a0a2e',
    }).setOrigin(0.5);

    // HTML <button> overlaid invisibly on top of the Phaser PLAY visual
    // so the click event is a TRUSTED DOM gesture (Devvit's
    // requestExpandedMode rejects synthesized Phaser events). Position
    // tracks the canvas + design-coords via the same canvas-rect math
    // the custom-song file-picker overlay uses.
    const btn = document.createElement('button');
    btn.style.position = 'absolute';
    btn.style.opacity = '0';
    btn.style.zIndex = '9999';
    btn.style.border = 'none';
    btn.style.background = 'transparent';
    btn.style.cursor = 'pointer';
    document.body.appendChild(btn);
    this.htmlPlayButton = btn;

    const positionBtn = (): void => {
      const canvas = this.game.canvas;
      const rect = canvas.getBoundingClientRect();
      const sx = rect.width / this.scale.width;
      const sy = rect.height / this.scale.height;
      btn.style.left = `${rect.left + (width / 2 - btnW / 2) * sx}px`;
      btn.style.top = `${rect.top + (ctaY - btnH / 2) * sy}px`;
      btn.style.width = `${btnW * sx}px`;
      btn.style.height = `${btnH * sy}px`;
    };
    positionBtn();
    this.btnPositionHandler = positionBtn;
    window.addEventListener('resize', positionBtn);
    window.addEventListener('scroll', positionBtn, true);

    btn.addEventListener('click', (e: MouseEvent) => {
      // requestExpandedMode wants a trusted user gesture — this native
      // click IS one. Throws if already expanded; swallow + continue
      // to the round either way.
      try { requestExpandedMode(e, 'default'); }
      catch (err) { console.warn('[VisitPost] requestExpandedMode:', err); }
      this.onPlayClicked();
    });
  }

  private buildBuildLink(): void {
    const { width, height } = this.scale;
    const scaleY = height / L.DESIGN_H;
    // "MAKE YOUR OWN" link below the PLAY button, INSIDE the canvas
    // (was at height - 18 which is the literal pixel bottom; on
    // shorter actual viewport sizes that was being clipped).
    const linkY = (L.LANE_BOTTOM_Y * scaleY) - 8;
    this.add.text(width / 2, linkY, '⛏  MAKE YOUR OWN', {
      fontFamily: 'Pixeloid Sans, sans-serif',
      fontStyle: 'bold',
      fontSize: '10px',
      color: '#c0a0e6',
    }).setOrigin(0.5, 1).setInteractive({ useHandCursor: true })
      .on('pointerdown', () => {
        this.scene.start(SceneKeys.ChartEditor, { playerState: this.playerState });
      });
  }

  private onPlayClicked(): void {
    if (this.playBusy) return;
    if (!this.chart) {
      // Chart fetch not done yet — flash the button briefly so the
      // tap registers, then wait for the chart and auto-start once it
      // lands. Most plays will land here only if the visitor is a
      // speed-tapper; chart fetch is usually <500ms.
      this.playBtnText.setText('LOADING…');
      this.playBusy = true;
      const waitInterval = this.time.addEvent({
        delay: 100,
        loop: true,
        callback: () => {
          if (!this.scene.isActive()) { waitInterval.remove(false); return; }
          if (this.chart) {
            waitInterval.remove(false);
            this.startVisitorRound();
          }
        },
      });
      return;
    }
    this.startVisitorRound();
  }

  private startVisitorRound(): void {
    if (!this.chart) return;
    // Stamp the chart on playerState so Game's existing chart-loading
    // path picks it up — Game's initChartPlayer reads playerState.chart
    // as a fallback when the registry doesn't have a hostChart. Also
    // set visitorMode so the summary's Post Comment button reactivates
    // and the play submits via finalizePlay/social-loop.
    if (this.playerState) {
      this.playerState.chart = this.chart;
    }
    this.scene.start(SceneKeys.Game, {
      playerState: this.playerState,
      visitorMode: true,
      visitOwnerUsername: this.visit?.ownerUsername ?? '',
      visitPostId: this.postId,
    });
  }

  private formatSongLine(chart: Chart): string {
    const title = chart.title ?? 'Untitled';
    const vibe = chart.vibe ? ` · ${chart.vibe}` : '';
    const diff = chart.difficulty ? ` · ${chart.difficulty}` : '';
    return `🎶 ${title}${vibe}${diff}`;
  }

  private cleanup(): void {
    for (const c of this.cats) c.destroy();
    this.cats = [];
    if (this.htmlPlayButton) {
      try { this.htmlPlayButton.remove(); } catch { /* ignore */ }
      this.htmlPlayButton = null;
    }
    if (this.btnPositionHandler) {
      window.removeEventListener('resize', this.btnPositionHandler);
      window.removeEventListener('scroll', this.btnPositionHandler, true);
      this.btnPositionHandler = null;
    }
    this.hud?.destroy();
    this.bg?.destroy();
    this.tweens.killAll();
    this.time.removeAllEvents();
    this.input.removeAllListeners();
  }
}
