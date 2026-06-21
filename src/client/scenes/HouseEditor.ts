import { GameObjects, Scene, Scenes } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { TopHud } from '@/ui/top-hud';
import { RoomRenderer } from '@/entities/room-renderer';
import { SCENE_SLOTS, SCENE_SEATS } from '@/constants/scene-slots';
import { SlotGhost } from '@/entities/slot-ghost';
import { SeatGhost } from '@/entities/seat-ghost';
import { fetchState, setDecorationInSlot, setSeat, sellItem, rehomeCat, setTheme } from '@/services/state-client';
import { ContextMenu, buildDecorMenu, buildCatMenu } from '@/ui/context-menu';
import { ConfirmModal } from '@/ui/confirm-modal';
import { DECORATION_CATALOG, CAT_CATALOG, THEME_CATALOG } from '@/../shared/state';
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
    this.topHud = new TopHud(this, { items: [], showStats: true });
    this.topHud.setMode('edit', { onDone: () => this.exitToGame() });

    // Room (theme + decorations + seated cats)
    this.roomRenderer = new RoomRenderer(this);
    this.roomRenderer.renderFrom(this.playerState);

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
    this.trayContainer = this.add.container(0, this.scale.height - 180).setDepth(80);
    const trayBg = this.add
      .rectangle(0, 0, this.scale.width, 180, 0x2c1856, 0.95)
      .setOrigin(0, 0);
    trayBg.setStrokeStyle(2, 0xc0a0e6, 0.4);
    this.trayContainer.add(trayBg);

    this.contextMenu = new ContextMenu(this);
    this.confirmModal = new ConfirmModal(this);
    this.tabContent = this.add.container(0, this.scale.height - 130).setDepth(82);
    this.drawTabBar();
    this.renderActiveTab();

    // Scene-level pointerdown to dismiss menu on tap-outside.
    this.input.on('pointerdown', () => {
      if (this.contextMenu.isOpen()) this.contextMenu.close();
    });

    // Listen for ghost taps
    this.events.on('slot:tap', (slotId: string) => this.onSlotTap(slotId));
    this.events.on('seat:tap', (seatId: string) => this.onSeatTap(seatId));

    this.wireSeatedCatTaps();
    this.wireRemoveBadges();
  }

  private drawTabBar(): void {
    this.tabsBar?.destroy(true);
    const trayY = this.scale.height - 180;
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
    const owned = this.playerState.house.ownedDecorations;
    const placed = new Set(Object.values(this.playerState.house.decorations));
    const cellW = 48;
    const gap = 6;
    const startX = 12;
    const startY = 12;
    owned.forEach((decoId, i) => {
      const entry = DECORATION_CATALOG.find((d) => d.id === decoId);
      if (!entry) return;
      const col = i % 5;
      const row = Math.floor(i / 5);
      const x = startX + col * (cellW + gap) + cellW / 2;
      const y = startY + row * (cellW + gap) + cellW / 2;
      const isPlaced = placed.has(decoId);
      const bg = this.add
        .rectangle(x, y, cellW, cellW, isPlaced ? 0x1a0a2e : 0x0b041a, isPlaced ? 1 : 0.6)
        .setStrokeStyle(1, isPlaced ? 0xffd34d : 0xc0a0e6, isPlaced ? 1 : 0.3)
        .setInteractive({ useHandCursor: true });
      const sprite = this.add
        .sprite(x, y, AssetKeys.Atlas.Decorations, entry.frame)
        .setScale(0.5);
      this.tabContent.add([bg, sprite]);
      if (isPlaced) {
        const tick = this.add.circle(x + cellW / 2 - 4, y - cellW / 2 + 4, 7, 0xffd34d, 1);
        const tickText = this.add
          .text(x + cellW / 2 - 4, y - cellW / 2 + 4, '✓', { fontSize: '10px', fontStyle: 'bold', color: '#1a0a2e' })
          .setOrigin(0.5);
        this.tabContent.add([tick, tickText]);
      }
      bg.on('pointerdown', (_p: unknown, _x: unknown, _y: unknown, event: Phaser.Types.Input.EventData) => {
        event.stopPropagation();
        this.openDecorMenu(x, y - cellW / 2, decoId, entry.displayName, isPlaced);
      });
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
    const startX = 12;
    const startY = 12;
    owned.forEach((catId, i) => {
      const entry = CAT_CATALOG.find((c) => c.id === catId);
      if (!entry) return;
      const col = i % 5;
      const row = Math.floor(i / 5);
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
        this.openCatMenu(x, y - cellW / 2, catId, entry.name, isSeated);
      });
    });
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
    const startY = 12;
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
    this.events.once(Scenes.Events.RESUME, async () => {
      this.playerState = await fetchState();
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
    this.slotGhosts = [];
    this.seatGhosts = [];
    this.removeBadges = [];
  }
}
