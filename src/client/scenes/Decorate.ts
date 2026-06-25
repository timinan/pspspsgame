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
import { CAT_EFFECT_BY_ID } from '@/effects/cat-effects';
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
/** Reserved height for the always-visible pagination footer in CATS / BACKGROUNDS trays. */
const PAGE_FOOTER_H = 36;
/** Equal vertical whitespace used both inside the grid (top padding,
 *  between rows) and as the bottom gap before the pagination footer.
 *  Bumping all three to the same number makes the tray read as evenly
 *  distributed instead of "top tight, bottom airy". */
const TRAY_VPAD = 12;

type ActiveTab = 'CATS' | 'BACKGROUNDS';

/**
 * Phase 5 Decorate scene.
 *
 * Layout (design space 320×580):
 *   0–36      TopHud ("DECORATE" + coins)
 *   36–226    Cat stage — BackgroundManager + 3 seated cats (same positions as Game)
 *   226–580   Bottom panel — tabs (CATS / BACKGROUNDS) + 2×4 thumbnail tray
 *             (starts at LANE_TOP_Y so the eye line matches Game's play lanes)
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
  /** Name labels rendered below each seated cat. */
  private seatedNameLabels: GameObjects.Text[] = [];

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
  private tabCatsBtnBg!: GameObjects.Rectangle;
  private tabBgBtnBg!: GameObjects.Rectangle;
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
    const activeBg: BackgroundId = (this.playerState?.activeBackground ?? 'stage') as BackgroundId;
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
    // BOTH the cat stage and the tray. Tray thumbs also stack cosmetic
    // sprites now, so they need refreshing whenever a cat's loadout changes.
    this.onDressingRoomClosed = () => {
      this.repaintCatStage();
      this.renderTray();
    };
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

  /** Destroys existing cat sprites + tap zones + name labels, then re-renders from playerState. */
  private seatCats(): void {
    for (const c of this.cats) c.destroy();
    this.cats = [];
    for (const z of this.catZones) z.destroy();
    this.catZones = [];
    for (const l of this.seatedNameLabels) l.destroy();
    this.seatedNameLabels = [];

    const { width, height } = this.scale;
    const scaleY = height / L.DESIGN_H;
    // Matches Game scene's seated-cat Y so cats don't pop up/down when
    // switching between Decorate and Play. Both scenes scale cats 1.4×.
    const catY = (L.TOP_HUD_H + L.CAT_STAGE_H * 0.78) * scaleY;

    const seatedCats = this.playerState?.seatedCats ?? {};

    const inner = width - L.LANE_GUTTER_PX * 2;
    const colW = (inner - L.LANE_GAP_PX * (L.LANE_COUNT - 1)) / L.LANE_COUNT;
    const stageH = L.CAT_STAGE_H * scaleY;
    const stageMidY = (L.TOP_HUD_H + L.CAT_STAGE_H / 2) * scaleY;

    // Iterate SEAT_ORDER directly so the lane index matches the seat
    // position. Filtering empty seats out FIRST and using the filtered
    // array index would let a single cat seated in 'seat-right' render
    // in the leftmost lane (i=0) — the bug Tim caught.
    for (let i = 0; i < SEAT_ORDER.length; i++) {
      const seatId = SEAT_ORDER[i]!;
      const instanceId = seatedCats[seatId];
      if (!instanceId) continue;

      const catInstance = this.playerState?.ownedCats.find((cat) => cat.id === instanceId);
      if (!catInstance) continue;
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
        // 1.4× matches the Game scene seated-cat scale so the size doesn't
        // change when the player switches between Decorate and Play.
        scale: 1.4,
      };

      // Resolve cosmetic INSTANCE ids → catalog TYPE ids via the sidecar
      // before handing the model to Cat. Cat's renderer looks up
      // COSMETIC_CATALOG by type id; passing instance ids would fail to find
      // anything and the cosmetic frame would render as broken/missing.
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

      // Name label right under the cat's feet so players see who is who.
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
          // Anchor the menu so its TOP edge lands at the lane-top row —
          // menu opens into the empty play-bars band below the cats,
          // never covering the sprite. `vAlign: 'top'` flips ContextMenu's
          // default-centered behavior so y === menu top.
          this.openCatMenu(catInstance, seatId, cx, L.LANE_TOP_Y * scaleY, 'top');
        },
      );
      this.catZones.push(zone);

      // Red ✕ badge in the TOP-RIGHT corner of the cat. Was at
      // (cx+36, catY-40) which put it square in the middle of the body
      // — Tim flagged it as floating over the chest instead of in the
      // corner. The 1.4×-scaled cat artwork occupies roughly
      // (cx ± 45, catY-90 … catY) on a 91×64 native canvas, so 42px
      // right of center and 72px up from the feet lands at the head /
      // ear area — visibly the upper-right corner of the sprite.
      const badge = new RemoveBadge(this, cx + 42, catY - 72, () => {
        this.unseatCat(seatId);
      });
      this.add.existing(badge);
      this.removeBadges.push(badge);
    }
  }

  /**
   * Show the cat context menu (Dress up / Put on stage / Take off stage).
   * `seatId` is undefined when invoked from a tray thumb (cat is not yet placed).
   * `vAlign='top'` means anchorY is the menu's TOP edge (used by seated-cat
   * taps to land the menu at the lane-top row); default is centered on
   * anchorY (used by tray-thumb taps).
   */
  private openCatMenu(
    catInstance: OwnedCat,
    seatId: SeatId | undefined,
    anchorX: number,
    anchorY: number,
    vAlign: 'center' | 'top' = 'center',
  ): void {
    if (this.placingCatInstanceId) return;
    const rows = buildCatMenu({
      isSeated: Boolean(seatId),
      displayName: catInstance.name,
    });
    this.contextMenu.open(
      anchorX,
      anchorY,
      rows,
      (action) => {
        this.onCatMenuAction(action, catInstance, seatId);
      },
      { vAlign },
    );
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
    // Matches Game scene's seated-cat Y so cats don't pop up/down when
    // switching between Decorate and Play. Both scenes scale cats 1.4×.
    const catY = (L.TOP_HUD_H + L.CAT_STAGE_H * 0.78) * scaleY;
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
      currentKey: SceneKeys.Decorate,
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

    const { width } = this.scale;

    this.add.text(width / 2, TopHud.HEIGHT / 2, 'SET STAGE', {
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
    // Bottom panel + tabs (CATS / BACKGROUNDS) start at the same row as
    // where the play lanes begin in Game scene — keeps the eye line
    // consistent across scenes.
    const panelTop = L.LANE_TOP_Y * scaleY;
    const panelH = height - panelTop;

    this.root = this.add.container(0, panelTop).setDepth(50);

    const panelBg = this.add.rectangle(0, 0, width, panelH, 0x0b041a, 0.92).setOrigin(0, 0);
    const topBorder = this.add.rectangle(0, 0, width, 1, 0xc0a0e6, 0.25).setOrigin(0, 0);
    this.root.add([panelBg, topBorder]);

    // Tab strip styled like the dressing room's slot tabs (HEAD / FACE /
    // NECK / EFFECT) for visual consistency: filled pill with a yellow
    // stroke + label on the active side, dim + faint purple on the
    // inactive. Switching toggles fill / stroke / text colour together.
    const tabH = 32;
    const tabRowBg = this.add.rectangle(0, 0, width, tabH + 6, 0x0b041a, 1).setOrigin(0, 0);
    this.root.add([tabRowBg]);

    const inset = 10;
    const gap = 6;
    const tabW = (width - inset * 2 - gap) / 2;
    const tabY = 3;

    const catsBtnBg = this.add
      .rectangle(inset, tabY, tabW, tabH, 0x2c1856, 1)
      .setOrigin(0, 0)
      .setStrokeStyle(2, 0xffd34d, 1)
      .setInteractive({ useHandCursor: true });
    this.tabCatsText = this.add.text(inset + tabW / 2, tabY + tabH / 2, 'CATS', {
      fontFamily: 'Pixeloid Sans, sans-serif',
      fontStyle: 'bold',
      fontSize: '12px',
      color: '#ffd34d',
    }).setOrigin(0.5);
    // tabCatsLine retained as a no-op rect so the field type stays
    // satisfied; the new style replaces the underline with a full stroke.
    this.tabCatsLine = this.add.rectangle(0, 0, 1, 1, 0x000000, 0).setVisible(false);
    catsBtnBg.on('pointerdown', () => this.switchTab('CATS'));
    this.root.add([catsBtnBg, this.tabCatsText, this.tabCatsLine]);

    const bgX = inset + tabW + gap;
    const bgBtnBg = this.add
      .rectangle(bgX, tabY, tabW, tabH, 0x0b041a, 0.6)
      .setOrigin(0, 0)
      .setStrokeStyle(2, 0xc0a0e6, 0.35)
      .setInteractive({ useHandCursor: true });
    this.tabBgText = this.add.text(bgX + tabW / 2, tabY + tabH / 2, 'BACKGROUNDS', {
      fontFamily: 'Pixeloid Sans, sans-serif',
      fontStyle: 'bold',
      fontSize: '12px',
      color: '#c0a0e6',
    }).setOrigin(0.5);
    this.tabBgLine = this.add.rectangle(0, 0, 1, 1, 0x000000, 0).setVisible(false);
    bgBtnBg.on('pointerdown', () => this.switchTab('BACKGROUNDS'));
    this.root.add([bgBtnBg, this.tabBgText, this.tabBgLine]);

    // Hold the bg refs on the instance so switchTab can repaint them.
    this.tabCatsBtnBg = catsBtnBg;
    this.tabBgBtnBg = bgBtnBg;

    this.trayContainer = this.add.container(0, tabH);
    this.root.add(this.trayContainer);

    this.renderTray();
  }

  private switchTab(tab: ActiveTab): void {
    if (this.activeTab === tab) return;
    this.activeTab = tab;

    if (tab === 'CATS') {
      this.tabCatsText.setColor('#ffd34d');
      this.tabCatsBtnBg.setFillStyle(0x2c1856, 1);
      this.tabCatsBtnBg.setStrokeStyle(2, 0xffd34d, 1);
      this.tabBgText.setColor('#c0a0e6');
      this.tabBgBtnBg.setFillStyle(0x0b041a, 0.6);
      this.tabBgBtnBg.setStrokeStyle(2, 0xc0a0e6, 0.35);
    } else {
      this.tabBgText.setColor('#ffd34d');
      this.tabBgBtnBg.setFillStyle(0x2c1856, 1);
      this.tabBgBtnBg.setStrokeStyle(2, 0xffd34d, 1);
      this.tabCatsText.setColor('#c0a0e6');
      this.tabCatsBtnBg.setFillStyle(0x0b041a, 0.6);
      this.tabCatsBtnBg.setStrokeStyle(2, 0xc0a0e6, 0.35);
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
    const panelTop = L.LANE_TOP_Y * scaleY;
    const panelH = height - panelTop;
    const tabH = 38;
    const trayH = panelH - tabH;
    // Reserve the bottom strip for the always-visible pagination footer
    // so the thumbnail grid never overlaps with it. TRAY_VPAD doubles as
    // top padding, inter-row gap, AND bottom gap before the footer so
    // the spacing reads as evenly distributed.
    const gridH = trayH - PAGE_FOOTER_H - TRAY_VPAD;

    const gapX = 6;
    const thumbW = (width - TRAY_VPAD * 2 - gapX * (THUMB_COLS - 1)) / THUMB_COLS;
    const thumbH = (gridH - TRAY_VPAD * 2 - TRAY_VPAD * (THUMB_ROWS - 1)) / THUMB_ROWS;
    const padding = TRAY_VPAD;
    const gapY = TRAY_VPAD;

    // ownedCats is now OwnedCat[]. Iterate instances directly.
    const rawOwnedCats = this.playerState?.ownedCats ?? [];
    const seatedCats = this.playerState?.seatedCats ?? {};

    // Reorder so the currently-seated cats appear first in the tray,
    // in seat order (left → center → right). Unseated cats follow in
    // their original catalog order. Tim's rule: preselected cats up
    // top so the player sees their stage lineup at a glance.
    const seatedIdsInOrder = SEAT_ORDER
      .map((sid) => seatedCats[sid])
      .filter((id): id is string => !!id);
    const seatedSet = new Set(seatedIdsInOrder);
    const seatedFirst = seatedIdsInOrder
      .map((id) => rawOwnedCats.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => !!c);
    const restCats = rawOwnedCats.filter((c) => !seatedSet.has(c.id));
    const ownedCats = [...seatedFirst, ...restCats];

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

      // Every cell renders a visible box — yellow ring when seated,
      // soft purple at high enough alpha to actually read against the
      // tray's near-black bg (DressingRoom's 0.3 disappears here).
      const thumb = this.add
        .rectangle(x + thumbW / 2, y + thumbH / 2, thumbW, thumbH, 0x0b041a, 0.6)
        .setInteractive({ useHandCursor: true });
      if (isSeated) thumb.setStrokeStyle(2, 0xffd34d, 1);
      else thumb.setStrokeStyle(2, 0xc0a0e6, 0.65);

      const { frame, tint } = catThumbFrame(catEntry);
      // Reserve enough at the bottom for a two-line wrapped name label —
      // 11px font × 1.2 line-height × 2 lines ≈ 27, plus a 4px gutter.
      const labelReserve = 32;
      const sprite = this.add.image(
        x + thumbW / 2,
        y + (thumbH - labelReserve) / 2 + 4,
        AssetKeys.Atlas.Cats,
        frame,
      );
      // Fill the cell as much as possible — the cat should dominate the
      // thumbnail. Allow horizontal overflow up to 98% of the cell width
      // (cat sprites are taller than wide so scaling to width usually wins).
      const maxW = thumbW * 0.98;
      const maxH = thumbH - labelReserve;
      const scale = Math.min(maxW / sprite.width, maxH / sprite.height);
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
        // Effect cosmetics are code-driven (glow / bobbing / particles) — they
        // can't render as a static thumbnail overlay. Skip them silently here;
        // the tray still indicates the cat is wearing one via the cat sprite
        // itself in the preview stage.
        if (CAT_EFFECT_BY_ID[cosTypeId]) continue;
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

      // Static effect-indicator badge in the top-left of the thumb. Live
      // effects are too noisy at thumbnail scale, so the badge just says
      // "this cat has [emoji] equipped" — full effect plays on the seated
      // preview above.
      const equippedEffectInstanceId = equippedSlots['effect'];
      if (equippedEffectInstanceId) {
        const effectTypeId = equippedTypes[equippedEffectInstanceId];
        const effectMeta = effectTypeId ? CAT_EFFECT_BY_ID[effectTypeId] : undefined;
        if (effectMeta) {
          const badgeBg = this.add
            .circle(x + 10, y + 10, 9, 0x0b041a, 0.85)
            .setStrokeStyle(1, 0xffd34d, 0.6);
          const badgeIcon = this.add
            .text(x + 10, y + 10, effectMeta.iconEmoji, { fontSize: '11px' })
            .setOrigin(0.5);
          this.trayContainer.add([badgeBg, badgeIcon]);
        }
      }

      // Label uses the instance's custom name. wordWrap kicks in for any
      // name wider than the cell minus a small inset — "RAINBOW WHISKERS"
      // wraps to "RAINBOW\nWHISKERS" instead of needing an ellipsis cut.
      const label = this.add.text(
        x + thumbW / 2,
        y + thumbH - 6,
        catInstance.name.toUpperCase(),
        {
          fontFamily: '"Courier New", monospace',
          fontStyle: 'bold',
          fontSize: '11px',
          color: '#ffffff',
          align: 'center',
          wordWrap: { width: thumbW - 8, useAdvancedWrap: true },
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
    // Footer is ALWAYS rendered. When there's only one page, the buttons
    // grey out so the player gets a visual cue without the footer disappearing.
    const { width, height } = this.scale;
    const scaleY = height / L.DESIGN_H;
    const panelTop = L.LANE_TOP_Y * scaleY;
    const panelH = height - panelTop;
    const tabH = 38;
    const trayH = panelH - tabH;
    const y = trayH - PAGE_FOOTER_H / 2;

    // Background strip so the footer reads as a footer, not floating buttons.
    const footerBg = this.add
      .rectangle(0, trayH - PAGE_FOOTER_H, width, PAGE_FOOTER_H, 0x0b041a, 1)
      .setOrigin(0, 0);
    const footerBorder = this.add
      .rectangle(0, trayH - PAGE_FOOTER_H, width, 1, 0xc0a0e6, 0.15)
      .setOrigin(0, 0);
    this.trayContainer.add([footerBg, footerBorder]);

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

    // Pronounced page indicator — bigger, bold, brighter so the player
    // can read it at a glance instead of squinting at the tiny grey 10 px.
    const pageLabel = this.add
      .text(width / 2, y, `PAGE ${currentPage + 1} / ${totalPages}`, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '14px',
        color: '#ffd34d',
        stroke: '#1a0a2e',
        strokeThickness: 3,
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
    const panelTop = L.LANE_TOP_Y * scaleY;
    const panelH = height - panelTop;
    const tabH = 38;
    const trayH = panelH - tabH;
    // Same footer reserve + even-padding as the CATS tray so the
    // pagination strip lines up flush across tabs.
    const gridH = trayH - PAGE_FOOTER_H - TRAY_VPAD;

    const gapX = 6;
    const thumbW = (width - TRAY_VPAD * 2 - gapX * (THUMB_COLS - 1)) / THUMB_COLS;
    const thumbH = (gridH - TRAY_VPAD * 2 - TRAY_VPAD * (THUMB_ROWS - 1)) / THUMB_ROWS;
    const padding = TRAY_VPAD;
    const gapY = TRAY_VPAD;

    const ownedBgs = this.playerState?.ownedBackgrounds ?? (['stage'] as BackgroundId[]);
    const activeBg = this.playerState?.activeBackground ?? ('stage' as BackgroundId);

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

      // Background backdrop as the actual thumbnail. Borderless on
      // inactive thumbs (matches dressing room treatment); active bg
      // gets a green ring so the current pick still pops.
      const thumb = this.textures.exists(entry.backdropKey)
        ? this.add
            .image(x + thumbW / 2, y + thumbH / 2, entry.backdropKey)
            .setDisplaySize(thumbW, thumbH)
            .setInteractive({ useHandCursor: true })
        : this.add
            .rectangle(x + thumbW / 2, y + thumbH / 2, thumbW, thumbH, 0x3b2a5c, 1)
            .setInteractive({ useHandCursor: true });

      // Border alpha pumped (0.35 → 0.65) so the inactive box reads
      // against the bg thumbnail's saturated artwork. Active = green
      // ring full alpha.
      const border = this.add
        .rectangle(x + thumbW / 2, y + thumbH / 2, thumbW, thumbH, 0x000000, 0)
        .setStrokeStyle(2, isActive ? 0x4dffb4 : 0xc0a0e6, isActive ? 1 : 0.65);

      // Bigger than the 7px stub — backdrop labels read at 11px now and
      // wrap into the cell width if the name is too long for one line.
      const label = this.add.text(x + thumbW / 2, y + thumbH - 6, entry.displayName.toUpperCase(), {
        fontFamily: '"Courier New", monospace',
        fontStyle: 'bold',
        fontSize: '11px',
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 3,
        align: 'center',
        wordWrap: { width: thumbW - 8, useAdvancedWrap: true },
      }).setOrigin(0.5, 1);

      this.trayContainer.add([thumb, label]);
      this.trayContainer.add(border);

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

  private onBgThumbTap(bgId: BackgroundId): void {
    if (!this.playerState) return;
    const ownedBgs = this.playerState.ownedBackgrounds ?? (['stage'] as BackgroundId[]);
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
    for (const l of this.seatedNameLabels) l.destroy();
    this.seatedNameLabels = [];
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
