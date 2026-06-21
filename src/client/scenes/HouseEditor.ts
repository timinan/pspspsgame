import { GameObjects, Scene, Scenes } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { TopHud } from '@/ui/top-hud';
import { RoomRenderer } from '@/entities/room-renderer';
import { SCENE_SLOTS, SCENE_SEATS, designToCanvas } from '@/constants/scene-slots';
import { SlotGhost } from '@/entities/slot-ghost';
import { SeatGhost } from '@/entities/seat-ghost';
import { fetchState, setDecorationInSlot, setSeat, sellItem, rehomeCat, setTheme } from '@/services/state-client';
import { ContextMenu, buildDecorMenu, buildCatMenu } from '@/ui/context-menu';
import { ConfirmModal } from '@/ui/confirm-modal';
import { DECORATION_CATALOG, CAT_CATALOG, THEME_CATALOG } from '@/../shared/state';
import { COSMETIC_CATALOG } from '@/../shared/state'; // TEMP-DEMO: for cosmetics-as-decor test
import { parentIdFor } from '@/entities/cat'; // TEMP-DEMO: for cosmetic frame derivation
import { AssetKeys } from '@/constants/assets';
import type { PlayerState } from '@/../shared/state';
import { RemoveBadge } from '@/entities/remove-badge';

/**
 * Edit-mode scene. Shares room rendering with the Game scene via
 * RoomRenderer. Adds slot ghosts, seat ghosts, ✕ remove badges, a bottom
 * tray, and a context menu surface.
 *
 * Phase 4 Task 15: tabs (DECOR / CATS / THEMES), context menus, placement
 * mode, and all tray actions wired up.
 */
export class HouseEditor extends Scene {
  private playerState!: PlayerState;
  private topHud!: TopHud;
  private roomRenderer!: RoomRenderer;
  private slotGhosts: SlotGhost[] = [];
  private seatGhosts: SeatGhost[] = [];
  private trayContainer!: GameObjects.Container;
  private activeTab: 'decor' | 'cats' | 'themes' = 'decor';
  private tabsBar!: GameObjects.Container;
  private tabContent!: GameObjects.Container;
  private contextMenu!: ContextMenu;
  private confirmModal!: ConfirmModal;
  private placementMode: { kind: 'decor' | 'cat'; itemId: string } | null = null;
  private removeBadges: RemoveBadge[] = [];
  private decorScrollY = 0;
  private catsScrollY = 0;
  private decorMaxScroll = 0;
  private catsMaxScroll = 0;
  private scrollMask: Phaser.Display.Masks.GeometryMask | null = null;
  private scrollMaskGfx: Phaser.GameObjects.Graphics | null = null;
  private scrollbarThumb: Phaser.GameObjects.Rectangle | null = null;

  constructor() {
    super(SceneKeys.HouseEditor);
  }

  init(data: { playerState?: PlayerState }): void {
    this.slotGhosts = [];
    this.seatGhosts = [];
    if (data?.playerState) {
      this.playerState = data.playerState;
    }
  }

