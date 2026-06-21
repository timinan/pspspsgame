import { Scene, GameObjects } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { AssetKeys } from '@/constants/assets';
import { playBoxOpenAnimation } from '@/ui/box-open-animation';
import { TopHud } from '@/ui/top-hud';
import { openBox, fetchState } from '@/services/state-client';
import {
  BOX_CATALOG,
  CAT_CATALOG,
  COSMETIC_CATALOG,
  THEME_CATALOG,
  type BoxId,
  type CatBreed,
  type CosmeticId,
  type ThemeId,
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
  {
    boxId: 'themePack',
    title: 'Theme Pack',
    tagline: 'A new look and\nsoundtrack for your house.',
    accent: 0xff8c4d,
  },
];

interface BoxCard {
  layout: BoxCardLayout;
  container: GameObjects.Container;
  bg: GameObjects.Rectangle;
  costText: GameObjects.Text;
}

/**
 * Shop scene — six box cards in a 2x3 grid, each tappable to open via the
 * server. Insufficient-coin cards visibly dim and don't respond. Card taps
 * reuse playBoxOpenAnimation for the reveal, then refresh the coin display
 * from the returned PlayerState. Back button returns to Game.
 */
export class Boxes extends Scene {
  private playerState: PlayerState | null = null;
  private busy = false;

  private topHud!: TopHud;
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

    // Shared top strip (matches Game / Collection). Drawer offers the
    // sibling navigation + a "Back to Game" jump.
    this.topHud = new TopHud(this, {
      showStats: true,
      items: [
        {
          label: 'Edit Home',
          description: 'Decorate, seat, dress up',
          icon: '🏠',
          onTap: () => this.scene.start(SceneKeys.HouseEditor, { playerState: this.playerState }),
        },
        {
          label: 'Back to Game',
          description: 'Return to the rhythm scene',
          icon: '🎮',
          onTap: () => this.scene.start(SceneKeys.Game, { playerState: this.playerState }),
        },
      ],
    });

    // Scene title sits below the strip.
    const titleFontSize = width >= 520 ? 32 : width >= 380 ? 22 : 18;
    this.add
      .text(width / 2, TopHud.HEIGHT + 16, 'Mystery Boxes', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: `${titleFontSize}px`,
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 5,
        align: 'center',
        lineSpacing: 6,
        wordWrap: { width: width - 32 },
      })
      .setOrigin(0.5, 0);

    // Coins also live in the top strip (next to the 🪙 icon).
    // The strip doesn't display score in Boxes; coins are written via the
    // strip's setCoins() method whenever a purchase changes the balance.

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
    const { width } = this.scale;
    // Card width derived from canvas width so the 2x3 grid fits on
    // anything from a narrow mobile viewport up to a wide desktop frame.
    // Clamped between a readable minimum (smaller and the present icon
    // dominates) and the original max (any wider and the grid feels
    // sparse).
    const sideMargin = 16;
    const gapX = 20;
    const gapY = 14;
    const cardW = Math.max(140, Math.min(320, (width - sideMargin * 2 - gapX) / 2));
    const cardH = 120;
    const gridW = cardW * 2 + gapX;
    const originX = width / 2 - gridW / 2;
    const originY = 50;

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

    // Drop the title font size on narrow cards so "Premium Cat Crate"
    // doesn't bleed off the edges. Tagline wraps to the card interior.
    const titleFontSize = w < 220 ? 16 : 22;
    const title = this.add
      .text(0, -h / 2 + 22, layout.title, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: `${titleFontSize}px`,
        color: '#ffffff',
        align: 'center',
        wordWrap: { width: w - 16 },
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

    // Strip the manual newlines from the tagline so wordWrap can re-flow
    // it to whatever width the card ended up at.
    const taglineText = layout.tagline.replace(/\n/g, ' ');
    const tagline = this.add
      .text(0, 42, taglineText, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '13px',
        color: '#c0a0e6',
        align: 'center',
        wordWrap: { width: w - 16 },
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
      // Hard reset to Game so create() re-seats from the latest state
      // with equipped cosmetics applied. (Pause/resume hand-off wasn't
      // reliably re-applying cosmetics — revisit once that's understood.)
      this.scene.start(SceneKeys.Game, { playerState: this.playerState });
    });
  }

  private canAfford(boxId: BoxId): boolean {
    const coins = this.playerState?.coins ?? 0;
    return coins >= BOX_CATALOG[boxId].cost;
  }

  private refreshCoins(): void {
    const coins = this.playerState?.coins ?? 0;
    this.topHud?.setCoins(coins);
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

      if (pull.kind === 'theme') {
        const entry = THEME_CATALOG.find((t) => t.id === (pull.itemId as ThemeId));
        playBoxOpenAnimation(
          this,
          {
            textureKey: entry?.backdropKey ?? AssetKeys.Image.ThemeDefaultBg,
            frame: '',
            itemName: entry?.displayName ?? pull.itemId,
            rarity: pull.rarity,
            duplicate: pull.duplicate,
            refundCoins: pull.refundCoins,
          },
          () => { this.busy = false; },
        );
        return;
      }

      const isCat = pull.kind === 'cat';
      const entry = isCat
        ? CAT_CATALOG.find((c) => c.id === (pull.itemId as CatBreed))
        : COSMETIC_CATALOG.find((c) => c.id === (pull.itemId as CosmeticId));
      const itemName = entry?.name ?? pull.itemId;
      const { frame, rainbow, tint } = resolveFrame(pull.itemId, isCat);

      playBoxOpenAnimation(
        this,
        {
          textureKey: isCat ? AssetKeys.Atlas.Cats : AssetKeys.Atlas.Cosmetics,
          frame,
          itemName,
          rarity: pull.rarity,
          ...(rainbow ? { rainbow: true } : {}),
          ...(tint ? { tint: parseInt(tint.replace('#', ''), 16) } : {}),
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
): { frame: string; rainbow?: boolean; tint?: string } {
  if (!isCat) {
    const entry = COSMETIC_CATALOG.find((c) => c.id === itemId);
    const renderId =
      entry?.sourceFrame?.match(/^cosmetic_(c\d+)_/)?.[1] ?? itemId;
    return {
      frame: `cosmetic_${renderId}_idle_00`,
      ...(entry?.tint ? { tint: entry.tint } : {}),
    };
  }
  if (itemId === 'rainbow') return { frame: 'cat6_idle_00', rainbow: true };
  return { frame: `${itemId}_idle_00` };
}
