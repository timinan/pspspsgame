import { Scene, Scenes, GameObjects } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { AssetKeys } from '@/constants/assets';
import { BackgroundManager } from '@/entities/background-manager';
import { Cat } from '@/entities/cat';
import { RemoveBadge } from '@/entities/remove-badge';
import { TopHud } from '@/ui/top-hud';
import { ContextMenu, buildCatMenu } from '@/ui/context-menu';
import * as L from '@/constants/scene-layout';
import { CAT_CATALOG, BACKGROUND_CATALOG } from '@/../shared/state';
import { fetchState, setSeat, setBackground } from '@/services/state-client';
import type { PlayerState, CatBreed, SeatId, BackgroundId, CatEntry } from '@/../shared/state';
import type { CatModel } from '@/types/game';

const SEAT_ORDER: SeatId[] = ['seat-left', 'seat-center', 'seat-right'];
const THUMB_COLS = 4;
const THUMB_ROWS = 2;
const MAX_TRAY = THUMB_COLS * THUMB_ROWS; // 8

type ActiveTab = 'CATS' | 'BACKGROUNDS';

/**
 * Phase 5 Decorate scene.
 *
 * Layout (design space 320×580):
 *   0–36      TopHud ("DECORATE" + coins)
 *   36–226    Cat stage — BackgroundManager + 3 seated cats (same positions as Game)
 *   232       Hint line: "Tap a seated cat to dress them up"
 *   252–580   Bottom panel — tabs (CATS / BACKGROUNDS) + 2×4 thumbnail tray
 *
 * Tap a seated cat in the preview → scene.start('DressingRoom', { catId, playerState })
 * Tap a cat thumb (CATS tab)      → seat / unseat
 * Tap a background thumb          → apply background
 */
export class Decorate extends Scene {
  private playerState: PlayerState | null = null;

  private bg!: BackgroundManager;
  private cats: Cat[] = [];
  private catZones: Phaser.GameObjects.Rectangle[] = [];
  private hud!: TopHud;

  // Bottom panel — single Container, recursive-destroyed on shutdown
  private root!: GameObjects.Container;

  // Per-seated-cat remove badges (red ✕ in the top-right of each cat)
  private removeBadges: RemoveBadge[] = [];

  // Tap-menu + placement state
  private contextMenu!: ContextMenu;
  private placingCatId: CatBreed | null = null;
  private placementZones: GameObjects.Container | null = null;

  // Tab state
  private activeTab: ActiveTab = 'CATS';
  private tabCatsText!: GameObjects.Text;
  private tabCatsLine!: GameObjects.Rectangle;
  private tabBgText!: GameObjects.Text;
  private tabBgLine!: GameObjects.Rectangle;
  private trayContainer!: GameObjects.Container;

  constructor() {
    super(SceneKeys.Decorate);
  }

  init(data: { playerState?: PlayerState | null }): void {
    this.playerState = data?.playerState ?? null;
    this.cats = [];
    this.catZones = [];
    this.removeBadges = [];
    this.placingCatId = null;
    this.placementZones = null;
    this.activeTab = 'CATS';
  }

  async create(): Promise<void> {
    // If no state was passed in, fetch fresh from server
    if (!this.playerState) {
      try {
        this.playerState = await fetchState();
        if (!this.scene.isActive()) return;
      } catch (err) {
        console.warn('[Decorate] fetchState failed:', err);
        // Continue with empty state — tray will be empty
      }
    }

    // Background (depth -100, renders behind everything)
    this.bg = new BackgroundManager(this);
    this.bg.create();
    const activeBg: BackgroundId = (this.playerState?.activeBackground ?? 'default') as BackgroundId;
    this.bg.setBackground(activeBg);

    // Hint line at design-y 232
    const { width, height } = this.scale;
    const scaleY = height / L.DESIGN_H;
    const hintY = 232 * scaleY;
    this.add.text(width / 2, hintY, 'tap a cat for options', {
      fontFamily: '"Courier New", monospace',
      fontSize: '9px',
      color: '#c0a0e6',
    }).setOrigin(0.5);

    // Initialise the tap-action menu once for the whole scene.
    this.contextMenu = new ContextMenu(this);
    // Tap-outside-menu closes the menu (and exits placement mode).
    this.input.on('pointerdown', () => {
      if (this.contextMenu.isOpen()) this.contextMenu.close();
    });

    // Seated cats in preview (same positions as Game.ts seatCats())
    this.seatCats();

    // Top HUD
    this.buildHud();

    // Bottom panel
    this.buildPanel();

    // Shutdown cleanup
    this.events.on(Scenes.Events.SHUTDOWN, () => this.cleanup());
  }

