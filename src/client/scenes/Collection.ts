import * as Phaser from 'phaser';
import { Scene, GameObjects } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { AssetKeys } from '@/constants/assets';
import { equipCosmetic, fetchState } from '@/services/state-client';
import { hslToInt } from '@/util/color';
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

const CAT_TILE_W = 88;
const CAT_TILE_H = 110;
const COSMETIC_TILE_W = 80;
const COSMETIC_TILE_H = 96;
const COSMETIC_TILES_PER_PAGE = 8;

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

  private selectedCat: CatBreed | null = null;
  private cosmeticPage = 0;

  private coinsText!: GameObjects.Text;
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

    this.add
      .text(width / 2, 30, 'Collection', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '28px',
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 5,
      })
      .setOrigin(0.5, 0);

    this.coinsText = this.add
      .text(width - 16, 16, '🪙 0', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '22px',
        color: '#ffd34d',
        stroke: '#000000',
        strokeThickness: 4,
      })
      .setOrigin(1, 0);

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
    this.coinsText.setText(`🪙 ${coins}`);
  }

  // -- Cat strip ---------------------------------------------------------

  private drawCatStrip(): void {
    // Header — strip itself is built from state in rebuildCatStrip().
    this.add
      .text(36, 80, 'Your cats', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '16px',
        color: '#c0a0e6',
      })
      .setOrigin(0, 0);
  }

  private rebuildCatStrip(): void {
    for (const tile of this.catTiles.values()) tile.container.destroy(true);
    this.catTiles.clear();

    const cats = this.playerState?.ownedCats ?? [];
    if (cats.length === 0) return;

    const stripY = 130;
    const gap = 12;
    const totalW = cats.length * CAT_TILE_W + (cats.length - 1) * gap;
    const startX = this.scale.width / 2 - totalW / 2 + CAT_TILE_W / 2;

    cats.forEach((breed, idx) => {
      const x = startX + idx * (CAT_TILE_W + gap);
      const tile = this.makeCatTile(breed, x, stripY);
      this.catTiles.set(breed, tile);
    });
  }

  private makeCatTile(breed: CatBreed, x: number, y: number): Tile {
    const entry = CAT_CATALOG.find((c) => c.id === breed);
    const baseColor = RARITY_HEX[entry?.rarity ?? 'common'] ?? 0xffffff;

    const container = this.add.container(x, y);
    const border = this.add.rectangle(0, 0, CAT_TILE_W, CAT_TILE_H, 0x261540, 0.95);
    border.setStrokeStyle(2, baseColor);
    border.setInteractive({ useHandCursor: true });

    const frame = breed === 'rainbow' ? 'cat6_idle_00' : `${breed}_idle_00`;
    const sprite = this.add
      .image(0, -10, AssetKeys.Atlas.Cats, frame)
      .setOrigin(0.5);
    if (breed === 'rainbow') {
      // Static-ish rainbow tile — pick a saturated stand-in color so the
      // tile reads as "the rainbow cat" without burning CPU on a hue tween
      // in every thumbnail.
      sprite.setTint(hslToInt(280, 1, 0.65));
    }
    fitSpriteIntoTile(sprite, CAT_TILE_W - 16, CAT_TILE_H - 36);

    const nameText = this.add
      .text(0, CAT_TILE_H / 2 - 14, entry?.name ?? breed, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '11px',
        color: '#ffffff',
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
    const headerY = height - 200;

    this.add
      .text(36, headerY, 'Your cosmetics', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '16px',
        color: '#c0a0e6',
      })
      .setOrigin(0, 0);

    // Pagination arrows
    const arrowY = headerY + 60;
    const leftBg = this.add.rectangle(36, arrowY, 36, 36, 0x261540, 0.95);
    leftBg.setStrokeStyle(2, 0xffffff);
    leftBg.setInteractive({ useHandCursor: true });
    this.add.text(36, arrowY, '◀', {
      fontFamily: 'Pixeloid Sans, sans-serif',
      fontSize: '18px',
      color: '#ffffff',
    }).setOrigin(0.5);
    leftBg.on('pointerdown', () => this.changeCosmeticPage(-1));

    const rightBg = this.add.rectangle(width - 36, arrowY, 36, 36, 0x261540, 0.95);
    rightBg.setStrokeStyle(2, 0xffffff);
    rightBg.setInteractive({ useHandCursor: true });
    this.add.text(width - 36, arrowY, '▶', {
      fontFamily: 'Pixeloid Sans, sans-serif',
      fontSize: '18px',
      color: '#ffffff',
    }).setOrigin(0.5);
    rightBg.on('pointerdown', () => this.changeCosmeticPage(1));

    this.pageLabel = this.add
      .text(width / 2, height - 88, '', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '12px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);
  }

  private cosmeticEntries(): Array<{ kind: 'none' } | { kind: 'cosmetic'; id: CosmeticId }> {
    const owned = this.playerState?.ownedCosmetics ?? [];
    return [{ kind: 'none' as const }, ...owned.map((id) => ({ kind: 'cosmetic' as const, id }))];
  }

  private rebuildCosmeticStrip(): void {
    for (const tile of this.cosmeticTiles) tile.container.destroy(true);
    this.cosmeticTiles = [];

    const entries = this.cosmeticEntries();
    const totalPages = Math.max(1, Math.ceil(entries.length / COSMETIC_TILES_PER_PAGE));
    if (this.cosmeticPage >= totalPages) this.cosmeticPage = totalPages - 1;

    const start = this.cosmeticPage * COSMETIC_TILES_PER_PAGE;
    const visible = entries.slice(start, start + COSMETIC_TILES_PER_PAGE);

    const stripY = this.scale.height - 130;
    const gap = 12;
    const totalW =
      visible.length * COSMETIC_TILE_W + Math.max(0, visible.length - 1) * gap;
    const startX = this.scale.width / 2 - totalW / 2 + COSMETIC_TILE_W / 2;

    visible.forEach((entry, idx) => {
      const x = startX + idx * (COSMETIC_TILE_W + gap);
      const tile = entry.kind === 'none'
        ? this.makeNoneTile(x, stripY)
        : this.makeCosmeticTile(entry.id, x, stripY);
      this.cosmeticTiles.push(tile);
    });

    this.pageLabel.setText(`${this.cosmeticPage + 1} / ${totalPages}`);
  }

  private makeNoneTile(x: number, y: number): Tile {
    const baseColor = 0x888888;
    const container = this.add.container(x, y);
    const border = this.add.rectangle(0, 0, COSMETIC_TILE_W, COSMETIC_TILE_H, 0x261540, 0.95);
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
      void this.applyEquip(this.selectedCat, null);
    });

    // Highlight if the selected cat currently has nothing equipped.
    if (this.selectedCat && !this.playerState?.equippedCosmetics[this.selectedCat]) {
      border.setStrokeStyle(3, 0x00ff88);
    }

    return { container, border, baseColor };
  }

  private makeCosmeticTile(id: CosmeticId, x: number, y: number): Tile {
    const entry = COSMETIC_CATALOG.find((c) => c.id === id);
    const baseColor = RARITY_HEX[entry?.rarity ?? 'common'] ?? 0xffffff;

    const container = this.add.container(x, y);
    const border = this.add.rectangle(0, 0, COSMETIC_TILE_W, COSMETIC_TILE_H, 0x261540, 0.95);
    border.setStrokeStyle(2, baseColor);
    border.setInteractive({ useHandCursor: true });

    const sprite = this.add
      .image(0, -10, AssetKeys.Atlas.Cats, `cosmetic_${id}_idle_00`)
      .setOrigin(0.5);
    fitSpriteIntoTile(sprite, COSMETIC_TILE_W - 16, COSMETIC_TILE_H - 32);

    const nameText = this.add
      .text(0, COSMETIC_TILE_H / 2 - 14, entry?.name ?? id, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '10px',
        color: '#ffffff',
        align: 'center',
        wordWrap: { width: COSMETIC_TILE_W - 6 },
      })
      .setOrigin(0.5);

    container.add([border, sprite, nameText]);

    border.on('pointerdown', () => {
      if (this.busy || !this.selectedCat) return;
      void this.applyEquip(this.selectedCat, id);
    });

    // Highlight if currently equipped on the selected cat.
    if (this.selectedCat && this.playerState?.equippedCosmetics[this.selectedCat] === id) {
      border.setStrokeStyle(3, 0x00ff88);
    }

    return { container, border, baseColor };
  }

  private changeCosmeticPage(direction: 1 | -1): void {
    const entries = this.cosmeticEntries();
    const totalPages = Math.max(1, Math.ceil(entries.length / COSMETIC_TILES_PER_PAGE));
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

    const equippedId = this.playerState?.equippedCosmetics[breed] ?? null;
    if (equippedId) {
      const cos = this.add
        .image(0, -40, AssetKeys.Atlas.Cats, `cosmetic_${equippedId}_idle_00`)
        .setOrigin(0.5);
      const cosScale = Math.min(120 / Math.max(cos.width || 32, cos.height || 32), 4);
      cos.setScale(cosScale);
      this.previewLayer.add(cos);
    }

    const catName = catEntry?.name ?? breed;
    const cosName = equippedId
      ? COSMETIC_CATALOG.find((c) => c.id === equippedId)?.name ?? equippedId
      : 'nothing';
    this.equippedLabel.setText(`${catName} · wearing ${cosName}`);
  }

  // -- Equip -----------------------------------------------------------

  private async applyEquip(breed: CatBreed, cosmeticId: CosmeticId | null): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const result = await equipCosmetic(breed, cosmeticId);
      if (!result.ok) {
        console.warn('[collection] equip failed:', result.reason);
        return;
      }
      this.playerState = result.state;
      this.refreshFromState();
    } catch (e) {
      console.warn('[collection] equip error', e);
    } finally {
      this.busy = false;
    }
  }

  // -- Back button ------------------------------------------------------

  private drawBackButton(): void {
    const { width, height } = this.scale;
    const container = this.add.container(width / 2, height - 36);
    const bg = this.add.rectangle(0, 0, 160, 44, 0x1a0a2e, 0.95);
    bg.setStrokeStyle(2, 0xffffff);
    bg.setInteractive({ useHandCursor: true });
    const label = this.add
      .text(0, 0, '← Back', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '18px',
        color: '#ffffff',
      })
      .setOrigin(0.5);
    container.add([bg, label]);
    bg.on('pointerdown', () => {
      if (this.busy) return;
      this.scene.stop();
      this.scene.resume(SceneKeys.Game, { playerState: this.playerState });
    });
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
