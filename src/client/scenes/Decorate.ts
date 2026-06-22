import { Scene, Scenes, GameObjects } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { AssetKeys } from '@/constants/assets';
import { BackgroundManager } from '@/entities/background-manager';
import { Cat } from '@/entities/cat';
import { RemoveBadge } from '@/entities/remove-badge';
import { TopHud } from '@/ui/top-hud';
import { ContextMenu, buildCatMenu } from '@/ui/context-menu';
import * as L from '@/constants/scene-layout';
import { CAT_CATALOG, COSMETIC_CATALOG, BACKGROUND_CATALOG } from '@/../shared/state';
import { fetchState, setSeat, setBackground } from '@/services/state-client';
import type {
  PlayerState,
  SeatId,
  BackgroundId,
  CatEntry,
  OwnedCat,
} from '@/../shared/state';
import type { CatModel } from '@/types/game';

const SEAT_ORDER: SeatId[] = ['seat-left', 'seat-center', 'seat-right'];
const THUMB_COLS = 4;
const THUMB_ROWS = 2;
const MAX_TRAY = THUMB_COLS * THUMB_ROWS; // 8
const THUMB_LABEL_MAX = 11; // characters before ellipsis

type ActiveTab = 'CATS' | 'BACKGROUNDS';

/** Truncate a cat name to fit the two-line thumb label capacity. */
function truncateName(name: string): string {
  if (name.length <= THUMB_LABEL_MAX) return name;
  return name.slice(0, THUMB_LABEL_MAX) + '…';
}

