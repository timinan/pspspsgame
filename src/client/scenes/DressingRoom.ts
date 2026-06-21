import { GameObjects, Scene, Scenes } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { CAT_CATALOG, COSMETIC_CATALOG } from '@/../shared/state';
import { AssetKeys } from '@/constants/assets';
import { equipCosmetic } from '@/services/state-client';
import { parentIdFor } from '@/entities/cat';
import type { PlayerState, CatBreed } from '@/../shared/state';

const COSMETICS_PER_PAGE = 19;

export class DressingRoom extends Scene {
  private catId!: CatBreed;
  private playerState!: PlayerState;
  private page = 0;
  private gridContainer!: GameObjects.Container;
  private heroSprite!: GameObjects.Image;
  private heroCosmetic: GameObjects.Sprite | null = null;
  private wearingLabel!: GameObjects.Text;
  private pageLabel!: GameObjects.Text;
  private prevBtn!: GameObjects.Container;
  private nextBtn!: GameObjects.Container;

  constructor() {
    super(SceneKeys.DressingRoom);
  }

  init(data: { catId: CatBreed; playerState: PlayerState }): void {
    this.catId = data.catId;
    this.playerState = data.playerState;
    this.page = 0;
  }

  create(): void {
    this.events.once(Scenes.Events.SHUTDOWN, () => this.cleanup());
    const { width, height } = this.scale;

    // Background
    this.add.rectangle(0, 0, width, height, 0x1a0a2e, 1).setOrigin(0, 0);

    // Top bar
    this.add.rectangle(0, 0, width, 44, 0x0b041a, 0.78).setOrigin(0, 0);
    const back = this.add
      .rectangle(40, 22, 64, 26, 0x0b041a, 1)
      .setStrokeStyle(1, 0xc0a0e6, 0.4)
      .setInteractive({ useHandCursor: true });
    this.add
      .text(40, 22, '← Back', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '11px',
        color: '#ffd34d',
      })
      .setOrigin(0.5);
    back.on('pointerdown', () => this.exit());

