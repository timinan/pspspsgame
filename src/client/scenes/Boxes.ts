import { Scene, GameObjects } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { AssetKeys } from '@/constants/assets';
import { playBoxOpenAnimation } from '@/ui/box-open-animation';
import { openBox, fetchState } from '@/services/state-client';
import {
  BOX_CATALOG,
  CAT_CATALOG,
  COSMETIC_CATALOG,
  type BoxId,
  type CatBreed,
  type CosmeticId,
  type PlayerState,
} from '@/../shared/state';

interface BoxCardLayout {
  boxId: BoxId;
  title: string;
  tagline: string;
  accent: number;
}

const BOX_CARDS: BoxCardLayout[] = [
  {
    boxId: 'catCrate',
    title: 'Cat Crate',
    tagline: 'Common cats mostly,\nrare ones sometimes.',
    accent: 0x6fbcff,
  },
  {
    boxId: 'premiumCatCrate',
    title: 'Premium Cat Crate',
    tagline: 'Rare cats — Rainbow\nWhiskers can drop here!',
    accent: 0xffd34d,
  },
  {
    boxId: 'stylePack',
    title: 'Style Pack',
    tagline: 'Common cosmetics mostly,\nrare ones sometimes.',
    accent: 0xc678ff,
  },
  {
    boxId: 'premiumStylePack',
    title: 'Premium Style Pack',
    tagline: 'Rare cosmetics — the\nCrown of Treats lives here.',
    accent: 0xffd34d,
  },
];

interface BoxCard {
  layout: BoxCardLayout;
  container: GameObjects.Container;
  bg: GameObjects.Rectangle;
  costText: GameObjects.Text;
}

/**
 * Shop scene — four box cards in a 2x2 grid, each tappable to open via the
 * server. Insufficient-coin cards visibly dim and don't respond. Card taps
 * reuse playBoxOpenAnimation for the reveal, then refresh the coin display
 * from the returned PlayerState. Back button returns to Game.
 */
export class Boxes extends Scene {
  private playerState: PlayerState | null = null;
  private busy = false;

  private coinsText!: GameObjects.Text;
  private cards: BoxCard[] = [];

  constructor() {
    super(SceneKeys.Boxes);
  }

  init(data: { playerState?: PlayerState | null }): void {
    this.playerState = data?.playerState ?? null;
    this.busy = false;
    this.cards = [];
  }

  async create(): Promise<void> {
    const { width, height } = this.scale;

    this.add.rectangle(0, 0, width, height, 0x1a0a2e, 1).setOrigin(0, 0);
    const stars = this.add.graphics();
    stars.fillStyle(0xffffff, 0.25);
    for (let i = 0; i < 60; i++) {
      stars.fillCircle(
        Math.random() * width,
        Math.random() * height,
        Math.random() * 1.4 + 0.4,
      );
    }

    this.add
      .text(width / 2, 36, 'Mystery Boxes', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '32px',
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 5,
      })
      .setOrigin(0.5, 0);