  async create(): Promise<void> {
    this.events.once(Scenes.Events.SHUTDOWN, () => this.cleanup());

    if (!this.playerState) {
      this.playerState = await fetchState();
    }

    // TopHud in edit mode
    this.topHud = new TopHud(this, {
      items: [
        {
          label: 'Boxes',
          description: 'spend coins, pull rewards',
          icon: '📦',
          onTap: () => this.scene.start(SceneKeys.Boxes),
        },
        {
          label: 'Back to Game',
          description: 'play your house',
          icon: '▶️',
          onTap: () => this.exitToGame(),
        },
      ],
      showStats: true,
    });
    this.topHud.setMode('edit', { onDone: () => this.exitToGame() });

    // Room (theme + decorations + seated cats)
    this.roomRenderer = new RoomRenderer(this);
    this.roomRenderer.renderFrom(this.playerState);

    // TEMP-DEMO: visualize floor line where seats anchor
    const { y: floorY } = designToCanvas(this, 0, 370);
    this.add.line(0, 0, 0, floorY, this.scale.width, floorY, 0xff5050, 0.5).setOrigin(0, 0);
    this.add.text(this.scale.width - 8, floorY - 12, 'floor (design y=370)', {
      fontFamily: 'Pixeloid Sans, sans-serif',
      fontSize: '9px',
      color: '#ff5050',
    }).setOrigin(1, 0);

    // Slot ghosts (only for empty slots)
    for (const slot of SCENE_SLOTS) {
      if (this.playerState.house.decorations[slot.id]) continue;
      const ghost = new SlotGhost(this, slot);
      this.add.existing(ghost);
      this.slotGhosts.push(ghost);
    }

    // Seat ghosts (only for empty seats)
    for (const seat of SCENE_SEATS) {
      if (this.playerState.seatedCats[seat.id]) continue;
      const ghost = new SeatGhost(this, seat);
      this.add.existing(ghost);
      this.seatGhosts.push(ghost);
    }

    // Tray placeholder — filled in by tabs below
    this.trayContainer = this.add.container(0, this.scale.height - 140).setDepth(80);
    const trayBg = this.add
      .rectangle(0, 0, this.scale.width, 140, 0x2c1856, 0.95)
      .setOrigin(0, 0);
    trayBg.setStrokeStyle(2, 0xc0a0e6, 0.4);
    this.trayContainer.add(trayBg);

    this.contextMenu = new ContextMenu(this);
    this.confirmModal = new ConfirmModal(this);
    this.tabContent = this.add.container(0, this.scale.height - 108).setDepth(82);

    // Set up scroll mask for the tab content viewport
    const vp = this.getViewport();
    this.scrollMaskGfx = this.make.graphics({ x: 0, y: 0 }, false);
    this.scrollMaskGfx.fillStyle(0xffffff);
    this.scrollMaskGfx.fillRect(0, vp.top, vp.width, vp.height);
    this.scrollMask = this.scrollMaskGfx.createGeometryMask();
    this.tabContent.setMask(this.scrollMask);

    this.drawTabBar();
    this.renderActiveTab();

    // Scene-level pointermove for drag-to-scroll (passive — doesn't intercept item taps)
    let dragStartY = 0;
    let dragStartScrollY = 0;
    let dragActive = false;
    const DRAG_THRESHOLD = 5;

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (this.contextMenu.isOpen()) this.contextMenu.close();
      const vpArea = this.getViewport();
      if (pointer.y >= vpArea.top && pointer.y <= vpArea.top + vpArea.height) {
        dragStartY = pointer.y;
        dragStartScrollY = this.activeTab === 'decor' ? this.decorScrollY
          : this.activeTab === 'cats' ? this.catsScrollY : 0;
        dragActive = false;
      }
    });

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (!pointer.isDown) return;
      const vpArea = this.getViewport();
      if (pointer.y < vpArea.top || pointer.y > vpArea.top + vpArea.height) return;
      if (this.activeTab !== 'decor' && this.activeTab !== 'cats') return;

      const delta = pointer.y - dragStartY;
      if (Math.abs(delta) < DRAG_THRESHOLD && !dragActive) return;
      dragActive = true;

      const maxScroll = this.activeTab === 'decor' ? this.decorMaxScroll : this.catsMaxScroll;
      const newScroll = Phaser.Math.Clamp(dragStartScrollY - delta, 0, maxScroll);

      if (this.activeTab === 'decor') this.decorScrollY = newScroll;
      else this.catsScrollY = newScroll;

      this.applyTabScroll(this.activeTab);

      // Sync scrollbar thumb
      if (this.scrollbarThumb && maxScroll > 0) {
        const contentHeight = vpArea.height + maxScroll;
        const thumbHeight = Math.max(20, (vpArea.height / contentHeight) * vpArea.height);
        const thumbScrollRange = vpArea.height - thumbHeight;
        this.scrollbarThumb.y = vpArea.top + (newScroll / maxScroll) * thumbScrollRange;
      }
    });

    // Listen for ghost taps
    this.events.on('slot:tap', (slotId: string) => this.onSlotTap(slotId));
    this.events.on('seat:tap', (seatId: string) => this.onSeatTap(seatId));

    this.wireSeatedCatTaps();
    this.wireRemoveBadges();
  }

  private drawTabBar(): void {
    this.tabsBar?.destroy(true);
    const trayY = this.scale.height - 140;
    this.tabsBar = this.add.container(0, trayY + 4).setDepth(82);
    const tabs: { key: 'decor' | 'cats' | 'themes'; label: string }[] = [
      { key: 'decor',  label: 'DECOR' },
      { key: 'cats',   label: 'CATS' },
      { key: 'themes', label: 'THEMES' },
    ];
    const tabW = Math.floor(this.scale.width / 3);
    tabs.forEach((t, i) => {
      const isActive = this.activeTab === t.key;
      const x = i * tabW + tabW / 2;
      const bg = this.add
        .rectangle(x, 14, tabW - 4, 24, isActive ? 0x2c1856 : 0x1a0a2e, 1)
        .setInteractive({ useHandCursor: true });
      if (isActive) {
        const underline = this.add.rectangle(x, 26, tabW - 4, 2, 0xffd34d, 1);
        this.tabsBar.add(underline);
      }
      const label = this.add
        .text(x, 14, t.label, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '11px',
          color: isActive ? '#ffd34d' : '#c0a0e6',
        })
        .setOrigin(0.5);
      this.tabsBar.add([bg, label]);
      bg.on('pointerdown', () => this.switchTab(t.key));
    });
  }

  private switchTab(key: 'decor' | 'cats' | 'themes'): void {
    if (this.placementMode) return; // ignore tab swap while placing
    this.activeTab = key;
    this.contextMenu.close();
    this.drawTabBar();
    this.renderActiveTab();
  }

  private renderActiveTab(): void {
    this.tabContent.removeAll(true);
    if (this.activeTab === 'decor') this.renderDecorTab();
    else if (this.activeTab === 'cats') this.renderCatsTab();
    else this.renderThemesTab();
  }

  private renderDecorTab(): void {
    // TEMP-DEMO: iterate ownedCosmetics instead of ownedDecorations
    // Original code used: const owned = this.playerState.house.ownedDecorations;
    const owned = this.playerState.ownedCosmetics;
    const placed = new Set(Object.values(this.playerState.house.decorations));
    const cellW = 48;
    const gap = 6;
    const cols = 5;
    const startX = 12;
    const startY = 4;

    owned.forEach((cosId, i) => {
      // TEMP-DEMO: look up in COSMETIC_CATALOG instead of DECORATION_CATALOG
      const entry = COSMETIC_CATALOG.find((c) => c.id === cosId);
      if (!entry) return; // TEMP-DEMO: frame is always derivable from id, no sourceFrame guard
      // TEMP-DEMO: derive frame from parentIdFor (handles both base and tint-variant cosmetics)
      const renderId = parentIdFor(entry) ?? entry.id;
      const frame = `cosmetic_${renderId}_idle_00`;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = startX + col * (cellW + gap) + cellW / 2;
      const y = startY + row * (cellW + gap) + cellW / 2;
      const isPlaced = placed.has(cosId);
      const bg = this.add
        .rectangle(x, y, cellW, cellW, isPlaced ? 0x1a0a2e : 0x0b041a, isPlaced ? 1 : 0.6)
        .setStrokeStyle(1, isPlaced ? 0xffd34d : 0xc0a0e6, isPlaced ? 1 : 0.3)
        .setInteractive({ useHandCursor: true });
      // TEMP-DEMO: use Cosmetics atlas instead of Decorations atlas
      const sprite = this.add
        .sprite(x, y, AssetKeys.Atlas.Cosmetics, frame)
        .setScale(0.9);
      if (entry.tint) {
        const colorInt = parseInt(entry.tint.replace('#', ''), 16);
        sprite.setTint(colorInt);
      }
      this.tabContent.add([bg, sprite]);
      if (isPlaced) {
        const tick = this.add.circle(x + cellW / 2 - 4, y - cellW / 2 + 4, 7, 0xffd34d, 1);
        const tickText = this.add
          .text(x + cellW / 2 - 4, y - cellW / 2 + 4, '✓', {
            fontSize: '10px', fontStyle: 'bold', color: '#1a0a2e',
          })
          .setOrigin(0.5);
        this.tabContent.add([tick, tickText]);
      }
      bg.on('pointerdown', (_p: unknown, _x: unknown, _y: unknown, event: Phaser.Types.Input.EventData) => {
        event.stopPropagation();
        const worldX = this.tabContent.x + x;
        const worldY = this.tabContent.y + y - cellW / 2;
        this.openDecorMenu(worldX, worldY, cosId, entry.name, isPlaced);
      });
    });

    // Compute total content height and max scroll
    const totalRows = Math.ceil(owned.length / cols);
    const contentHeight = totalRows * (cellW + gap);
    const vp = this.getViewport();
    this.decorMaxScroll = Math.max(0, contentHeight - vp.height + 8);

    // Render scrollbar and apply current scroll position
    this.renderScrollbar('decor', vp);
    this.applyTabScroll('decor');
  }

  private getViewport(): { top: number; height: number; width: number } {
    return {
      top: this.scale.height - 108,
      height: 104,
      width: this.scale.width,
    };
  }

  private applyTabScroll(tab: 'decor' | 'cats'): void {
    const vp = this.getViewport();
    const scrollY = tab === 'decor' ? this.decorScrollY : this.catsScrollY;
    this.tabContent.y = vp.top - scrollY;
  }

  private renderScrollbar(tab: 'decor' | 'cats', vp: { top: number; height: number; width: number }): void {
    const maxScroll = tab === 'decor' ? this.decorMaxScroll : this.catsMaxScroll;
    if (maxScroll <= 0) {
      this.scrollbarThumb?.destroy();
      this.scrollbarThumb = null;
      return;
    }

    const sbX = this.scale.width - 8;
    const sbWidth = 6;

    // Track — added directly to scene (not tabContent) so it isn't masked or scrolled
    this.add.rectangle(sbX, vp.top, sbWidth, vp.height, 0x000000, 0.25)
      .setOrigin(0.5, 0)
      .setDepth(83);

    // Thumb height proportional to content visibility
    const contentHeight = vp.height + maxScroll;
    const thumbHeight = Math.max(20, (vp.height / contentHeight) * vp.height);
    const thumbScrollRange = vp.height - thumbHeight;
    const scrollY = tab === 'decor' ? this.decorScrollY : this.catsScrollY;
    const thumbY = vp.top + (scrollY / maxScroll) * thumbScrollRange;

    this.scrollbarThumb?.destroy();
    this.scrollbarThumb = this.add.rectangle(sbX, thumbY, sbWidth, thumbHeight, 0xc0a0e6, 0.85)
      .setOrigin(0.5, 0)
      .setDepth(84)
      .setInteractive({ useHandCursor: true, draggable: true });

    this.input.setDraggable(this.scrollbarThumb);

    this.scrollbarThumb.on('drag', (_p: unknown, _x: unknown, dragY: number) => {
      const clampedY = Phaser.Math.Clamp(dragY, vp.top, vp.top + thumbScrollRange);
      const ratio = (clampedY - vp.top) / thumbScrollRange;
      const newScroll = ratio * maxScroll;
      if (tab === 'decor') this.decorScrollY = newScroll;
      else this.catsScrollY = newScroll;
      this.scrollbarThumb!.y = clampedY;
      this.applyTabScroll(tab);
    });
  }

  private openDecorMenu(x: number, y: number, decoId: string, displayName: string, isPlaced: boolean): void {
    const rows = buildDecorMenu({ isPlaced, displayName });
    this.contextMenu.open(x, y, rows, (action) => this.handleDecorAction(action, decoId));
  }

  private async handleDecorAction(action: string, decoId: string): Promise<void> {
    if (action === 'place') {
      this.startPlacement('decor', decoId);
    } else if (action === 'takedown') {
      const slotEntry = Object.entries(this.playerState.house.decorations).find(([, d]) => d === decoId);
      if (!slotEntry) return;
      this.playerState = await setDecorationInSlot(slotEntry[0], null);
      this.refreshRoom();
    } else if (action === 'sell') {
      this.playerState = await sellItem('decoration', decoId);
      this.topHud.setCoins(this.playerState.coins);
      this.refreshRoom();
    }
  }

  private renderCatsTab(): void {
    const owned = this.playerState.ownedCats;
    const seated = new Set(Object.values(this.playerState.seatedCats));
    const cellW = 48;
    const gap = 6;
    const cols = 5;
    const startX = 12;
    const startY = 4;

    owned.forEach((catId, i) => {
      const entry = CAT_CATALOG.find((c) => c.id === catId);
      if (!entry) return;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = startX + col * (cellW + gap) + cellW / 2;
      const y = startY + row * (cellW + gap) + cellW / 2;
      const isSeated = seated.has(catId);
      const bg = this.add
        .rectangle(x, y, cellW, cellW, isSeated ? 0x1a0a2e : 0x0b041a, isSeated ? 1 : 0.6)
        .setStrokeStyle(1, isSeated ? 0xffd34d : 0xc0a0e6, isSeated ? 1 : 0.3)
        .setInteractive({ useHandCursor: true });
      const frame = catId === 'rainbow' ? 'cat6_idle_00' : `${catId}_idle_00`;
      const sprite = this.add
        .sprite(x, y, AssetKeys.Atlas.Cats, frame)
        .setScale(0.6);
      this.tabContent.add([bg, sprite]);
      if (isSeated) {
        const tick = this.add.circle(x + cellW / 2 - 4, y - cellW / 2 + 4, 7, 0xffd34d, 1);
        const tickText = this.add
          .text(x + cellW / 2 - 4, y - cellW / 2 + 4, '✓', { fontSize: '10px', fontStyle: 'bold', color: '#1a0a2e' })
          .setOrigin(0.5);
        this.tabContent.add([tick, tickText]);
      }
      bg.on('pointerdown', (_p: unknown, _x: unknown, _y: unknown, event: Phaser.Types.Input.EventData) => {
        event.stopPropagation();
        const worldX = this.tabContent.x + x;
        const worldY = this.tabContent.y + y - cellW / 2;
        this.openCatMenu(worldX, worldY, catId, entry.name, isSeated);
      });
    });

    // Compute total content height and max scroll
    const totalRows = Math.ceil(owned.length / cols);
    const contentHeight = totalRows * (cellW + gap);
    const vp = this.getViewport();
    this.catsMaxScroll = Math.max(0, contentHeight - vp.height + 8);

    // Render scrollbar and apply current scroll position
    this.renderScrollbar('cats', vp);
    this.applyTabScroll('cats');
  }

  private openCatMenu(x: number, y: number, catId: string, displayName: string, isSeated: boolean): void {
    const rows = buildCatMenu({ isSeated, displayName });
    this.contextMenu.open(x, y, rows, (action) => this.handleCatAction(action, catId, displayName));
  }

  private async handleCatAction(action: string, catId: string, displayName: string): Promise<void> {
    if (action === 'seat') {
      this.startPlacement('cat', catId);
    } else if (action === 'unseat') {
      const seatEntry = Object.entries(this.playerState.seatedCats).find(([, c]) => c === catId);
      if (!seatEntry) return;
      this.playerState = await setSeat(seatEntry[0], null);
      this.refreshRoom();
    } else if (action === 'dressup') {
      this.openDressingRoom(catId);
    } else if (action === 'rehome') {
      this.confirmModal.open({
        title: 'Rehome ' + displayName + '?',
        body: "They'll be gone forever. This can't be undone.",
        confirmLabel: 'Rehome',
        onConfirm: async () => {
          this.playerState = await rehomeCat(catId);
          this.refreshRoom();
        },
      });
    }
  }

  private renderThemesTab(): void {
    const owned = this.playerState.house.ownedThemes;
    const active = this.playerState.house.themeId;
    const cellW = (this.scale.width - 32) / 3;
    const cellH = 64;
    const startX = 12;
    const startY = 4;
    owned.forEach((themeId, i) => {
      const entry = THEME_CATALOG.find((t) => t.id === themeId);
      if (!entry) return;
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = startX + col * (cellW + 4) + cellW / 2;
      const y = startY + row * (cellH + 6) + cellH / 2;
      const isActive = themeId === active;
      const bg = this.add
        .rectangle(x, y, cellW - 4, cellH - 4, 0x0b041a, 0.7)
        .setStrokeStyle(2, isActive ? 0x4dffb4 : 0xc0a0e6, isActive ? 1 : 0.3)
        .setInteractive({ useHandCursor: !isActive });
      const preview = this.add
        .image(x, y - 8, entry.backdropKey)
        .setDisplaySize(cellW - 16, cellH - 28);
      const label = this.add
        .text(x, y + cellH / 2 - 12, entry.displayName, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontSize: '9px',
          color: isActive ? '#4dffb4' : '#ffffff',
        })
        .setOrigin(0.5);
      this.tabContent.add([bg, preview, label]);
      if (!isActive) {
        bg.on('pointerdown', async () => {
          this.playerState = await setTheme(themeId);
          this.refreshRoom();
        });
      }
    });
  }

  private refreshRoom(): void {
    this.roomRenderer.destroy();
    for (const g of this.slotGhosts) g.destroy();
    for (const g of this.seatGhosts) g.destroy();
    this.slotGhosts = [];
    this.seatGhosts = [];

    this.roomRenderer = new RoomRenderer(this);
    this.roomRenderer.renderFrom(this.playerState);

    for (const slot of SCENE_SLOTS) {
      if (this.playerState.house.decorations[slot.id]) continue;
      const ghost = new SlotGhost(this, slot);
      this.add.existing(ghost);
      this.slotGhosts.push(ghost);
    }
    for (const seat of SCENE_SEATS) {
      if (this.playerState.seatedCats[seat.id]) continue;
      const ghost = new SeatGhost(this, seat);
      this.add.existing(ghost);
      this.seatGhosts.push(ghost);
    }
    this.renderActiveTab();
    this.wireSeatedCatTaps();
    this.wireRemoveBadges();
  }

  private startPlacement(kind: 'decor' | 'cat', itemId: string): void {
    this.placementMode = { kind, itemId };
    const itemName = kind === 'decor'
      ? DECORATION_CATALOG.find((d) => d.id === itemId)?.displayName ?? itemId
      : CAT_CATALOG.find((c) => c.id === itemId)?.name ?? itemId;
    this.topHud.setMode('placing', {
      itemName,
      onCancel: () => this.cancelPlacement(),
    });
    if (kind === 'decor') {
      for (const g of this.slotGhosts) g.startPulse(0xffd34d);
    } else {
      for (const g of this.seatGhosts) g.startPulse(0x4dffb4);
    }
  }

  private cancelPlacement(): void {
    this.placementMode = null;
    this.topHud.setMode('edit', { onDone: () => this.exitToGame() });
    for (const g of this.slotGhosts) g.stopPulse();
    for (const g of this.seatGhosts) g.stopPulse();
  }

  private async onSlotTap(slotId: string): Promise<void> {
    if (!this.placementMode || this.placementMode.kind !== 'decor') return;
    const itemId = this.placementMode.itemId;
    this.cancelPlacement();
    this.playerState = await setDecorationInSlot(slotId, itemId);
    this.refreshRoom();
  }

  private async onSeatTap(seatId: string): Promise<void> {
    if (!this.placementMode || this.placementMode.kind !== 'cat') return;
    const itemId = this.placementMode.itemId;
    this.cancelPlacement();
    this.playerState = await setSeat(seatId, itemId);
    this.refreshRoom();
  }

  private exitToGame(): void {
    this.scene.start(SceneKeys.Game, { playerState: this.playerState });
  }

  private openDressingRoom(catId: string): void {
    this.scene.pause();
    this.scene.launch(SceneKeys.DressingRoom, { catId, playerState: this.playerState });
    this.events.once(Scenes.Events.RESUME, () => {
      // playerState was mutated in-place by DressingRoom (shared reference).
      // Just refresh — no network round-trip needed.
      this.refreshRoom();
    });
  }

  private wireSeatedCatTaps(): void {
    const sprites = this.roomRenderer.getSeatedCatSprites();
    for (const [seatId, sprite] of sprites) {
      const catId = this.playerState.seatedCats[seatId];
      if (!catId) continue;
      sprite.setInteractive({ useHandCursor: true });
      sprite.on('pointerdown', (_p: unknown, _x: unknown, _y: unknown, event: Phaser.Types.Input.EventData) => {
        event.stopPropagation();
        this.openDressingRoom(catId);
      });
    }
  }

  private wireRemoveBadges(): void {
    for (const badge of this.removeBadges) badge.destroy(true);
    this.removeBadges = [];

    // Badges for placed decorations
    const decoSprites = this.roomRenderer.getDecorationSprites();
    for (const [slotId, deco] of decoSprites) {
      const badgeX = deco.x + (deco.width * (1 - deco.originX)) - 4;
      const badgeY = deco.y - (deco.height * deco.originY) + 4;
      const badge = new RemoveBadge(this, 0, 0, async () => {
        this.playerState = await setDecorationInSlot(slotId, null);
        this.refreshRoom();
      });
      badge.setPosition(badgeX, badgeY).setDepth(30);
      this.add.existing(badge);
      this.removeBadges.push(badge);
    }

    // Badges for seated cats
    const catSprites = this.roomRenderer.getSeatedCatSprites();
    for (const [seatId, sprite] of catSprites) {
      const badgeX = sprite.x + (sprite.width * (1 - sprite.originX)) - 4;
      const badgeY = sprite.y - (sprite.height * sprite.originY) + 4;
      const badge = new RemoveBadge(this, 0, 0, async () => {
        this.playerState = await setSeat(seatId, null);
        this.refreshRoom();
      });
      badge.setPosition(badgeX, badgeY).setDepth(30);
      this.add.existing(badge);
      this.removeBadges.push(badge);
    }
  }

  private cleanup(): void {
    this.topHud?.destroy();
    this.contextMenu?.destroy();
    this.confirmModal?.destroy();
    this.roomRenderer?.destroy();
    for (const g of this.slotGhosts) g.destroy();
    for (const g of this.seatGhosts) g.destroy();
    for (const b of this.removeBadges) b.destroy(true);
    this.tabsBar?.destroy(true);
    this.tabContent?.destroy(true);
    this.trayContainer?.destroy(true);
    this.scrollbarThumb?.destroy();
    this.scrollbarThumb = null;
    this.scrollMaskGfx?.destroy();
    this.scrollMaskGfx = null;
    this.scrollMask = null;
    this.slotGhosts = [];
    this.seatGhosts = [];
    this.removeBadges = [];
  }
}