  // ---------------------------------------------------------------------------
  // Private — preview cats
  // ---------------------------------------------------------------------------

  /** Destroys existing cat sprites + tap zones, then re-renders from playerState. */
  private seatCats(): void {
    for (const c of this.cats) c.destroy();
    this.cats = [];
    for (const z of this.catZones) z.destroy();
    this.catZones = [];

    const { width, height } = this.scale;
    const scaleY = height / L.DESIGN_H;
    // Match Game.ts exactly — bottom-center of sprite sits in the lower part of the cat stage
    const catY = (L.TOP_HUD_H + L.CAT_STAGE_H * 0.88) * scaleY;

    const seatedCats = this.playerState?.seatedCats ?? {};
    const catIds = SEAT_ORDER
      .map((seatId) => seatedCats[seatId])
      .filter((id): id is CatBreed => Boolean(id))
      .slice(0, 3);

    const inner = width - L.LANE_GUTTER_PX * 2;
    const colW = (inner - L.LANE_GAP_PX * (L.LANE_COUNT - 1)) / L.LANE_COUNT;
    const stageH = L.CAT_STAGE_H * scaleY;
    const stageMidY = (L.TOP_HUD_H + L.CAT_STAGE_H / 2) * scaleY;

    for (let i = 0; i < catIds.length; i++) {
      const catId = catIds[i]!;
      const seatId = SEAT_ORDER.find((sid) => seatedCats[sid] === catId)!;
      const catEntry = CAT_CATALOG.find((c) => c.id === catId);
      if (!catEntry) continue;

      const laneIndex = i as 0 | 1 | 2;
      const cx = L.laneCenterX(laneIndex, width);

      const model: CatModel = {
        id: `decorate-cat-${i}`,
        breed: catId,
        animation: 'idle',
        restingAnimation: 'idle',
        x: cx,
        y: catY,
      };
      const equippedCosmetic = this.playerState?.equippedCosmetics?.[catId];
      if (equippedCosmetic) {
        model.equippedCosmetic = equippedCosmetic;
      }

      const cat = new Cat(this, model);
      cat.setPosition(cx, catY);
      this.cats.push(cat);

      // Invisible tap zone over the whole cat column → opens the cat
      // context menu (Dress up / Move / Take to bench).
      const zone = this.add.rectangle(cx, stageMidY, colW, stageH, 0x000000, 0);
      zone.setInteractive({ useHandCursor: true });
      zone.on(
        'pointerdown',
        (
          _p: Phaser.Input.Pointer,
          _x: number,
          _y: number,
          event: Phaser.Types.Input.EventData,
        ) => {
          event.stopPropagation();
          this.openCatMenu(catId, catEntry, seatId, cx, catY);
        },
      );
      this.catZones.push(zone);

      // Red ✕ badge top-right of the cat for quick-unseat. Offset is in
      // canvas space — small constant since cats render at design-scale.
      const badge = new RemoveBadge(this, cx + 22, catY - 56, () => {
        this.unseatCat(seatId);
      });
      this.add.existing(badge);
      this.removeBadges.push(badge);
    }
  }