    this.coinsText = this.add
      .text(width - 16, 16, '🪙 0', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '24px',
        color: '#ffd34d',
        stroke: '#000000',
        strokeThickness: 4,
      })
      .setOrigin(1, 0);

    // Render grid + back button before the (possibly async) state refresh
    // so the player sees structure immediately and the buttons just enable
    // once we know how many coins they have.
    this.drawGrid();
    this.drawBackButton();
    this.refreshCoins();
    this.refreshAffordability();

    // If we were launched without state (or with a stale one), pull a
    // fresh snapshot. Non-fatal on failure — buttons just stay disabled.
    if (!this.playerState) {
      try {
        this.playerState = await fetchState();
        this.refreshCoins();
        this.refreshAffordability();
      } catch (e) {
        console.warn('[boxes] fetchState failed', e);
      }
    }
  }

  private drawGrid(): void {
    const { width, height } = this.scale;
    const cardW = 320;
    const cardH = 220;
    const gapX = 32;
    const gapY = 24;
    const gridW = cardW * 2 + gapX;
    const gridH = cardH * 2 + gapY;
    const originX = width / 2 - gridW / 2;
    const originY = height / 2 - gridH / 2 + 20;

    BOX_CARDS.forEach((layout, idx) => {
      const col = idx % 2;
      const row = Math.floor(idx / 2);
      const cx = originX + col * (cardW + gapX) + cardW / 2;
      const cy = originY + row * (cardH + gapY) + cardH / 2;
      this.cards.push(this.drawCard(layout, cx, cy, cardW, cardH));
    });
  }

  private drawCard(
    layout: BoxCardLayout,
    cx: number,
    cy: number,
    w: number,
    h: number,
  ): BoxCard {
    const container = this.add.container(cx, cy);

    const bg = this.add.rectangle(0, 0, w, h, 0x261540, 0.95);
    bg.setStrokeStyle(3, layout.accent);
    bg.setInteractive({ useHandCursor: true });

    const title = this.add
      .text(0, -h / 2 + 22, layout.title, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '22px',
        color: '#ffffff',
      })
      .setOrigin(0.5, 0);

    // Mini present icon in the middle so each card has something visual.
    const presentX = 0;
    const presentY = -8;
    const present = this.add.graphics();
    present.fillStyle(layout.accent, 1);
    present.fillRoundedRect(presentX - 32, presentY - 24, 64, 48, 6);
    present.fillStyle(0xffd34d, 1);
    present.fillRect(presentX - 32, presentY - 4, 64, 8);
    present.fillRect(presentX - 4, presentY - 24, 8, 48);
    present.lineStyle(2, 0xffffff, 0.85);
    present.strokeRoundedRect(presentX - 32, presentY - 24, 64, 48, 6);

    const tagline = this.add
      .text(0, 42, layout.tagline, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '13px',
        color: '#c0a0e6',
        align: 'center',
      })
      .setOrigin(0.5, 0);

    const cost = BOX_CATALOG[layout.boxId].cost;
    const costText = this.add
      .text(0, h / 2 - 28, `${cost}🪙`, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '20px',
        color: '#ffd34d',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5);

    container.add([bg, title, present, tagline, costText]);

    bg.on('pointerdown', () => {
      if (this.busy) return;
      if (!this.canAfford(layout.boxId)) {
        this.flashTooPoor(container);
        return;
      }
      this.tweens.add({
        targets: container,
        scale: 0.96,
        duration: 80,
        yoyo: true,
      });
      void this.onOpenBox(layout.boxId);
    });

    return { layout, container, bg, costText };
  }

  private drawBackButton(): void {
    const { width, height } = this.scale;
    const x = width / 2;
    const y = height - 36;

    const container = this.add.container(x, y);
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
      // We were launched on top of a paused Game. Stop ourselves and
      // resume the Game scene with the latest state so its HUD picks up
      // any new coins / cats / equipped cosmetics from this session.
      this.scene.stop();
      this.scene.resume(SceneKeys.Game, { playerState: this.playerState });
    });
  }

  private canAfford(boxId: BoxId): boolean {
    const coins = this.playerState?.coins ?? 0;
    return coins >= BOX_CATALOG[boxId].cost;
  }

  private refreshCoins(): void {
    const coins = this.playerState?.coins ?? 0;
    this.coinsText.setText(`🪙 ${coins}`);
  }

  private refreshAffordability(): void {
    for (const card of this.cards) {
      const affordable = this.canAfford(card.layout.boxId);
      card.container.setAlpha(affordable ? 1 : 0.45);
      card.bg.setStrokeStyle(
        3,
        affordable ? card.layout.accent : 0x555555,
      );
      card.costText.setColor(affordable ? '#ffd34d' : '#888888');
    }
  }

  private flashTooPoor(container: GameObjects.Container): void {
    this.tweens.add({
      targets: container,
      x: container.x - 6,
      duration: 50,
      yoyo: true,
      repeat: 3,
    });
  }

  private async onOpenBox(boxId: BoxId): Promise<void> {
    if (this.busy) return;
    this.busy = true;

    try {
      const result = await openBox(boxId);
      if (!result.ok) {
        console.warn('[boxes] open failed:', result.reason);
        this.busy = false;
        return;
      }
      this.playerState = result.state;
      this.refreshCoins();
      this.refreshAffordability();

      const pull = result.pull;
      const isCat = pull.kind === 'cat';
      const entry = isCat
        ? CAT_CATALOG.find((c) => c.id === (pull.itemId as CatBreed))
        : COSMETIC_CATALOG.find((c) => c.id === (pull.itemId as CosmeticId));
      const itemName = entry?.name ?? pull.itemId;
      const { frame, tint } = resolveFrame(pull.itemId, isCat);

      playBoxOpenAnimation(
        this,
        {
          textureKey: AssetKeys.Atlas.Cats,
          frame,
          itemName,
          rarity: pull.rarity,
          ...(tint !== undefined ? { tint } : {}),
          duplicate: pull.duplicate,
          refundCoins: pull.refundCoins,
        },
        () => {
          this.busy = false;
        },
      );
    } catch (e) {
      console.warn('[boxes] open error', e);
      this.busy = false;
    }
  }
}

function resolveFrame(
  itemId: CatBreed | CosmeticId,
  isCat: boolean,
): { frame: string; tint?: number } {
  if (!isCat) return { frame: `cosmetic_${itemId}_idle_00` };
  if (itemId === 'rainbow') return { frame: 'cat1_idle_00', tint: 0xffd34d };
  return { frame: `${itemId}_idle_00` };
}
