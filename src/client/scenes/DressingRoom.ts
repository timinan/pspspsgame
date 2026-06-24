import { GameObjects, Scene, Scenes } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { CAT_CATALOG, COSMETIC_CATALOG } from '@/../shared/state';
import { AssetKeys } from '@/constants/assets';
import { equipCosmetic } from '@/services/state-client';
import { parentIdFor } from '@/entities/cat';
import { CAT_EFFECT_BY_ID, type EffectHandle } from '@/effects/cat-effects';
import type { PlayerState, OwnedCosmetic } from '@/../shared/state';

// 3 cols × 3 rows = 9 visible cells; last slot is the ✕ "clear slot"
// tile, so up to 8 cosmetics fit per page. Cells are a middle ground
// between the original 48 px grid and the briefly-tried 104 px grid —
// big enough to read the asset + name clearly, small enough to keep
// the page count low and let the modal envelope grow only modestly.
const COSMETICS_PER_PAGE = 8;
const SLOT_TABS: { key: string; label: string }[] = [
  { key: 'head', label: 'HEAD' },
  { key: 'face', label: 'FACE' },
  { key: 'neck', label: 'NECK' },
  { key: 'effect', label: 'EFFECT' },
];

export class DressingRoom extends Scene {
  /** The cat INSTANCE id (not breed). */
  private catInstanceId!: string;
  private playerState!: PlayerState;
  private page = 0;
  /** Which slot the player is currently browsing in the cosmetics tray. */
  private activeSlot: string = 'head';
  private gridContainer!: GameObjects.Container;
  private heroSprite!: GameObjects.Image;
  /** One layered sprite per equipped slot — keyed by slot name. */
  private heroCosmetics: Record<string, GameObjects.Sprite> = {};
  /** Active EFFECT handles on the hero preview, keyed by slot ('effect'). */
  private heroEffects: Record<string, EffectHandle> = {};
  private wearingLabel!: GameObjects.Text;
  private pageLabel!: GameObjects.Text;
  private prevBtn!: GameObjects.Container;
  private nextBtn!: GameObjects.Container;
  private slotTabsContainer!: GameObjects.Container;

  constructor() {
    super(SceneKeys.DressingRoom);
  }

  init(data: { catInstanceId: string; playerState: PlayerState }): void {
    this.catInstanceId = data.catInstanceId;
    this.playerState = data.playerState;
    this.page = 0;
    this.activeSlot = 'head';
    this.heroCosmetics = {};
    this.heroEffects = {};
  }

  create(): void {
    this.events.once(Scenes.Events.SHUTDOWN, () => this.cleanup());
    const { width, height } = this.scale;

    const modalW = Math.min(width * 0.86, 420);
    // Modal sizes to its actual content — constants below mirror the
    // positions used downstream (hero / tabs / grid / pagination). Any
    // change to those numbers needs to be reflected here too.
    const HERO_OFFSET_Y = 110;
    const GRID_OFFSET_FROM_HERO = 130;
    // 3 rows × 76 + 2 × 8 = 244. Slightly taller than the original
    // 4×48 grid (216) — the modal grows by ~30 px to accommodate the
    // bigger, more readable cells without going off-screen.
    const GRID_CONTENT_H = 3 * 76 + 2 * 8;
    const PAGINATION_GAP_FROM_GRID = 24;
    const BOTTOM_PADDING = 24;
    const contentH =
      HERO_OFFSET_Y + GRID_OFFSET_FROM_HERO + GRID_CONTENT_H +
      PAGINATION_GAP_FROM_GRID + BOTTOM_PADDING;
    // Cap at viewport - 36 so a tiny canvas never pushes the modal off
    // the edge; the cap also bounds the lower limit so contentH wins on
    // the normal 580-design canvas (the old height*0.78 left ~90 px of
    // dead space below the pagination strip).
    const modalH = Math.min(contentH, height - 36);
    const modalX = (width - modalW) / 2;
    const modalY = (height - modalH) / 2;
    const cx = width / 2;

    // Dim backdrop — eats taps so Decorate underneath doesn't react.
    const scrim = this.add
      .rectangle(0, 0, width, height, 0x000000, 0.55)
      .setOrigin(0, 0)
      .setInteractive();
    scrim.on('pointerdown', () => this.exit());

    // Modal panel
    const panelBg = this.add
      .rectangle(modalX, modalY, modalW, modalH, 0x1a0a2e, 1)
      .setOrigin(0, 0)
      .setStrokeStyle(2, 0xffd34d, 0.85)
      .setInteractive();
    panelBg.on(
      'pointerdown',
      (
        _p: Phaser.Input.Pointer,
        _x: number,
        _y: number,
        event: Phaser.Types.Input.EventData,
      ) => {
        event.stopPropagation();
      },
    );

    // Resolve cat instance + catalog entry.
    const catInstance = this.playerState.ownedCats.find((cat) => cat.id === this.catInstanceId);
    const catEntry = catInstance ? CAT_CATALOG.find((c) => c.id === catInstance.breed) : undefined;
    // Title uses the custom name set by the player.
    const heroName = catInstance?.name ?? catEntry?.name ?? this.catInstanceId;
    this.add
      .text(cx, modalY + 22, `DRESSING ${heroName.toUpperCase()}`, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#ffd34d',
      })
      .setOrigin(0.5);