/**
 * Phase 5 Decorate scene.
 *
 * Layout (design space 320×580):
 *   0–36      TopHud ("DECORATE" + coins)
 *   36–226    Cat stage — BackgroundManager + 3 seated cats (same positions as Game)
 *   232       Hint line: "Tap a seated cat to dress them up"
 *   252–580   Bottom panel — tabs (CATS / BACKGROUNDS) + 2×4 thumbnail tray
 *
 * Tap a seated cat in the preview → open cat context menu
 * Tap a cat thumb (CATS tab)      → seat / unseat / dress up
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
  /** Cat instance id being placed, or null. */
  private placingCatInstanceId: string | null = null;
  private placementZones: GameObjects.Container | null = null;
  /** Named callback for the dressingroom:closed listener so cleanup() can detach it precisely. */
  private onDressingRoomClosed: (() => void) | undefined;

  // Tab state — each tab tracks its own page index so swapping back-and-forth
  // doesn't lose your spot.
  private activeTab: ActiveTab = 'CATS';
  private catsPage = 0;
  private bgsPage = 0;
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
    this.placingCatInstanceId = null;
    this.placementZones = null;
    this.activeTab = 'CATS';
    this.catsPage = 0;
    this.bgsPage = 0;
  }

  async create(): Promise<void> {
    // If no state was passed in, fetch fresh from server
    if (!this.playerState) {
      try {
        this.playerState = await fetchState();
        if (!this.scene.isActive()) return;
      } catch (err) {
        console.warn('[Decorate] fetchState failed:', err);
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

    // The DressingRoom modal fires this when it closes (✕) — we re-render
    // the cat stage so any equipped-cosmetic changes show immediately.
    this.onDressingRoomClosed = () => this.repaintCatStage();
    this.events.on('dressingroom:closed', this.onDressingRoomClosed);

    // Seated cats in preview
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
    const catY = (L.TOP_HUD_H + L.CAT_STAGE_H * 0.88) * scaleY;

    const seatedCats = this.playerState?.seatedCats ?? {};
    // Collect seated instances in seat order. seatedCats maps seatId → cat instance id.
    const seatedInstanceIds = SEAT_ORDER
      .map((seatId) => seatedCats[seatId])
      .filter((id): id is string => Boolean(id))
      .slice(0, 3);

    const inner = width - L.LANE_GUTTER_PX * 2;
    const colW = (inner - L.LANE_GAP_PX * (L.LANE_COUNT - 1)) / L.LANE_COUNT;
    const stageH = L.CAT_STAGE_H * scaleY;
    const stageMidY = (L.TOP_HUD_H + L.CAT_STAGE_H / 2) * scaleY;

    for (let i = 0; i < seatedInstanceIds.length; i++) {
      const instanceId = seatedInstanceIds[i]!;
      const seatId = SEAT_ORDER.find((sid) => seatedCats[sid] === instanceId)!;
      const catInstance = this.playerState?.ownedCats.find((cat) => cat.id === instanceId);
      if (!catInstance) continue;
      // Guard: breed must exist in the catalog for rendering.
      if (!CAT_CATALOG.some((c) => c.id === catInstance.breed)) continue;

      const laneIndex = i as 0 | 1 | 2;
      const cx = L.laneCenterX(laneIndex, width);

      const model: CatModel = {
        id: `decorate-cat-${i}`,
        breed: catInstance.breed,
        animation: 'idle',
        restingAnimation: 'idle',
        x: cx,
        y: catY,
      };

      // Equip cosmetics — equippedCosmetics is keyed by cat instance id.
      const slots = this.playerState?.equippedCosmetics?.[instanceId];
      if (slots && Object.keys(slots).length > 0) {
        model.equippedCosmetics = { ...slots };
      }

      const cat = new Cat(this, model);
      cat.setPosition(cx, catY);
      this.cats.push(cat);

      // Invisible tap zone over the whole cat column → opens the cat context menu.
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
          this.openCatMenu(catInstance, seatId, cx, catY);
        },
      );
      this.catZones.push(zone);

      // Red ✕ badge top-right of the cat for quick-unseat.
      const badge = new RemoveBadge(this, cx + 22, catY - 56, () => {
        this.unseatCat(seatId);
      });
      this.add.existing(badge);
      this.removeBadges.push(badge);
    }
  }

  /**
   * Show the cat context menu (Dress up / Move / Take to bench, etc).
   * `seatId` is undefined when invoked from a tray thumb (cat is not yet placed).
   */
  private openCatMenu(
    catInstance: OwnedCat,
    seatId: SeatId | undefined,
    anchorX: number,
    anchorY: number,
  ): void {
    if (this.placingCatInstanceId) return;
    const rows = buildCatMenu({
      isSeated: Boolean(seatId),
      displayName: catInstance.name,
    });
    this.contextMenu.open(anchorX, anchorY, rows, (action) => {
      this.onCatMenuAction(action, catInstance, seatId);
    });
  }

  /** Handle the action the player picked from the cat menu. */
  private onCatMenuAction(
    action: string,
    catInstance: OwnedCat,
    seatId: SeatId | undefined,
  ): void {
    if (action === 'dressup') {
      if (this.scene.isActive(SceneKeys.DressingRoom)) return;
      this.scene.launch(SceneKeys.DressingRoom, {
        catInstanceId: catInstance.id,
        playerState: this.playerState,
      });
      return;
    }
    if (action === 'seat' || action === 'place') {
      this.enterPlacementMode(catInstance.id, seatId);
      return;
    }
    if (action === 'unseat' && seatId) {
      this.unseatCat(seatId);
      return;
    }
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
   * Enter placement mode for `catInstanceId`. Draws 3 green-tinted panels over the
   * 3 seat columns; tapping a panel seats (or replaces) the cat there.
   */
  private enterPlacementMode(catInstanceId: string, fromSeat: SeatId | undefined): void {
    this.placingCatInstanceId = catInstanceId;
    this.drawPlacementZones(fromSeat);
  }

  private exitPlacementMode(): void {
    this.placingCatInstanceId = null;
    if (this.placementZones) {
      this.placementZones.destroy(true);
      this.placementZones = null;
    }
  }

  private drawPlacementZones(fromSeat: SeatId | undefined): void {
    if (this.placementZones) this.placementZones.destroy(true);
    const { width, height } = this.scale;
    const scaleY = height / L.DESIGN_H;
    const catY = (L.TOP_HUD_H + L.CAT_STAGE_H * 0.88) * scaleY;
    const panelSize = Math.min(96, L.CAT_STAGE_H * 0.55 * scaleY);
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
    if (!this.placingCatInstanceId || !this.playerState) {
      this.exitPlacementMode();
      return;
    }
    const catInstanceId = this.placingCatInstanceId;

    // If this cat was already in another seat, clear that seat first.
    const prevSeat = SEAT_ORDER.find(
      (sid) => this.playerState!.seatedCats[sid] === catInstanceId,
    );
    if (prevSeat && prevSeat !== seatId) {
      delete this.playerState.seatedCats[prevSeat];
      setSeat(prevSeat, null).catch((e) =>
        console.warn('[Decorate] setSeat (move-from) failed:', e),
      );
    }

    // Seat the cat (overwrites whatever was here).
    this.playerState.seatedCats[seatId] = catInstanceId;
    setSeat(seatId, catInstanceId).catch((e) =>
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

    this.add.text(width / 2, TopHud.HEIGHT / 2, 'DECORATE', {
      fontFamily: '"Courier New", monospace',
      fontStyle: 'bold',
      fontSize: '11px',
      color: '#ffd34d',
    }).setOrigin(0.5).setDepth(101);

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

    const panelBg = this.add.rectangle(0, 0, width, panelH, 0x0b041a, 0.92).setOrigin(0, 0);
    const topBorder = this.add.rectangle(0, 0, width, 1, 0xc0a0e6, 0.25).setOrigin(0, 0);
    this.root.add([panelBg, topBorder]);

    const tabH = 38;
    const tabRowBg = this.add.rectangle(0, 0, width, tabH, 0x0b041a, 1).setOrigin(0, 0);
    const tabRowBorder = this.add.rectangle(0, tabH - 1, width, 1, 0xc0a0e6, 0.15).setOrigin(0, 0);
    this.root.add([tabRowBg, tabRowBorder]);

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

    // ownedCats is now OwnedCat[]. Iterate instances directly.
    const ownedCats = this.playerState?.ownedCats ?? [];
    const seatedCats = this.playerState?.seatedCats ?? {};

    const totalPages = Math.max(1, Math.ceil(ownedCats.length / MAX_TRAY));
    if (this.catsPage >= totalPages) this.catsPage = totalPages - 1;
    const start = this.catsPage * MAX_TRAY;
    const items = ownedCats.slice(start, start + MAX_TRAY);

    for (let i = 0; i < items.length; i++) {
      const catInstance = items[i]!;
      const catEntry = CAT_CATALOG.find((c) => c.id === catInstance.breed);
      if (!catEntry) continue;

      const col = i % THUMB_COLS;
      const row = Math.floor(i / THUMB_COLS);
      const x = padding + col * (thumbW + gapX);
      const y = padding + row * (thumbH + gapY);

      // Check if this instance is seated anywhere.
      const seatedSeat = SEAT_ORDER.find((sid) => seatedCats[sid] === catInstance.id);
      const isSeated = Boolean(seatedSeat);

      const borderColor = isSeated ? 0xffd34d : 0xc0a0e6;
      const borderAlpha = isSeated ? 1 : 0.25;

      const thumb = this.add
        .rectangle(x + thumbW / 2, y + thumbH / 2, thumbW, thumbH, 0x0b041a, 0.7)
        .setStrokeStyle(2, borderColor, borderAlpha)
        .setInteractive({ useHandCursor: true });

      const { frame, tint } = catThumbFrame(catEntry);
      const sprite = this.add.image(
        x + thumbW / 2,
        y + thumbH / 2 - 14,
        AssetKeys.Atlas.Cats,
        frame,
      );
      const maxSize = Math.min(thumbW, thumbH * 0.78);
      const scale = Math.min(maxSize / sprite.width, maxSize / sprite.height);
      sprite.setScale(scale);
      if (tint !== undefined) sprite.setTint(tint);

      this.trayContainer.add([thumb, sprite]);

      // Layer equipped cosmetics on the thumbnail.
      const equippedSlots = this.playerState?.equippedCosmetics?.[catInstance.id] ?? {};
      const equippedTypes = this.playerState?.equippedCosmeticTypes ?? {};
      let cosmeticDepth = 1;
      for (const cosInstanceId of Object.values(equippedSlots)) {
        if (!cosInstanceId) continue;
        // Resolve catalog type from equippedCosmeticTypes sidecar.
        const cosTypeId = equippedTypes[cosInstanceId] ?? cosInstanceId;
        const cos = COSMETIC_CATALOG.find((c) => c.id === cosTypeId);
        if (!cos) continue;
        const cosParent = cos.sourceFrame?.match(/^cosmetic_(c\d+)_/)?.[1] ?? cos.id;
        const cosFrame = `cosmetic_${cosParent}_idle_00`;
        const cosSprite = this.add
          .image(sprite.x, sprite.y, AssetKeys.Atlas.Cosmetics, cosFrame)
          .setScale(scale)
          .setOrigin(sprite.originX, sprite.originY)
          .setDepth(cosmeticDepth++);
        if (cos.tint) {
          cosSprite.setTint(parseInt(cos.tint.replace('#', ''), 16));
        }
        this.trayContainer.add(cosSprite);
      }

      // Label uses the instance's custom name, truncated to fit.
      const label = this.add.text(
        x + thumbW / 2,
        y + thumbH - 8,
        truncateName(catInstance.name).toUpperCase(),
        {
          fontFamily: '"Courier New", monospace',
          fontStyle: 'bold',
          fontSize: '13px',
          color: '#ffffff',
        },
      ).setOrigin(0.5, 1);

      this.trayContainer.add(label);

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
          const worldX = (this.trayContainer.x ?? 0) + (this.root?.x ?? 0) + x + thumbW / 2;
          const worldY = (this.trayContainer.y ?? 0) + (this.root?.y ?? 0) + y + thumbH / 2;
          this.openCatMenu(catInstance, seatedSeat, worldX, worldY);
        },
      );
    }

    this.drawTrayPagination(totalPages, this.catsPage, (delta) => {
      this.catsPage = Math.max(0, Math.min(totalPages - 1, this.catsPage + delta));
      this.renderTray();
    });
  }

  /**
   * Render Prev/Next pagination buttons + page label centered at the bottom
   * of the tray.
   */
  private drawTrayPagination(
    totalPages: number,
    currentPage: number,
    onChange: (delta: -1 | 1) => void,
  ): void {
    if (totalPages <= 1) return;
    const { width, height } = this.scale;
    const scaleY = height / L.DESIGN_H;
    const panelTop = 252 * scaleY;
    const panelH = height - panelTop;
    const tabH = 38;
    const trayH = panelH - tabH;
    const y = trayH - 18;

    const makeBtn = (
      bx: number,
      btnLabel: string,
      disabled: boolean,
      delta: -1 | 1,
    ): void => {
      const btn = this.add
        .rectangle(bx, y, 36, 26, 0x2c1856, 1)
        .setStrokeStyle(1, 0xc0a0e6, 0.5)
        .setAlpha(disabled ? 0.35 : 1);
      const txt = this.add
        .text(bx, y, btnLabel, {
          fontFamily: '"Courier New", monospace',
          fontStyle: 'bold',
          fontSize: '14px',
          color: '#ffd34d',
        })
        .setOrigin(0.5);
      this.trayContainer.add([btn, txt]);
      if (!disabled) {
        btn.setInteractive({ useHandCursor: true });
        btn.on(
          'pointerdown',
          (
            _p: Phaser.Input.Pointer,
            _x: number,
            _y: number,
            event: Phaser.Types.Input.EventData,
          ) => {
            event.stopPropagation();
            onChange(delta);
          },
        );
      }
    };

    makeBtn(30, '◀', currentPage === 0, -1);
    makeBtn(width - 30, '▶', currentPage === totalPages - 1, 1);

    const pageLabel = this.add
      .text(width / 2, y, `page ${currentPage + 1} / ${totalPages}`, {
        fontFamily: '"Courier New", monospace',
        fontSize: '10px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);
    this.trayContainer.add(pageLabel);
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

    const allBgs = Object.values(BACKGROUND_CATALOG).filter((entry) =>
      ownedBgs.includes(entry.id as BackgroundId),
    );

    const totalBgPages = Math.max(1, Math.ceil(allBgs.length / MAX_TRAY));
    if (this.bgsPage >= totalBgPages) this.bgsPage = totalBgPages - 1;
    const bgStart = this.bgsPage * MAX_TRAY;
    const pageBgs = allBgs.slice(bgStart, bgStart + MAX_TRAY);

    for (let i = 0; i < pageBgs.length; i++) {
      const entry = pageBgs[i]!;
      const col = i % THUMB_COLS;
      const row = Math.floor(i / THUMB_COLS);
      const x = padding + col * (thumbW + gapX);
      const y = padding + row * (thumbH + gapY);

      const isActive = activeBg === entry.id;
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
    }

    this.drawTrayPagination(totalBgPages, this.bgsPage, (delta) => {
      this.bgsPage = Math.max(0, Math.min(totalBgPages - 1, this.bgsPage + delta));
      this.renderTray();
    });
  }

  private bgThumbColor(id: BackgroundId): number {
    if (id === 'cozy') return 0xa16f3b;
    if (id === 'spooky') return 0x1e1b2c;
    return 0x3b2a5c; // default
  }

  private onBgThumbTap(bgId: BackgroundId): void {
    if (!this.playerState) return;
    const ownedBgs = this.playerState.ownedBackgrounds ?? (['default'] as BackgroundId[]);
    if (!ownedBgs.includes(bgId)) return;

    this.playerState.activeBackground = bgId;
    this.bg.setBackground(bgId);
    this.renderTray();

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
    if (this.onDressingRoomClosed) {
      this.events.off('dressingroom:closed', this.onDressingRoomClosed);
      this.onDressingRoomClosed = undefined;
    }
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
    this.root?.destroy(true);
    this.hud?.destroy();
  }
}

/**
 * Pick the atlas frame (and optional tint) for a cat catalog entry.
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
