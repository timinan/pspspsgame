import { Scene, Scenes, GameObjects } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { BackgroundManager } from '@/entities/background-manager';
import { Cat } from '@/entities/cat';
import { TopHud } from '@/ui/top-hud';
import * as L from '@/constants/scene-layout';
import { BACKING_CATALOG, CAT_CATALOG } from '@/../shared/state';
import { MusicSystem } from '@/systems/music-system';
import type { Chart, PlayerState, SeatId } from '@/../shared/state';
import type { CatModel } from '@/types/game';
import { fetchVisit, type VisitData } from '@/services/visit-client';
import { loadChart } from '@/services/state-client';
import { fetchLeaderboard } from '@/services/social-client';
import type { LeaderboardEntry } from '@/../shared/social-loop';

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

  /** Music plays on the splash so visitors hear the track they're about
   *  to play (Tim: "lets make this page start playing the music so they
   *  know what they are listning to"). Same MusicSystem the round uses
   *  — wired to the chart's audioKey via pickBacking. Started once the
   *  chart fetch lands, stopped on cleanup. */
  private music: MusicSystem | null = null;

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

    // Fire all four fetches in parallel — visit is the heaviest payload
    // and gates the visual (bg + cats), per-post chart unlocks PLAY +
    // music (kicked off immediately so the backing track starts as
    // soon as possible), leaderboard fills the info panel.
    void this.loadVisit();
    void this.loadLeaderboard();
    // Per-post chart fetch needs only postId (no owner). Firing it in
    // parallel with visit instead of chaining off it cuts splash-music
    // start-time roughly in half. Falls through to loadVisit's
    // authorUsername-based fallback if no per-post chart exists
    // (legacy posts only).
    void this.loadChartFast();
  }

  /** Per-post chart fetch path. Independent of visit — uses postId
   *  directly so it doesn't have to wait on the visit endpoint to
   *  resolve the author. Tim's feedback: "music works but took a
   *  while to load". This shortens the path. */
  private async loadChartFast(): Promise<void> {
    const chart = await this.loadPostChart();
    if (!this.scene.isActive() || !chart) return;
    // If visit's chart load already raced ahead, don't clobber.
    if (this.chart) return;
    this.chart = chart;
    this.songText.setText(this.formatSongLine(chart));
    this.startSplashMusic(chart);
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
      // Prefer per-post chart snapshot (saved by publish.ts at PUT ON A
      // SHOW time) so the splash always shows the chart that was
      // ACTUALLY published, not whatever next chart the author is
      // editing now. Fall back to the owner's current state.chart for
      // legacy posts that predate per-post snapshots.
      let chart = await this.loadPostChart();
      if (!chart) {
        console.info('[VisitPost] no per-post chart, falling back to author state.chart');
        chart = await loadChart(authorUsername);
      }
      if (!this.scene.isActive()) return;
      this.chart = chart;
      this.songText.setText(this.formatSongLine(chart));
      // Start the backing track on the splash so the visitor hears the
      // song they're about to play. Same MusicSystem the round will use
      // so the file's already cached when they tap PLAY (no audible
      // gap mid-transition). Tap-sound stems aren't preloaded here —
      // only the backing, since splash doesn't simulate gameplay.
      this.startSplashMusic(chart);
    } catch (err) {
      console.warn('[VisitPost] chart load failed:', err);
      this.songText.setText('— song unavailable —');
    }
  }

  /** Fetch the per-post chart snapshot. Returns null when the post
   *  predates per-post storage or the key was somehow lost. */
  private async loadPostChart(): Promise<Chart | null> {
    try {
      const r = await fetch(`/api/post-chart?postId=${encodeURIComponent(this.postId)}`);
      if (!r.ok) return null;
      const body = (await r.json()) as { ok?: boolean; chart?: Chart };
      return body?.ok && body.chart ? body.chart : null;
    } catch (err) {
      console.warn('[VisitPost] post-chart fetch threw:', err);
      return null;
    }
  }

  private startSplashMusic(chart: Chart): void {
    if (this.music) return; // idempotent — only ever one backing at a time
    try {
      this.music = new MusicSystem(this, chart);
      // Fire-and-forget start. preload + start are both async + safe to
      // call concurrently with other scene work. Errors swallowed
      // internally; worst case the splash is silent.
      void this.music.start(0);
    } catch (err) {
      console.warn('[VisitPost] startSplashMusic threw:', err);
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

    // wordWrap + multi-line center align so long backing-track names
    // (e.g. "Red Hot Chili Peppers - By The Way (Official Music Video)")
    // don't truncate off the right edge — which was clipping the
    // " · spicy" difficulty suffix Tim wanted to see.
    this.songText = this.add.text(panelX + panelW / 2, padTop + 22, '— song —', {
      fontFamily: 'Pixeloid Sans, sans-serif',
      fontSize: '10px',
      color: '#c0a0e6',
      align: 'center',
      wordWrap: { width: panelW - 24, useAdvancedWrap: true },
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
        const u = entry.visitor;
        const name = u.length > 18 ? u.slice(0, 16) + '…' : u;
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

    this.playBtnBg = this.add.rectangle(width / 2, ctaY, btnW, btnH, 0xffd34d, 1)
      .setInteractive({ useHandCursor: true });
    this.playBtnText = this.add.text(width / 2, ctaY, '▶  TAP TO PLAY', {
      fontFamily: 'Pixeloid Sans, sans-serif',
      fontStyle: 'bold',
      fontSize: '18px',
      color: '#1a0a2e',
    }).setOrigin(0.5);
    this.playBtnBg.on('pointerover', () => this.playBtnBg.setFillStyle(0xffe680, 1));
    this.playBtnBg.on('pointerout', () => this.playBtnBg.setFillStyle(0xffd34d, 1));
    this.playBtnBg.on('pointerdown', () => this.onPlayClicked());
    // Fullscreen expand is handled by the canvas-level first-touch
    // handler armed in Preloader.armFullscreenOnFirstTouch — no need
    // for a per-scene HTML overlay anymore.
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
    // Hand the chart to Game via the REGISTRY so it picks it up at
    // priority 1 in initChartPlayer — independent of playerState
    // (which can be null for fresh visitors who don't have an
    // onboarded account yet). Tim's bug: "playing my own song in
    // rehearsal still doesnt work its bugged and goes to pick a
    // song" — that was the playerState.chart assignment silently
    // skipped when playerState was null, falling Game through to the
    // showSongPicker branch.
    this.registry.set('hostChart', this.chart);
    if (this.visit?.ownerUsername) {
      this.registry.set('hostUsername', this.visit.ownerUsername);
    }
    if (this.playerState) {
      this.playerState.chart = this.chart;
    }
    // Stop the splash music BEFORE the scene transition — Phaser's
    // sound manager is global so without an explicit stop the backing
    // would keep playing into the Ready modal / first second of the
    // round, layered on top of Game's own MusicSystem instance.
    this.music?.destroy?.();
    this.music = null;
    this.scene.start(SceneKeys.Game, {
      playerState: this.playerState,
      visitorMode: true,
      visitOwnerUsername: this.visit?.ownerUsername ?? '',
      visitPostId: this.postId,
      // Hand the POST's published bg to Game so the visitor sees the
      // show's background during the round, not whatever the visitor
      // (or the owner) has set as their current Decorate bg.
      visitPostBg: this.visit?.stage.activeBackground ?? '',
    });
  }

  private formatSongLine(chart: Chart): string {
    // Prefer the actual backing track's display name from the catalog —
    // chart.title is almost always 'Untitled' or 'Rehearsal' (those
    // strings come from the editor's default + the rehearse-flow stub).
    // Lookup priority:
    //   1. BACKING_CATALOG[chart.audioKey].displayName — the recognizable
    //      "Sugar Skip" / "Pirate Lullaby" style name
    //   2. chart.title — when audioKey is unknown OR it's a custom song
    //   3. owner's set — last-resort fallback so the visitor sees
    //      something specific instead of a placeholder
    const backing = chart.audioKey ? BACKING_CATALOG[chart.audioKey] : undefined;
    const rawTitle = chart.title?.trim();
    const isPlaceholder = !rawTitle || rawTitle === 'Untitled' || rawTitle === 'Rehearsal';
    const owner = this.visit?.ownerUsername ? `u/${this.visit.ownerUsername}` : 'the host';
    const title = backing?.displayName
      ?? (isPlaceholder ? `${owner}'s set` : rawTitle!);
    const vibe = chart.vibe ? ` · ${chart.vibe}` : '';
    const diff = chart.difficulty ? ` · ${chart.difficulty}` : '';
    return `🎶 ${title}${vibe}${diff}`;
  }

  private cleanup(): void {
    this.music?.destroy?.();
    this.music = null;
    for (const c of this.cats) c.destroy();
    this.cats = [];
    this.hud?.destroy();
    this.bg?.destroy();
    this.tweens.killAll();
    this.time.removeAllEvents();
    this.input.removeAllListeners();
  }
}
