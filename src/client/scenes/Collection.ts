import * as Phaser from 'phaser';
import { Scene, GameObjects } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { AssetKeys } from '@/constants/assets';
import { equipCosmetic, fetchState } from '@/services/state-client';
import { hslToInt } from '@/util/color';
import { TopHud } from '@/ui/top-hud';
import {
  CAT_CATALOG,
  COSMETIC_CATALOG,
  type CatBreed,
  type CosmeticId,
  type PlayerState,
} from '@/../shared/state';

const RARITY_HEX: Record<string, number> = {
  common: 0xffffff,
  uncommon: 0x6fbcff,
  rare: 0xc678ff,
  legendary: 0xffd34d,
};

// Tile sizes are upper bounds — the actual dimensions used per render
// shrink to fit the canvas width (see computeCatStripLayout /
// computeCosmeticStripLayout).
const CAT_TILE_MAX_W = 88;
const CAT_TILE_H = 110;
const COSMETIC_TILE_MAX_W = 80;
const COSMETIC_TILE_H = 96;
const TILE_GAP = 12;
const SIDE_MARGIN = 16;
const ARROW_W = 36;
const ARROW_GAP = 12;

interface Tile {
  container: GameObjects.Container;
  border: GameObjects.Rectangle;
  baseColor: number;
}

/**
 * Wardrobe screen. Top strip: owned cats. Bottom strip: owned cosmetics
 * (paginated with arrows). Middle: live preview of the selected cat
 * wearing its currently-equipped cosmetic.
 *
 * Tap a cat → it becomes the active dress-up target.
 * Tap a cosmetic → posts to /api/cosmetic/equip, then re-renders.
 * Tap the "None" tile (first cosmetic slot) → unequips.
 */
export class Collection extends Scene {
  private playerState: PlayerState | null = null;
  private busy = false;
  /** Cosmetic the user has *previewed* for the selected cat but not yet
   *  saved to the server. `undefined` = no pending change. `null` = pending
   *  unequip. */
  private pendingCosmetic: CosmeticId | null | undefined = undefined;
  private saveButton: GameObjects.Container | null = null;

  private selectedCat: CatBreed | null = null;
  private cosmeticPage = 0;

  private topHud!: TopHud;
  private previewLayer!: GameObjects.Container;
  private equippedLabel!: GameObjects.Text;
  private catTiles = new Map<CatBreed, Tile>();
  private cosmeticTiles: Tile[] = [];
  private pageLabel!: GameObjects.Text;
  private previewRainbowTween: Phaser.Tweens.Tween | null = null;

  constructor() {
    super(SceneKeys.Collection);
  }

  init(data: { playerState?: PlayerState | null }): void {
    this.playerState = data?.playerState ?? null;
    this.busy = false;
    this.selectedCat = null;
    this.cosmeticPage = 0;
    this.catTiles = new Map();
    this.cosmeticTiles = [];
  }

  async create(): Promise<void> {
    const { width, height } = this.scale;

    this.add.rectangle(0, 0, width, height, 0x1a0a2e, 1).setOrigin(0, 0);

    // Shared top strip — coins live here, drawer offers sibling nav.
    this.topHud = new TopHud(this, {
      showStats: true,
      items: [
        {
          label: 'Back to Game',
          description: 'Return to the rhythm scene',
          icon: '🎮',
          onTap: () => this.scene.start(SceneKeys.Game, { playerState: this.playerState }),
        },
        {
          label: 'Boxes',
          description: 'Open mystery crates',
          icon: '📦',
          onTap: () => this.scene.start(SceneKeys.Boxes, { playerState: this.playerState }),
        },
      ],
    });

    // Scene title sits just below the strip.
    const titleFontSize = width >= 480 ? 28 : width >= 360 ? 22 : 18;
    this.add
      .text(width / 2, TopHud.HEIGHT + 8, 'Collection', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: `${titleFontSize}px`,
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 5,
        lineSpacing: 6,
      })
      .setOrigin(0.5, 0);