  /**
   * Show the cat context menu (Dress up / Move / Take to bench, etc).
   * `seatId` is undefined when invoked from a tray thumb (cat is not yet
   * placed in the scene).
   */
  private openCatMenu(
    catId: CatBreed,
    catEntry: CatEntry,
    seatId: SeatId | undefined,
    anchorX: number,
    anchorY: number,
  ): void {
    if (this.placingCatId) {
      // In placement mode — ignore taps on cats (overlapping placement zones
      // handle taps).
      return;
    }
    const rows = buildCatMenu({
      isSeated: Boolean(seatId),
      displayName: catEntry.name,
    });
    this.contextMenu.open(anchorX, anchorY, rows, (action) => {
      this.onCatMenuAction(action, catId, seatId);
    });
  }

  /** Handle the action the player picked from the cat menu. */
  private onCatMenuAction(
    action: string,
    catId: CatBreed,
    seatId: SeatId | undefined,
  ): void {
    if (action === 'dressup') {
      this.scene.start(SceneKeys.DressingRoom, {
        catId,
        playerState: this.playerState,
      });
      return;
    }
    if (action === 'seat' || action === 'place') {
      this.enterPlacementMode(catId, seatId);
      return;
    }
    if (action === 'unseat' && seatId) {
      this.unseatCat(seatId);
      return;
    }
    // 'gift' / 'rehome' are out of scope here.
  }

  /** Mutate state to clear a seat, sync, repaint. */
  private unseatCat(seatId: SeatId): void {
    if (!this.playerState) return;
    delete this.playerState.seatedCats[seatId];
    setSeat(seatId, null).catch((e) =>
      console.warn('[Decorate] setSeat (unseat) failed:', e),
    );
    this.repaintCatStage();
    this.renderTray();
  }

  /**
   * Enter placement mode for `catId`. Draws 3 green-tinted panels over the
   * 3 seat columns; tapping a panel seats (or replaces) the cat there.
   */
  private enterPlacementMode(catId: CatBreed, fromSeat: SeatId | undefined): void {
    this.placingCatId = catId;
    this.drawPlacementZones(fromSeat);
  }

  private exitPlacementMode(): void {
    this.placingCatId = null;
    if (this.placementZones) {
      this.placementZones.destroy(true);
      this.placementZones = null;
    }
  }

  private drawPlacementZones(fromSeat: SeatId | undefined): void {
    if (this.placementZones) this.placementZones.destroy(true);
    const { width, height } = this.scale;
    const scaleY = height / L.DESIGN_H;
    // Center the placement panel on the actual cat-anchor y used in seatCats().
    const catY = (L.TOP_HUD_H + L.CAT_STAGE_H * 0.88) * scaleY;
    // Panel size tuned to roughly the cat sprite footprint, not the full lane
    // column. Square-ish so it reads as "drop the cat here".
    const panelSize = Math.min(96, L.CAT_STAGE_H * 0.55 * scaleY);
    // Anchor the panel a touch above the cat foot so the cat fits inside.
    const panelCenterY = catY - panelSize * 0.4;

    const container = this.add.container(0, 0).setDepth(40);
    this.placementZones = container;

    for (let i = 0; i < L.LANE_COUNT; i++) {
      const seatId = SEAT_ORDER[i]!;
      const cx = L.laneCenterX(i as 0 | 1 | 2, width);
      const zone = this.add
        .rectangle(cx, panelCenterY, panelSize, panelSize, 0x4dffb4, 0.22)
        .setStrokeStyle(2, 0x4dffb4, fromSeat === seatId ? 0.4 : 0.95)
        .setInteractive({ useHandCursor: true });
      const label = this.add
        .text(cx, panelCenterY, fromSeat === seatId ? 'HERE' : '+', {
          fontFamily: '"Courier New", monospace',
          fontSize: fromSeat === seatId ? '10px' : '26px',
          fontStyle: 'bold',
          color: '#4dffb4',
        })
        .setOrigin(0.5);
      container.add([zone, label]);
      zone.on(
        'pointerdown',
        (
          _p: Phaser.Input.Pointer,
          _x: number,
          _y: number,
          event: Phaser.Types.Input.EventData,
        ) => {
          event.stopPropagation();
          this.placeCatAt(seatId);
        },
      );
    }
  }