    const catEntry = CAT_CATALOG.find((c) => c.id === this.catId);
    const heroName = catEntry?.name ?? this.catId;
    this.add
      .text(width / 2, 22, `DRESSING ${heroName.toUpperCase()}`, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#ffd34d',
      })
      .setOrigin(0.5);

    // Hero shot — match Collection.ts frame pattern
    const heroFrame =
      this.catId === 'rainbow' ? 'cat6_idle_00' : `${this.catId}_idle_00`;
    const heroY = Math.max(120, height * 0.25);
    const heroScale = Math.min(2.5, width / 200);
    this.heroSprite = this.add
      .image(width / 2, heroY, AssetKeys.Atlas.Cats, heroFrame)
      .setScale(heroScale);
    this.renderEquippedCosmetic();

    // Wearing label
    this.wearingLabel = this.add
      .text(width / 2, this.heroSprite.y + 80, '', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '10px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);
    this.updateWearingLabel();

    // Grid container
    this.gridContainer = this.add.container(0, this.heroSprite.y + 110);
    this.renderGrid();

    // Pagination
    const paginationY = height - 32;
    this.pageLabel = this.add
      .text(width / 2, paginationY, '', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '10px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);
    this.prevBtn = this.makeArrow(40, paginationY, '◀', () => this.changePage(-1));
    this.nextBtn = this.makeArrow(width - 40, paginationY, '▶', () => this.changePage(1));
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

  private renderEquippedCosmetic(): void {
    this.heroCosmetic?.destroy();
    this.heroCosmetic = null;
    const cosId = this.playerState.equippedCosmetics[this.catId];
    if (!cosId) return;
    const cos = COSMETIC_CATALOG.find((c) => c.id === cosId);
    if (!cos) return;
    const renderId = parentIdFor(cos) ?? cos.id;
    const frame = `cosmetic_${renderId}_idle_00`;
    // Cosmetic atlas frames are drawn on the same canvas as the cat sprite.
    // Position, scale, and origin all mirror the hero — no Y offset needed.
    this.heroCosmetic = this.add
      .sprite(this.heroSprite.x, this.heroSprite.y, AssetKeys.Atlas.Cosmetics, frame)
      .setScale(this.heroSprite.scaleX, this.heroSprite.scaleY)
      .setOrigin(this.heroSprite.originX, this.heroSprite.originY);
    if (cos.tint) {
      const colorInt = parseInt(cos.tint.replace('#', ''), 16);
      this.heroCosmetic.setTint(colorInt);
    }
  }

  private updateWearingLabel(): void {
    const cosId = this.playerState.equippedCosmetics[this.catId];
    const cos = cosId ? COSMETIC_CATALOG.find((c) => c.id === cosId) : null;
    this.wearingLabel.setText(`currently wearing: ${cos?.name ?? 'nothing'}`);
  }

  private renderGrid(): void {
    this.gridContainer.removeAll(true);
    const owned = this.playerState.ownedCosmetics;
    const start = this.page * COSMETICS_PER_PAGE;
    const slice = owned.slice(start, start + COSMETICS_PER_PAGE);
    const cellSize = 48;
    const gap = 8;
    const cols = 5;
    const gridStartX = (this.scale.width - (cellSize * cols + gap * (cols - 1))) / 2;
    slice.forEach((cosId, i) => {
      const cos = COSMETIC_CATALOG.find((c) => c.id === cosId);
      if (!cos) return; // TEMP-DEMO: frame is always derivable from id, no sourceFrame guard needed
      // TEMP-DEMO: derive frame from parentIdFor (handles both base and tint-variant cosmetics)
      const renderId = parentIdFor(cos) ?? cos.id;
      const frame = `cosmetic_${renderId}_idle_00`;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = gridStartX + col * (cellSize + gap) + cellSize / 2;
      const y = row * (cellSize + gap) + cellSize / 2;
      const isEquipped = this.playerState.equippedCosmetics[this.catId] === cosId;
      const bg = this.add
        .rectangle(x, y, cellSize, cellSize, 0x0b041a, 0.6)
        .setStrokeStyle(2, isEquipped ? 0xffd34d : 0xc0a0e6, isEquipped ? 1 : 0.3)
        .setInteractive({ useHandCursor: true });
      const sprite = this.add
        .sprite(x, y, AssetKeys.Atlas.Cosmetics, frame)
        .setScale(0.7);
      if (cos.tint) {
        const colorInt = parseInt(cos.tint.replace('#', ''), 16);
        sprite.setTint(colorInt);
      }
      this.gridContainer.add([bg, sprite]);
      bg.on('pointerdown', () => this.equip(cosId));
    });
    // ✕ "none" tile at the end of the slice
    const noneIdx = slice.length;
    const col = noneIdx % cols;
    const row = Math.floor(noneIdx / cols);
    if (row < 4) {
      const x = gridStartX + col * (cellSize + gap) + cellSize / 2;
      const y = row * (cellSize + gap) + cellSize / 2;
      const isNone = !this.playerState.equippedCosmetics[this.catId];
      const bg = this.add
        .rectangle(x, y, cellSize, cellSize, 0xff5050, isNone ? 0.4 : 0.15)
        .setStrokeStyle(2, 0xff5050, isNone ? 1 : 0.5)
        .setInteractive({ useHandCursor: true });
      const text = this.add
        .text(x, y, '✕', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '18px',
          color: '#ffffff',
        })
        .setOrigin(0.5);
      this.gridContainer.add([bg, text]);
      bg.on('pointerdown', () => this.equip(null));
    }
  }

  private async equip(cosId: string | null): Promise<void> {
    // Optimistic: apply immediately so the tap feels instant
    const previousCos = this.playerState.equippedCosmetics[this.catId];
    if (cosId === null) {
      delete this.playerState.equippedCosmetics[this.catId];
    } else {
      this.playerState.equippedCosmetics[this.catId] = cosId;
    }
    this.renderEquippedCosmetic();
    this.updateWearingLabel();
    this.renderGrid();

    // Server sync in background
    try {
      const result = await equipCosmetic(this.catId, cosId);
      if (!result.ok) {
        // Revert optimistic change
        if (previousCos === undefined) {
          delete this.playerState.equippedCosmetics[this.catId];
        } else {
          this.playerState.equippedCosmetics[this.catId] = previousCos;
        }
        this.renderEquippedCosmetic();
        this.updateWearingLabel();
        this.renderGrid();
      } else {
        // Don't reassign — keep the shared reference so Decorate sees the update.
        // The optimistic mutation already wrote to playerState.equippedCosmetics.
        // Sync server-side fields back into our shared object to catch any drift.
        Object.assign(this.playerState, result.state);
      }
    } catch (e) {
      console.warn('[DressingRoom] equip failed:', e);
    }
  }

  private changePage(delta: number): void {
    const total = Math.max(
      1,
      Math.ceil(this.playerState.ownedCosmetics.length / COSMETICS_PER_PAGE),
    );
    this.page = Math.max(0, Math.min(total - 1, this.page + delta));
    this.renderGrid();
    this.updatePagination();
  }

  private updatePagination(): void {
    const total = Math.max(
      1,
      Math.ceil(this.playerState.ownedCosmetics.length / COSMETICS_PER_PAGE),
    );
    this.pageLabel.setText(`page ${this.page + 1} / ${total}`);
    this.prevBtn.setAlpha(this.page === 0 ? 0.35 : 1);
    this.nextBtn.setAlpha(this.page === total - 1 ? 0.35 : 1);
  }

  private exit(): void {
    // Phase 5: navigation = scene.start() only — never pause+resume.
    // Pass playerState back so Decorate re-reads latest equippedCosmetics.
    this.scene.start(SceneKeys.Decorate, { playerState: this.playerState });
  }

  private cleanup(): void {
    this.tweens.killAll();
    this.time.removeAllEvents();
    this.input.removeAllListeners();
    this.input.keyboard?.removeAllListeners();
    this.scale.off('resize');
    this.heroCosmetic?.destroy();
    this.gridContainer?.destroy(true);
  }
}