    // ✕ close button
    const closeBg = this.add
      .circle(modalX + modalW - 18, modalY + 18, 12, 0xff5050, 1)
      .setStrokeStyle(2, 0x0b041a, 1)
      .setInteractive({ useHandCursor: true });
    closeBg.on(
      'pointerdown',
      (
        _p: Phaser.Input.Pointer,
        _x: number,
        _y: number,
        event: Phaser.Types.Input.EventData,
      ) => {
        event.stopPropagation();
        this.exit();
      },
    );
    this.add
      .text(modalX + modalW - 18, modalY + 18, '✕', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#ffffff',
      })
      .setOrigin(0.5);

    // Hero sprite — use the breed for the atlas frame.
    const breed = catInstance?.breed ?? this.catInstanceId;
    const heroFrame = breed === 'rainbow' ? 'cat6_idle_00' : `${breed}_idle_00`;
    const heroY = modalY + HERO_OFFSET_Y;
    // 1.4× matches the seated-stage scale (Game.seatCats uses CAT_SCALE
    // = 1.4) so the cat reads at the same size you remember from the
    // round you just played. Cat is then anchored vertically so it
    // never overlaps the DRESSING <NAME> title or the slot label below.
    const heroScale = 1.4;
    this.heroSprite = this.add
      .image(cx, heroY, AssetKeys.Atlas.Cats, heroFrame)
      .setScale(heroScale)
      // Bump the hero (and by extension its effect handles which use
      // depth relative to this) well above the modal panel + scrim, both
      // of which sit at depth 0. Without this, the flame aura's
      // `sprite.depth - 1 = -1` gets covered by the modal backdrop.
      .setDepth(200);
    this.renderEquippedCosmetics();

    // Wearing label
    this.wearingLabel = this.add
      .text(cx, this.heroSprite.y + 68, '', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '10px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);
    this.updateWearingLabel();

    // Slot tabs (HEAD / FACE / NECK)
    this.slotTabsContainer = this.add.container(0, this.heroSprite.y + 92);
    this.renderSlotTabs();

    // Grid container — filtered by activeSlot, showing AVAILABLE cosmetics only.
    const gridTop = this.heroSprite.y + 130;
    this.gridContainer = this.add.container(0, gridTop);
    this.renderGrid();

    // Pagination anchored below the grid (not the modal) so the strip
    // never overlaps the bottom row of cosmetics. Must match the actual
    // GRID_CONTENT_H above — 3 rows × 76 + 2 × 8 gap = 244 — plus
    // breathing room. (Previously this lagged behind the renderGrid
    // resize and clipped the bottom row of cells.)
    const gridContentH = 3 * 76 + 2 * 8;
    const paginationY = Math.min(gridTop + gridContentH + 22, modalY + modalH - 18);
    this.pageLabel = this.add
      .text(cx, paginationY, '', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '10px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);
    this.prevBtn = this.makeArrow(modalX + 28, paginationY, '◀', () => this.changePage(-1));
    this.nextBtn = this.makeArrow(modalX + modalW - 28, paginationY, '▶', () => this.changePage(1));
    this.updatePagination();
  }

  private makeArrow(
    x: number,
    y: number,
    label: string,
    onTap: () => void,
  ): GameObjects.Container {
    const c = this.add.container(x, y);
    const bg = this.add
      .rectangle(0, 0, 36, 28, 0x2c1856, 1)
      .setStrokeStyle(1, 0xc0a0e6, 0.5)
      .setInteractive({ useHandCursor: true });
    const text = this.add
      .text(0, 0, label, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '14px',
        color: '#ffd34d',
      })
      .setOrigin(0.5);
    c.add([bg, text]);
    bg.on('pointerdown', onTap);
    return c;
  }

  /** Re-render all hero cosmetic layers from equippedCosmetics. */
  private renderEquippedCosmetics(): void {
    for (const slot of Object.keys(this.heroCosmetics)) {
      this.heroCosmetics[slot]?.destroy();
    }
    this.heroCosmetics = {};
    for (const slot of Object.keys(this.heroEffects)) {
      this.heroEffects[slot]?.destroy();
    }
    this.heroEffects = {};

    const slots = this.playerState.equippedCosmetics[this.catInstanceId];
    if (!slots) return;

    const equippedTypes = this.playerState.equippedCosmeticTypes ?? {};
    let i = 1;
    for (const [slotKey, cosInstanceId] of Object.entries(slots)) {
      if (!cosInstanceId) continue;
      // Resolve the catalog type via the sidecar.
      const cosTypeId = equippedTypes[cosInstanceId] ?? cosInstanceId;
      // EFFECT cosmetics are code-driven — apply them to the hero preview
      // so the player can see what they're equipping without leaving the
      // modal. Tracked separately so they tear down on slot swap / close.
      const effect = CAT_EFFECT_BY_ID[cosTypeId];
      if (effect) {
        // Pass the hero's render scale so the effect's footprint
        // (flame width, particle size, spread, rise distance) matches
        // the up-to-2.2× hero. Without this the effect rendered at 1×
        // and looked smaller than the cat.
        this.heroEffects[slotKey] = effect.apply(this, this.heroSprite, this.heroSprite.scaleX);
        continue;
      }
      const cos = COSMETIC_CATALOG.find((c) => c.id === cosTypeId);
      if (!cos) continue;
      const renderId = parentIdFor(cos) ?? cos.id;
      const frame = `cosmetic_${renderId}_idle_00`;
      const sprite = this.add
        .sprite(this.heroSprite.x, this.heroSprite.y, AssetKeys.Atlas.Cosmetics, frame)
        .setScale(this.heroSprite.scaleX, this.heroSprite.scaleY)
        .setOrigin(this.heroSprite.originX, this.heroSprite.originY)
        .setDepth(this.heroSprite.depth + i++);
      if (cos.tint) {
        sprite.setTint(parseInt(cos.tint.replace('#', ''), 16));
      }
      this.heroCosmetics[slotKey] = sprite;
    }
  }

  private updateWearingLabel(): void {
    const slots = this.playerState.equippedCosmetics[this.catInstanceId] ?? {};
    const cosInstanceId = slots[this.activeSlot];
    const equippedTypes = this.playerState.equippedCosmeticTypes ?? {};
    const cosTypeId = cosInstanceId ? (equippedTypes[cosInstanceId] ?? cosInstanceId) : undefined;
    const cos = cosTypeId ? COSMETIC_CATALOG.find((c) => c.id === cosTypeId) : null;
    this.wearingLabel.setText(
      `${this.activeSlot.toUpperCase()}: ${cos?.name ?? 'empty'}`,
    );
  }

  /** Render the HEAD / FACE / NECK tab row. */
  private renderSlotTabs(): void {
    this.slotTabsContainer.removeAll(true);
    const { width } = this.scale;
    // Tabs must fit inside the modal panel. The modal is up to 86% of the
    // canvas (capped at 420px); leave a small inset so tabs don't kiss the
    // border. Width is divided evenly across the slot count so we don't have
    // to retune when slots are added/removed.
    const modalW = Math.min(width * 0.86, 420);
    const inset = 14;
    const gap = 5;
    const available = modalW - inset * 2;
    const tabW = Math.floor((available - gap * (SLOT_TABS.length - 1)) / SLOT_TABS.length);
    const tabH = 26;
    const totalW = SLOT_TABS.length * tabW + (SLOT_TABS.length - 1) * gap;
    const startX = (width - totalW) / 2;
    const equippedSlots = this.playerState.equippedCosmetics[this.catInstanceId] ?? {};
    SLOT_TABS.forEach((tab, i) => {
      const x = startX + i * (tabW + gap);
      const isActive = this.activeSlot === tab.key;
      const equipped = equippedSlots[tab.key];
      const bg = this.add
        .rectangle(x, 0, tabW, tabH, isActive ? 0x2c1856 : 0x0b041a, isActive ? 1 : 0.6)
        .setOrigin(0, 0)
        .setStrokeStyle(2, isActive ? 0xffd34d : 0xc0a0e6, isActive ? 1 : 0.35)
        .setInteractive({ useHandCursor: true });
      const text = this.add
        .text(x + tabW / 2, tabH / 2, equipped ? `${tab.label} •` : tab.label, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '11px',
          color: isActive ? '#ffd34d' : '#c0a0e6',
        })
        .setOrigin(0.5);
      this.slotTabsContainer.add([bg, text]);
      bg.on('pointerdown', () => {
        this.activeSlot = tab.key;
        this.page = 0;
        this.renderSlotTabs();
        this.renderGrid();
        this.updateWearingLabel();
        this.updatePagination();
      });
    });
  }

  private renderGrid(): void {
    this.gridContainer.removeAll(true);

    // The grid shows cosmetics currently IN ownedCosmetics (not equipped anywhere).
    // Equipped cosmetics are removed from ownedCosmetics, so they don't appear here.
    const ownedInSlot: OwnedCosmetic[] = this.playerState.ownedCosmetics.filter((cosItem) => {
      const cos = COSMETIC_CATALOG.find((c) => c.id === cosItem.type);
      const slot = cos?.slot ?? 'head';
      return slot === this.activeSlot;
    });

    // Currently-equipped cosmetic in this slot (instance id + type id).
    // We include it in the display list alongside non-equipped owned
    // cosmetics so the grid order stays stable: equipping/unequipping
    // doesn't shift other items around. The equipped one is highlighted
    // and tapping it toggles back to unequipped.
    const equippedSlots = this.playerState.equippedCosmetics[this.catInstanceId] ?? {};
    const equippedInstanceId = equippedSlots[this.activeSlot];
    let equippedItem: OwnedCosmetic | null = null;
    if (equippedInstanceId) {
      const type = this.playerState.equippedCosmeticTypes?.[equippedInstanceId];
      if (type) {
        const eqCos = COSMETIC_CATALOG.find((c) => c.id === type);
        if (eqCos?.slot === this.activeSlot) {
          equippedItem = { id: equippedInstanceId, type };
        }
      }
    }

    // Merge + sort by instance id so the order is deterministic and
    // doesn't shuffle between renders (equip / unequip preserved).
    const merged: OwnedCosmetic[] = equippedItem
      ? [equippedItem, ...ownedInSlot]
      : [...ownedInSlot];
    merged.sort((a, b) => a.id.localeCompare(b.id));

    const start = this.page * COSMETICS_PER_PAGE;
    const slice = merged.slice(start, start + COSMETICS_PER_PAGE);

    // Middle-ground sizing — 3×3 cells of 76 px each; 8 px gap. Bigger
    // than the original 5×4×48 but smaller than the briefly-tried
    // 2×2×104. The image takes the upper portion of the cell, the label
    // sits below in a 9 px font. Labels wrap to whatever the wordWrap
    // width allows (no maxLines — Tim wanted no trailing "..." dot).
    const cellSize = 76;
    const gap = 8;
    const cols = 3;
    const visibleRows = 3;
    const gridStartX = (this.scale.width - (cellSize * cols + gap * (cols - 1))) / 2;
    const imageYOffset = -14;
    const labelYOffset = 22;
    const labelFontSize = 9;
    const labelWrapWidth = cellSize - 10;

    slice.forEach((cosItem, i) => {
      const cos = COSMETIC_CATALOG.find((c) => c.id === cosItem.type);
      if (!cos) return;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = gridStartX + col * (cellSize + gap) + cellSize / 2;
      const y = row * (cellSize + gap) + cellSize / 2;
      const isEquipped = equippedInstanceId === cosItem.id;
      const bg = this.add
        .rectangle(x, y, cellSize, cellSize, 0x0b041a, 0.6)
        .setStrokeStyle(2, isEquipped ? 0xffd34d : 0xc0a0e6, isEquipped ? 1 : 0.3)
        .setInteractive({ useHandCursor: true });
      this.gridContainer.add(bg);

      // Effect cosmetics don't have atlas frames — render an emoji thumb.
      const effect = CAT_EFFECT_BY_ID[cosItem.type];
      if (effect) {
        const icon = this.add
          .text(x, y + imageYOffset, effect.iconEmoji, { fontSize: '32px' })
          .setOrigin(0.5);
        const label = this.add
          .text(x, y + labelYOffset, effect.name, {
            fontFamily: '"Courier New", monospace',
            fontStyle: 'bold',
            fontSize: `${labelFontSize}px`,
            color: '#ffffff',
            align: 'center',
            wordWrap: { width: labelWrapWidth },
          })
          .setOrigin(0.5);
        this.gridContainer.add([icon, label]);
      } else {
        const renderId = parentIdFor(cos) ?? cos.id;
        const frame = `cosmetic_${renderId}_idle_00`;
        const sprite = this.add
          .sprite(x, y + imageYOffset, AssetKeys.Atlas.Cosmetics, frame)
          .setScale(1.05);
        if (cos.tint) {
          sprite.setTint(parseInt(cos.tint.replace('#', ''), 16));
        }
        const label = this.add
          .text(x, y + labelYOffset, cos.name.toUpperCase(), {
            fontFamily: '"Courier New", monospace',
            fontStyle: 'bold',
            fontSize: `${labelFontSize}px`,
            color: '#ffffff',
            align: 'center',
            wordWrap: { width: labelWrapWidth },
          })
          .setOrigin(0.5);
        this.gridContainer.add([sprite, label]);
      }

      // Tap behavior:
      //  - Tapping an unequipped cosmetic → equip it
      //  - Tapping the currently-equipped cosmetic → unequip it (toggle)
      // This matches Tim's request for a "click again to unselect"
      // pattern that mirrors the song picker's select/deselect.
      bg.on('pointerdown', () => {
        if (isEquipped) this.equipInSlot(null);
        else this.equipInSlot(cosItem);
      });
    });

    // "Clear slot" tile — same neutral cell shell as the cosmetics
    // (dark fill, soft purple stroke) so the grid reads as one unified
    // surface. Active "currently none equipped" state lights up with
    // the yellow stroke just like a selected cosmetic. A subtle slashed
    // circle inside replaces the previous big-red ✕ block (Tim: 'X on
    // NONE looks clunky').
    const noneIdx = slice.length;
    const col = noneIdx % cols;
    const row = Math.floor(noneIdx / cols);
    if (row < visibleRows) {
      const x = gridStartX + col * (cellSize + gap) + cellSize / 2;
      const y = row * (cellSize + gap) + cellSize / 2;
      const isNone = !equippedInstanceId;
      const bg = this.add
        .rectangle(x, y, cellSize, cellSize, 0x0b041a, 0.6)
        .setStrokeStyle(2, isNone ? 0xffd34d : 0xc0a0e6, isNone ? 1 : 0.3)
        .setInteractive({ useHandCursor: true });
      const glyph = this.add
        .text(x, y + imageYOffset, '⊘', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '34px',
          color: isNone ? '#ffd34d' : '#c0a0e6',
        })
        .setOrigin(0.5);
      const label = this.add
        .text(x, y + labelYOffset, 'NONE', {
          fontFamily: '"Courier New", monospace',
          fontStyle: 'bold',
          fontSize: `${labelFontSize}px`,
          color: isNone ? '#ffd34d' : '#ffffff',
        })
        .setOrigin(0.5);
      this.gridContainer.add([bg, glyph, label]);
      bg.on('pointerdown', () => this.equipInSlot(null));
    }
  }

  /**
   * Equip / clear a cosmetic in the currently-active slot.
   * `cosItem` is an OwnedCosmetic instance, or null to clear.
   */
  private async equipInSlot(cosItem: OwnedCosmetic | null): Promise<void> {
    const slot = this.activeSlot;

    // Ensure structures exist.
    if (!this.playerState.equippedCosmetics[this.catInstanceId]) {
      this.playerState.equippedCosmetics[this.catInstanceId] = {};
    }
    if (!this.playerState.equippedCosmeticTypes) {
      this.playerState.equippedCosmeticTypes = {};
    }
    const slots = this.playerState.equippedCosmetics[this.catInstanceId]!;
    const equippedTypes = this.playerState.equippedCosmeticTypes;

    // Snapshot previous state for rollback.
    const previousInstanceId = slots[slot];
    const snapshotOwnedCosmetics = [...this.playerState.ownedCosmetics];
    const snapshotEquippedTypes = { ...equippedTypes };

    // Optimistic mutation — mirrors server logic.
    if (previousInstanceId) {
      // Restore previous cosmetic to inventory.
      const prevType = equippedTypes[previousInstanceId];
      if (prevType) {
        this.playerState.ownedCosmetics.push({ id: previousInstanceId, type: prevType });
        delete equippedTypes[previousInstanceId];
      }
    }

    if (cosItem === null) {
      delete slots[slot];
    } else {
      // Pop the new cosmetic from inventory.
      const idx = this.playerState.ownedCosmetics.findIndex((c) => c.id === cosItem.id);
      if (idx !== -1) this.playerState.ownedCosmetics.splice(idx, 1);
      equippedTypes[cosItem.id] = cosItem.type;
      slots[slot] = cosItem.id;
    }

    if (Object.keys(slots).length === 0) {
      delete this.playerState.equippedCosmetics[this.catInstanceId];
    }

    this.renderEquippedCosmetics();
    this.updateWearingLabel();
    this.renderSlotTabs();
    this.renderGrid();

    // Server sync.
    try {
      const result = await equipCosmetic(
        this.catInstanceId,
        slot,
        cosItem?.id ?? null,
      );
      if (!result.ok) {
        // Revert.
        this.playerState.ownedCosmetics = snapshotOwnedCosmetics;
        this.playerState.equippedCosmeticTypes = snapshotEquippedTypes;
        if (!this.playerState.equippedCosmetics[this.catInstanceId]) {
          this.playerState.equippedCosmetics[this.catInstanceId] = {};
        }
        const revertSlots = this.playerState.equippedCosmetics[this.catInstanceId]!;
        if (previousInstanceId === undefined) {
          delete revertSlots[slot];
        } else {
          revertSlots[slot] = previousInstanceId;
        }
        if (Object.keys(revertSlots).length === 0) {
          delete this.playerState.equippedCosmetics[this.catInstanceId];
        }
        this.renderEquippedCosmetics();
        this.updateWearingLabel();
        this.renderSlotTabs();
        this.renderGrid();
      } else {
        Object.assign(this.playerState, result.state);
      }
    } catch (e) {
      console.warn('[DressingRoom] equip failed:', e);
    }
  }

  private countOwnedInSlot(): number {
    let count = this.playerState.ownedCosmetics.filter((cosItem) => {
      const cos = COSMETIC_CATALOG.find((c) => c.id === cosItem.type);
      const slot = cos?.slot ?? 'head';
      return slot === this.activeSlot;
    }).length;
    // The equipped cosmetic for this slot lives outside ownedCosmetics
    // but is shown in the grid (stable order), so include it here so
    // pagination math matches what renderGrid actually displays.
    const equippedInstanceId = this.playerState.equippedCosmetics[this.catInstanceId]?.[this.activeSlot];
    if (equippedInstanceId) {
      const type = this.playerState.equippedCosmeticTypes?.[equippedInstanceId];
      if (type) {
        const eqCos = COSMETIC_CATALOG.find((c) => c.id === type);
        if (eqCos?.slot === this.activeSlot) count += 1;
      }
    }
    return count;
  }

  private changePage(delta: number): void {
    const total = Math.max(
      1,
      Math.ceil(this.countOwnedInSlot() / COSMETICS_PER_PAGE),
    );
    this.page = Math.max(0, Math.min(total - 1, this.page + delta));
    this.renderGrid();
    this.updatePagination();
  }

  private updatePagination(): void {
    const total = Math.max(
      1,
      Math.ceil(this.countOwnedInSlot() / COSMETICS_PER_PAGE),
    );
    this.pageLabel.setText(`page ${this.page + 1} / ${total}`);
    this.prevBtn.setAlpha(this.page === 0 ? 0.35 : 1);
    this.nextBtn.setAlpha(this.page === total - 1 ? 0.35 : 1);
  }

  private exit(): void {
    const decorate = this.scene.get(SceneKeys.Decorate);
    if (decorate) decorate.events.emit('dressingroom:closed');
    this.scene.stop();
  }

  private cleanup(): void {
    this.tweens.killAll();
    this.time.removeAllEvents();
    this.input.removeAllListeners();
    this.input.keyboard?.removeAllListeners();
    this.scale.off('resize');
    for (const slot of Object.keys(this.heroCosmetics)) {
      this.heroCosmetics[slot]?.destroy();
    }
    this.heroCosmetics = {};
    for (const slot of Object.keys(this.heroEffects)) {
      this.heroEffects[slot]?.destroy();
    }
    this.heroEffects = {};
    this.gridContainer?.destroy(true);
    this.slotTabsContainer?.destroy(true);
  }
}