  /** Move/seat the currently-placing cat into `seatId`, replacing whatever's there. */
  private placeCatAt(seatId: SeatId): void {
    if (!this.placingCatId || !this.playerState) {
      this.exitPlacementMode();
      return;
    }
    const catId = this.placingCatId;

    // If this cat was already in another seat, clear that seat first.
    const prevSeat = SEAT_ORDER.find((sid) => this.playerState!.seatedCats[sid] === catId);
    if (prevSeat && prevSeat !== seatId) {
      delete this.playerState.seatedCats[prevSeat];
      setSeat(prevSeat, null).catch((e) =>
        console.warn('[Decorate] setSeat (move-from) failed:', e),
      );
    }

    // Seat the new cat (overwrites whatever was here).
    this.playerState.seatedCats[seatId] = catId;
    setSeat(seatId, catId).catch((e) =>
      console.warn('[Decorate] setSeat (place) failed:', e),
    );

    this.exitPlacementMode();
    this.repaintCatStage();
    this.renderTray();
  }

  /** Tear down + recreate the cat stage (cats + remove badges + tap zones). */
  private repaintCatStage(): void {
    for (const c of this.cats) c.destroy();
    this.cats = [];
    for (const b of this.removeBadges) b.destroy();
    this.removeBadges = [];
    for (const z of this.catZones) z.destroy();
    this.catZones = [];
    this.seatCats();
  }

  // ---------------------------------------------------------------------------
  // Private — HUD
  // ---------------------------------------------------------------------------

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
        // DECORATE (self) is omitted
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

    const { width } = this.scale;

    // Scene title centered in the HUD strip
    this.add.text(width / 2, TopHud.HEIGHT / 2, 'DECORATE', {
      fontFamily: '"Courier New", monospace',
      fontStyle: 'bold',
      fontSize: '11px',
      color: '#ffd34d',
    }).setOrigin(0.5).setDepth(101);