    this.previewLayer = this.add.container(width / 2, height * 0.42);

    this.equippedLabel = this.add
      .text(width / 2, height * 0.42 + 80, '', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '14px',
        color: '#e0d3ff',
        align: 'center',
      })
      .setOrigin(0.5, 0);

    this.drawBackButton();
    this.drawCatStrip();
    this.drawCosmeticStrip();

    this.refreshFromState();

    if (!this.playerState) {
      try {
        this.playerState = await fetchState();
        this.refreshFromState();
      } catch (e) {
        console.warn('[collection] fetchState failed', e);
      }
    }
  }

  private refreshFromState(): void {
    this.refreshCoins();
    this.rebuildCatStrip();
    this.rebuildCosmeticStrip();
    if (!this.selectedCat && this.playerState?.ownedCats.length) {
      this.selectedCat = this.playerState.ownedCats[0] ?? null;
    }
    this.refreshSelectionVisuals();
    this.refreshPreview();
  }

  private refreshCoins(): void {
    const coins = this.playerState?.coins ?? 0;
    this.topHud?.setCoins(coins);
  }

  // -- Cat strip ---------------------------------------------------------

  private drawCatStrip(): void {
    // Header sits above the title-clearing band (title ends ~y=64), and
    // above the cat tiles that center at CAT_STRIP_Y. Strip itself is
    // built from state in rebuildCatStrip().
    this.add
      .text(SIDE_MARGIN, 72, 'Your cats', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '14px',
        color: '#c0a0e6',
      })
      .setOrigin(0, 0);
  }

  private rebuildCatStrip(): void {
    for (const tile of this.catTiles.values()) tile.container.destroy(true);
    this.catTiles.clear();

    const cats = this.playerState?.ownedCats ?? [];
    if (cats.length === 0) return;

    const stripY = 150;
    // Available row width: canvas minus margins. Each tile shares the row
    // with TILE_GAP between neighbors. Shrink tile width to fit all cats
    // in one row when they wouldn't otherwise; cap at CAT_TILE_MAX_W on
    // wider viewports so each tile reads.
    const available = this.scale.width - SIDE_MARGIN * 2;
    const tileW = Math.min(
      CAT_TILE_MAX_W,
      (available - (cats.length - 1) * TILE_GAP) / cats.length,
    );
    const totalW = cats.length * tileW + (cats.length - 1) * TILE_GAP;
    const startX = this.scale.width / 2 - totalW / 2 + tileW / 2;

    cats.forEach((breed, idx) => {
      const x = startX + idx * (tileW + TILE_GAP);
      const tile = this.makeCatTile(breed, x, stripY, tileW);
      this.catTiles.set(breed, tile);
    });
  }

  private makeCatTile(breed: CatBreed, x: number, y: number, tileW: number): Tile {
    const entry = CAT_CATALOG.find((c) => c.id === breed);
    const baseColor = RARITY_HEX[entry?.rarity ?? 'common'] ?? 0xffffff;

    const container = this.add.container(x, y);
    const border = this.add.rectangle(0, 0, tileW, CAT_TILE_H, 0x261540, 0.95);
    border.setStrokeStyle(2, baseColor);
    border.setInteractive({ useHandCursor: true });

    const frame = breed === 'rainbow' ? 'cat6_idle_00' : `${breed}_idle_00`;
    const sprite = this.add
      .image(0, -10, AssetKeys.Atlas.Cats, frame)
      .setOrigin(0.5);
    if (breed === 'rainbow') {
      // Static stand-in tint so the tile reads as "the rainbow cat"
      // without paying for a hue tween in every off-focus thumbnail.
      sprite.setTint(hslToInt(280, 1, 0.65));
    }
    fitSpriteIntoTile(sprite, tileW - 16, CAT_TILE_H - 36);

    const nameText = this.add
      .text(0, CAT_TILE_H / 2 - 14, entry?.name ?? breed, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '11px',
        color: '#ffffff',
        align: 'center',
        wordWrap: { width: tileW - 4 },
      })
      .setOrigin(0.5);

    container.add([border, sprite, nameText]);

    border.on('pointerdown', () => {
      if (this.busy) return;
      this.selectedCat = breed;
      this.refreshSelectionVisuals();
      this.refreshPreview();
      // Re-render cosmetic strip so the "currently equipped" badge updates.
      this.rebuildCosmeticStrip();
    });

    return { container, border, baseColor };
  }

  // -- Cosmetic strip ----------------------------------------------------

  private drawCosmeticStrip(): void {
    const { width, height } = this.scale;
    // Bottom-of-screen stack (bottom → top):
    //   back button at h-36
    //   page label   at h-80  (between strip + back)
    //   strip tiles  centered at h-150  (96 tall → top h-198, bottom h-102)
    //   "Your cosmetics" header at h-220
    const headerY = height - 220;

    this.add
      .text(SIDE_MARGIN, headerY, 'Your cosmetics', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '14px',
        color: '#c0a0e6',
      })
      .setOrigin(0, 0);

    // Pagination arrows sit at the edges, vertically centered on the row.
    const arrowY = height - 150;
    const leftX = SIDE_MARGIN + ARROW_W / 2;
    const rightX = width - SIDE_MARGIN - ARROW_W / 2;
    const leftBg = this.add.rectangle(leftX, arrowY, ARROW_W, ARROW_W, 0x261540, 0.95);
    leftBg.setStrokeStyle(2, 0xffffff);
    leftBg.setInteractive({ useHandCursor: true });
    this.add.text(leftX, arrowY, '◀', {
      fontFamily: 'Pixeloid Sans, sans-serif',
      fontSize: '18px',
      color: '#ffffff',
    }).setOrigin(0.5);
    leftBg.on('pointerdown', () => this.changeCosmeticPage(-1));

    const rightBg = this.add.rectangle(rightX, arrowY, ARROW_W, ARROW_W, 0x261540, 0.95);
    rightBg.setStrokeStyle(2, 0xffffff);
    rightBg.setInteractive({ useHandCursor: true });
    this.add.text(rightX, arrowY, '▶', {
      fontFamily: 'Pixeloid Sans, sans-serif',
      fontSize: '18px',
      color: '#ffffff',
    }).setOrigin(0.5);
    rightBg.on('pointerdown', () => this.changeCosmeticPage(1));

    this.pageLabel = this.add
      .text(width / 2, height - 80, '', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '12px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);
  }

  private cosmeticTilesPerPage(): number {
    // The row is bookended by arrows + their gaps. Whatever is left has to
    // fit some number of tiles with TILE_GAP between them. Clamp at 4 so
    // the page rotation doesn't feel like flipping single tiles, and at 8
    // so a wide desktop frame doesn't strand the user with one giant page.
    const available =
      this.scale.width
      - SIDE_MARGIN * 2
      - ARROW_W * 2
      - ARROW_GAP * 2;
    const tilePlusGap = COSMETIC_TILE_MAX_W + TILE_GAP;
    return Math.max(4, Math.min(8, Math.floor((available + TILE_GAP) / tilePlusGap)));
  }

  private cosmeticEntries(): Array<{ kind: 'none' } | { kind: 'cosmetic'; id: CosmeticId }> {
    const owned = this.playerState?.ownedCosmetics ?? [];
    return [{ kind: 'none' as const }, ...owned.map((id) => ({ kind: 'cosmetic' as const, id }))];
  }

  private rebuildCosmeticStrip(): void {
    for (const tile of this.cosmeticTiles) tile.container.destroy(true);
    this.cosmeticTiles = [];

    const entries = this.cosmeticEntries();
    const perPage = this.cosmeticTilesPerPage();
    const totalPages = Math.max(1, Math.ceil(entries.length / perPage));
    if (this.cosmeticPage >= totalPages) this.cosmeticPage = totalPages - 1;

    const start = this.cosmeticPage * perPage;
    const visible = entries.slice(start, start + perPage);

    // Lane the tiles between the two pagination arrows.
    const innerLeft = SIDE_MARGIN + ARROW_W + ARROW_GAP;
    const innerRight = this.scale.width - SIDE_MARGIN - ARROW_W - ARROW_GAP;
    const innerW = innerRight - innerLeft;
    const tileW = Math.min(
      COSMETIC_TILE_MAX_W,
      visible.length > 0
        ? (innerW - (visible.length - 1) * TILE_GAP) / visible.length
        : COSMETIC_TILE_MAX_W,
    );

    const stripY = this.scale.height - 150;
    const totalW =
      visible.length * tileW + Math.max(0, visible.length - 1) * TILE_GAP;
    const startX = (innerLeft + innerRight) / 2 - totalW / 2 + tileW / 2;

    visible.forEach((entry, idx) => {
      const x = startX + idx * (tileW + TILE_GAP);
      const tile = entry.kind === 'none'
        ? this.makeNoneTile(x, stripY, tileW)
        : this.makeCosmeticTile(entry.id, x, stripY, tileW);
      this.cosmeticTiles.push(tile);
    });

    this.pageLabel.setText(`${this.cosmeticPage + 1} / ${totalPages}`);
  }

  private makeNoneTile(x: number, y: number, tileW: number): Tile {
    const baseColor = 0x888888;
    const container = this.add.container(x, y);
    const border = this.add.rectangle(0, 0, tileW, COSMETIC_TILE_H, 0x261540, 0.95);
    border.setStrokeStyle(2, baseColor);
    border.setInteractive({ useHandCursor: true });
    const x1 = this.add.text(0, -10, '✕', {
      fontFamily: 'Pixeloid Sans, sans-serif',
      fontStyle: 'bold',
      fontSize: '28px',
      color: '#888888',
    }).setOrigin(0.5);
    const label = this.add.text(0, COSMETIC_TILE_H / 2 - 14, 'None', {
      fontFamily: 'Pixeloid Sans, sans-serif',
      fontSize: '11px',
      color: '#ffffff',
    }).setOrigin(0.5);
    container.add([border, x1, label]);

    border.on('pointerdown', () => {
      if (this.busy || !this.selectedCat) return;
      this.previewEquip(null);
    });

    // Highlight if the selected cat currently has nothing equipped
    // (taking any pending preview into account).
    if (this.selectedCat && this.effectiveEquipped(this.selectedCat) === null) {
      border.setStrokeStyle(3, 0x00ff88);
    }

    return { container, border, baseColor };
  }

  private makeCosmeticTile(id: CosmeticId, x: number, y: number, tileW: number): Tile {
    const entry = COSMETIC_CATALOG.find((c) => c.id === id);
    const baseColor = RARITY_HEX[entry?.rarity ?? 'common'] ?? 0xffffff;

    const container = this.add.container(x, y);
    const border = this.add.rectangle(0, 0, tileW, COSMETIC_TILE_H, 0x261540, 0.95);
    border.setStrokeStyle(2, baseColor);
    border.setInteractive({ useHandCursor: true });

    const sprite = this.add
      .image(0, -10, AssetKeys.Atlas.Cosmetics, `cosmetic_${id}_idle_00`)
      .setOrigin(0.5);
    fitSpriteIntoTile(sprite, tileW - 16, COSMETIC_TILE_H - 32);

    const nameText = this.add
      .text(0, COSMETIC_TILE_H / 2 - 14, entry?.name ?? id, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '10px',
        color: '#ffffff',
        align: 'center',
        wordWrap: { width: tileW - 6 },
      })
      .setOrigin(0.5);

    container.add([border, sprite, nameText]);

    border.on('pointerdown', () => {
      if (this.busy || !this.selectedCat) return;
      this.previewEquip(id);
    });

    // Highlight if currently equipped on the selected cat (or pending).
    if (this.selectedCat && this.effectiveEquipped(this.selectedCat) === id) {
      border.setStrokeStyle(3, 0x00ff88);
    }

    return { container, border, baseColor };
  }

  private changeCosmeticPage(direction: 1 | -1): void {
    const entries = this.cosmeticEntries();
    const totalPages = Math.max(1, Math.ceil(entries.length / this.cosmeticTilesPerPage()));
    this.cosmeticPage = (this.cosmeticPage + direction + totalPages) % totalPages;
    this.rebuildCosmeticStrip();
  }

  // -- Preview + selection ---------------------------------------------

  private refreshSelectionVisuals(): void {
    for (const [breed, tile] of this.catTiles) {
      tile.border.setStrokeStyle(
        breed === this.selectedCat ? 3 : 2,
        breed === this.selectedCat ? 0x00ff88 : tile.baseColor,
      );
    }
  }

  private refreshPreview(): void {
    this.previewRainbowTween?.stop();
    this.previewRainbowTween?.remove();
    this.previewRainbowTween = null;
    this.previewLayer.removeAll(true);
    if (!this.selectedCat) {
      this.equippedLabel.setText('');
      return;
    }

    const breed = this.selectedCat;
    const catEntry = CAT_CATALOG.find((c) => c.id === breed);
    const catFrame = breed === 'rainbow' ? 'cat6_idle_00' : `${breed}_idle_00`;
    const catSprite = this.add
      .image(0, 0, AssetKeys.Atlas.Cats, catFrame)
      .setOrigin(0.5);
    const scale = Math.min(220 / Math.max(catSprite.width || 64, catSprite.height || 64), 4);
    catSprite.setScale(scale);
    this.previewLayer.add(catSprite);

    if (breed === 'rainbow') {
      const hueState = { hue: 0 };
      this.previewRainbowTween = this.tweens.add({
        targets: hueState,
        hue: 360,
        duration: 3000,
        repeat: -1,
        ease: 'Linear',
        onUpdate: () => catSprite.setTint(hslToInt(hueState.hue, 1, 0.65)),
      });
    }

    // Use effective equipped (pending preview if set, else server state)
    // so the preview reflects what Save would commit.
    const equippedId = this.effectiveEquipped(breed);
    if (equippedId) {
      // Generated variants share a parent's atlas frame; resolve via the
      // catalog so tinted cosmetics render correctly here too. Both cat
      // and cosmetic sprites were extracted on the same 91×64 canvas, so
      // sharing position (0,0), origin (0.5,0.5), and the same scale puts
      // them in lock-step — Phaser's trimmed-atlas handling takes care of
      // the cosmetic's actual painted position within that canvas.
      const entry = COSMETIC_CATALOG.find((c) => c.id === equippedId);
      const renderId =
        entry?.sourceFrame?.match(/^cosmetic_(c\d+)_/)?.[1] ?? equippedId;
      const cos = this.add
        .image(0, 0, AssetKeys.Atlas.Cosmetics, `cosmetic_${renderId}_idle_00`)
        .setOrigin(0.5);
      if (entry?.tint) {
        cos.setTint(parseInt(entry.tint.replace('#', ''), 16));
      }
      cos.setScale(scale);
      this.previewLayer.add(cos);
    }

    const catName = catEntry?.name ?? breed;
    const cosName = equippedId
      ? COSMETIC_CATALOG.find((c) => c.id === equippedId)?.name ?? equippedId
      : 'nothing';
    this.equippedLabel.setText(`${catName} · wearing ${cosName}`);
  }

  // -- Equip -----------------------------------------------------------

  /** Whatever the cosmetic for `breed` is right now — pending preview if
   *  there's an unsaved change for the currently selected cat, otherwise
   *  the server-confirmed state. Returns null for "no cosmetic". */
  private effectiveEquipped(breed: CatBreed): CosmeticId | null {
    if (breed === this.selectedCat && this.pendingCosmetic !== undefined) {
      return this.pendingCosmetic;
    }
    return this.playerState?.equippedCosmetics[breed] ?? null;
  }

  /** Stage an equip for the selected cat without hitting the server. */
  private previewEquip(cosmeticId: CosmeticId | null): void {
    if (!this.selectedCat) return;
    const currentSaved = this.playerState?.equippedCosmetics[this.selectedCat] ?? null;
    this.pendingCosmetic = cosmeticId === currentSaved ? undefined : cosmeticId;
    this.refreshPreview();
    this.rebuildCosmeticStrip();
    this.refreshSaveButton();
  }

  private async onSavePressed(): Promise<void> {
    if (this.busy || !this.selectedCat || this.pendingCosmetic === undefined) return;
    this.busy = true;
    try {
      const result = await equipCosmetic(this.selectedCat, this.pendingCosmetic);
      if (!result.ok) {
        console.warn('[collection] equip failed:', result.reason);
        return;
      }
      this.playerState = result.state;
      this.pendingCosmetic = undefined;
      this.refreshFromState();
      this.flashSavedToast();
    } catch (e) {
      console.warn('[collection] equip error', e);
    } finally {
      this.busy = false;
      this.refreshSaveButton();
    }
  }

  private flashSavedToast(): void {
    const { width } = this.scale;
    const toast = this.add
      .text(width / 2, 70, '✓ Saved', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '16px',
        color: '#7fdc8a',
        backgroundColor: '#1a0a2e',
        padding: { x: 12, y: 6 },
      })
      .setOrigin(0.5)
      .setDepth(2000);
    this.tweens.add({
      targets: toast,
      alpha: 0,
      y: 50,
      duration: 1200,
      delay: 600,
      onComplete: () => toast.destroy(),
    });
  }

  // -- Save / Back buttons --------------------------------------------

  private drawBackButton(): void {
    const { width, height } = this.scale;

    // Save button — visible only when there's a pending change.
    const saveContainer = this.add.container(width / 2 - 90, height - 36);
    const saveBg = this.add.rectangle(0, 0, 160, 44, 0xffd34d, 1);
    saveBg.setStrokeStyle(2, 0x1a0a2e);
    saveBg.setInteractive({ useHandCursor: true });
    const saveLabel = this.add
      .text(0, 0, '💾 Save', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '18px',
        color: '#1a0a2e',
      })
      .setOrigin(0.5);
    saveContainer.add([saveBg, saveLabel]);
    saveContainer.setVisible(false);
    saveBg.on('pointerdown', () => void this.onSavePressed());
    this.saveButton = saveContainer;

    // Back button sits alongside Save; when nothing's pending it just
    // centers itself.
    const backContainer = this.add.container(width / 2 + 90, height - 36);
    const backBg = this.add.rectangle(0, 0, 160, 44, 0x1a0a2e, 0.95);
    backBg.setStrokeStyle(2, 0xffffff);
    backBg.setInteractive({ useHandCursor: true });
    const backLabel = this.add
      .text(0, 0, '← Back', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '18px',
        color: '#ffffff',
      })
      .setOrigin(0.5);
    backContainer.add([backBg, backLabel]);
    backBg.on('pointerdown', () => {
      if (this.busy) return;
      // If there's unsaved work, ask before discarding it.
      if (this.pendingCosmetic !== undefined) {
        // Save-or-discard isn't quite a confirm() use-case in Phaser, so
        // we just auto-save before exiting — least surprising behaviour.
        void this.onSavePressed().then(() => {
          this.scene.start(SceneKeys.Game, { playerState: this.playerState });
        });
        return;
      }
      this.scene.start(SceneKeys.Game, { playerState: this.playerState });
    });
  }

  private refreshSaveButton(): void {
    if (!this.saveButton) return;
    const hasPending = this.pendingCosmetic !== undefined;
    this.saveButton.setVisible(hasPending);
  }
}

function fitSpriteIntoTile(
  sprite: GameObjects.Image,
  maxW: number,
  maxH: number,
): void {
  const w = sprite.width || maxW;
  const h = sprite.height || maxH;
  const scale = Math.min(maxW / w, maxH / h, 3);
  sprite.setScale(scale);
}