    // Coins in top-right (sits to the left of the hamburger)
    const coins = this.playerState?.coins ?? 0;
    this.add.text(width - 66, TopHud.HEIGHT / 2, `🪙 ${coins}`, {
      fontFamily: '"Courier New", monospace',
      fontStyle: 'bold',
      fontSize: '10px',
      color: '#ffd34d',
    }).setOrigin(1, 0.5).setDepth(101);
  }

  // ---------------------------------------------------------------------------
  // Private — bottom panel
  // ---------------------------------------------------------------------------

  private buildPanel(): void {
    const { width, height } = this.scale;
    const scaleY = height / L.DESIGN_H;
    const panelTop = 252 * scaleY;
    const panelH = height - panelTop;

    this.root = this.add.container(0, panelTop).setDepth(50);

    // Panel background + top border
    const panelBg = this.add.rectangle(0, 0, width, panelH, 0x0b041a, 0.92).setOrigin(0, 0);
    const topBorder = this.add.rectangle(0, 0, width, 1, 0xc0a0e6, 0.25).setOrigin(0, 0);
    this.root.add([panelBg, topBorder]);

    // Tab row
    const tabH = 38;
    const tabRowBg = this.add.rectangle(0, 0, width, tabH, 0x0b041a, 1).setOrigin(0, 0);
    const tabRowBorder = this.add.rectangle(0, tabH - 1, width, 1, 0xc0a0e6, 0.15).setOrigin(0, 0);
    this.root.add([tabRowBg, tabRowBorder]);

    // CATS tab button
    const catsBtnBg = this.add
      .rectangle(0, 0, width / 2, tabH, 0x000000, 0)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true });
    this.tabCatsText = this.add.text(width / 4, tabH / 2, 'CATS', {
      fontFamily: '"Courier New", monospace',
      fontStyle: 'bold',
      fontSize: '11px',
      color: '#ffd34d',
    }).setOrigin(0.5);
    this.tabCatsLine = this.add
      .rectangle(width / 4, tabH - 1, width / 2 - 24, 2, 0xffd34d, 1)
      .setOrigin(0.5, 0);
    catsBtnBg.on('pointerdown', () => this.switchTab('CATS'));
    this.root.add([catsBtnBg, this.tabCatsText, this.tabCatsLine]);

    // BACKGROUNDS tab button
    const bgBtnBg = this.add
      .rectangle(width / 2, 0, width / 2, tabH, 0x000000, 0)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true });
    this.tabBgText = this.add.text((width * 3) / 4, tabH / 2, 'BACKGROUNDS', {
      fontFamily: '"Courier New", monospace',
      fontStyle: 'bold',
      fontSize: '11px',
      color: '#c0a0e6',
    }).setOrigin(0.5);
    this.tabBgLine = this.add
      .rectangle((width * 3) / 4, tabH - 1, width / 2 - 24, 2, 0xffd34d, 0)
      .setOrigin(0.5, 0);
    bgBtnBg.on('pointerdown', () => this.switchTab('BACKGROUNDS'));
    this.root.add([bgBtnBg, this.tabBgText, this.tabBgLine]);

    // Tray container sits below the tab row
    this.trayContainer = this.add.container(0, tabH);
    this.root.add(this.trayContainer);

    this.renderTray();
  }

  private switchTab(tab: ActiveTab): void {
    if (this.activeTab === tab) return;
    this.activeTab = tab;

    if (tab === 'CATS') {
      this.tabCatsText.setColor('#ffd34d');
      this.tabCatsLine.setAlpha(1);
      this.tabBgText.setColor('#c0a0e6');
      this.tabBgLine.setAlpha(0);
    } else {
      this.tabBgText.setColor('#ffd34d');
      this.tabBgLine.setAlpha(1);
      this.tabCatsText.setColor('#c0a0e6');
      this.tabCatsLine.setAlpha(0);
    }

    this.renderTray();
  }

  private renderTray(): void {
    this.trayContainer.removeAll(true);
    if (this.activeTab === 'CATS') {
      this.renderCatsTray();
    } else {
      this.renderBackgroundsTray();
    }
  }

  // ---------------------------------------------------------------------------
  // Private — CATS tray
  // ---------------------------------------------------------------------------

  private renderCatsTray(): void {
    const { width, height } = this.scale;
    const scaleY = height / L.DESIGN_H;
    const panelTop = 252 * scaleY;
    const panelH = height - panelTop;
    const tabH = 38;
    const trayH = panelH - tabH;

    const padding = 10;
    const gapX = 6;
    const gapY = 6;
    const thumbW = (width - padding * 2 - gapX * (THUMB_COLS - 1)) / THUMB_COLS;
    const thumbH = (trayH - padding * 2 - gapY * (THUMB_ROWS - 1)) / THUMB_ROWS;

    const ownedCats = this.playerState?.ownedCats ?? [];
    const seatedCats = this.playerState?.seatedCats ?? {};

    // First 8 owned cats from the catalog (maintains catalog order)
    const items = CAT_CATALOG.filter((c) => ownedCats.includes(c.id)).slice(0, MAX_TRAY);

    for (let i = 0; i < items.length; i++) {
      const entry = items[i]!;
      const col = i % THUMB_COLS;
      const row = Math.floor(i / THUMB_COLS);
      const x = padding + col * (thumbW + gapX);
      const y = padding + row * (thumbH + gapY);

      const seatedSeat = SEAT_ORDER.find((sid) => seatedCats[sid] === entry.id);
      const isSeated = Boolean(seatedSeat);

      const borderColor = isSeated ? 0xffd34d : 0xc0a0e6;
      const borderAlpha = isSeated ? 1 : 0.25;

      const thumb = this.add
        .rectangle(x + thumbW / 2, y + thumbH / 2, thumbW, thumbH, 0x0b041a, 0.7)
        .setStrokeStyle(2, borderColor, borderAlpha)
        .setInteractive({ useHandCursor: true });

      // Real cat sprite from the atlas instead of an emoji. Frame derivation
      // mirrors the box-open animation's resolveFrame() — for tinted variants
      // we render the parent's idle frame and apply the tint.
      // Scale uniformly so the cat's natural aspect ratio is preserved
      // regardless of the cell's aspect ratio.
      const { frame, tint } = catThumbFrame(entry);
      const sprite = this.add.image(
        x + thumbW / 2,
        y + thumbH / 2 - 4,
        AssetKeys.Atlas.Cats,
        frame,
      );
      const maxSize = Math.min(thumbW, thumbH) * 0.62;
      const scale = Math.min(maxSize / sprite.width, maxSize / sprite.height);
      sprite.setScale(scale);
      if (tint !== undefined) sprite.setTint(tint);

      const label = this.add.text(x + thumbW / 2, y + thumbH - 10, entry.name.toUpperCase(), {
        fontFamily: '"Courier New", monospace',
        fontStyle: 'bold',
        fontSize: '7px',
        color: '#ffffff',
      }).setOrigin(0.5, 1);

      this.trayContainer.add([thumb, sprite, label]);

      if (isSeated) {
        const badge = this.add.circle(x + thumbW - 6, y + 6, 7, 0xffd34d, 1);
        const check = this.add.text(x + thumbW - 6, y + 6, '✓', {
          fontFamily: '"Courier New", monospace',
          fontStyle: 'bold',
          fontSize: '8px',
          color: '#1a0a2e',
        }).setOrigin(0.5);
        this.trayContainer.add([badge, check]);
      }

      thumb.on(
        'pointerdown',
        (
          _p: Phaser.Input.Pointer,
          _x: number,
          _y: number,
          event: Phaser.Types.Input.EventData,
        ) => {
          event.stopPropagation();
          // Open the context menu anchored above the thumb.
          this.openCatMenu(entry.id, entry, seatedSeat, x + thumbW / 2, y + thumbH / 2);
        },
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Private — BACKGROUNDS tray
  // ---------------------------------------------------------------------------

  private renderBackgroundsTray(): void {
    const { width, height } = this.scale;
    const scaleY = height / L.DESIGN_H;
    const panelTop = 252 * scaleY;
    const panelH = height - panelTop;
    const tabH = 38;
    const trayH = panelH - tabH;

    const padding = 10;
    const gapX = 6;
    const gapY = 6;
    const thumbW = (width - padding * 2 - gapX * (THUMB_COLS - 1)) / THUMB_COLS;
    const thumbH = (trayH - padding * 2 - gapY * (THUMB_ROWS - 1)) / THUMB_ROWS;

    const ownedBgs = this.playerState?.ownedBackgrounds ?? (['default'] as BackgroundId[]);
    const activeBg = this.playerState?.activeBackground ?? ('default' as BackgroundId);

    // Only show backgrounds the player actually owns. Locked ones are bought
    // via the Background Box in Purchase — there's no point teasing them
    // here without an unlock path on this screen.
    const allBgs = Object.values(BACKGROUND_CATALOG).filter((entry) =>
      ownedBgs.includes(entry.id as BackgroundId),
    );

    for (let i = 0; i < allBgs.length && i < MAX_TRAY; i++) {
      const entry = allBgs[i]!;
      const col = i % THUMB_COLS;
      const row = Math.floor(i / THUMB_COLS);
      const x = padding + col * (thumbW + gapX);
      const y = padding + row * (thumbH + gapY);

      const isOwned = true; // pre-filtered above; the locked branch is now unreachable
      const isActive = activeBg === entry.id;

      if (isOwned) {
        const borderColor = isActive ? 0x4dffb4 : 0xc0a0e6;
        const borderAlpha = isActive ? 1 : 0.25;
        const fillColor = this.bgThumbColor(entry.id as BackgroundId);

        const thumb = this.add
          .rectangle(x + thumbW / 2, y + thumbH / 2, thumbW, thumbH, fillColor, 1)
          .setStrokeStyle(2, borderColor, borderAlpha)
          .setInteractive({ useHandCursor: true });

        const label = this.add.text(x + thumbW / 2, y + thumbH - 10, entry.displayName.toUpperCase(), {
          fontFamily: '"Courier New", monospace',
          fontStyle: 'bold',
          fontSize: '7px',
          color: '#ffffff',
        }).setOrigin(0.5, 1);

        this.trayContainer.add([thumb, label]);

        if (isActive) {
          const badge = this.add.circle(x + thumbW - 6, y + 6, 7, 0x4dffb4, 1);
          const check = this.add.text(x + thumbW - 6, y + 6, '✓', {
            fontFamily: '"Courier New", monospace',
            fontStyle: 'bold',
            fontSize: '8px',
            color: '#1a0a2e',
          }).setOrigin(0.5);
          this.trayContainer.add([badge, check]);
        }

        thumb.on('pointerdown', () => this.onBgThumbTap(entry.id as BackgroundId));
      } else {
        // Locked — dimmed card with 🔒, no interaction
        const thumb = this.add
          .rectangle(x + thumbW / 2, y + thumbH / 2, thumbW, thumbH, 0x0b041a, 0.6)
          .setStrokeStyle(1, 0xc0a0e6, 0.2);
        thumb.setAlpha(0.6);

        const lock = this.add.text(x + thumbW / 2, y + thumbH / 2 - 6, '🔒', {
          fontSize: `${Math.floor(thumbH * 0.4)}px`,
        }).setOrigin(0.5);

        const label = this.add.text(x + thumbW / 2, y + thumbH - 10, entry.displayName.toUpperCase(), {
          fontFamily: '"Courier New", monospace',
          fontSize: '7px',
          color: '#c0a0e6',
        }).setOrigin(0.5, 1).setAlpha(0.5);

        this.trayContainer.add([thumb, lock, label]);
      }
    }
  }

  private bgThumbColor(id: BackgroundId): number {
    if (id === 'cozy') return 0xa16f3b;
    if (id === 'spooky') return 0x1e1b2c;
    return 0x3b2a5c; // default
  }

  private onBgThumbTap(bgId: BackgroundId): void {
    if (!this.playerState) return;
    const ownedBgs = this.playerState.ownedBackgrounds ?? (['default'] as BackgroundId[]);
    if (!ownedBgs.includes(bgId)) return; // safety guard

    // Optimistic: live preview + local state update
    this.playerState.activeBackground = bgId;
    this.bg.setBackground(bgId);
    this.renderTray();

    // Server sync
    setBackground(bgId).catch((e) =>
      console.warn('[Decorate] setBackground failed:', e),
    );
  }

  // ---------------------------------------------------------------------------
  // Private — cleanup
  // ---------------------------------------------------------------------------

  private cleanup(): void {
    this.tweens.killAll();
    this.time.removeAllEvents();
    this.input.removeAllListeners();
    this.input.keyboard?.removeAllListeners();
    this.scale.off('resize');
    this.contextMenu?.destroy();
    this.placementZones?.destroy(true);
    this.placementZones = null;
    this.bg?.destroy();
    for (const c of this.cats) c.destroy();
    this.cats = [];
    for (const z of this.catZones) z.destroy();
    this.catZones = [];
    for (const b of this.removeBadges) b.destroy();
    this.removeBadges = [];
    this.root?.destroy(true); // recursive — kills tray + panel children
    this.hud?.destroy();
  }
}

/**
 * Pick the atlas frame (and optional tint) for a cat catalog entry. Mirrors
 * the box-open animation's resolveFrame() so the tray uses the exact same
 * art as the reveal modal.
 */
function catThumbFrame(entry: CatEntry): { frame: string; tint?: number } {
  if (entry.id === 'rainbow') {
    return { frame: 'cat6_idle_00' };
  }
  const parentId = entry.sourceFrame?.match(/^(cat\d+)_/)?.[1];
  const frame = parentId ? `${parentId}_idle_00` : `${entry.id}_idle_00`;
  const tint = entry.tint ? parseInt(entry.tint.replace('#', ''), 16) : undefined;
  return tint !== undefined ? { frame, tint } : { frame };
}
