import { Scene, GameObjects } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { AssetKeys } from '@/constants/assets';
import { playBoxOpenAnimation } from '@/ui/box-open-animation';
import { TopHud } from '@/ui/top-hud';
import { buildMenuItems } from '@/ui/menu-items';
import { openBox, fetchState, renameCat } from '@/services/state-client';
import { CatNamingModal } from '@/ui/cat-naming-modal';
import { CAT_EFFECT_BY_ID, isEffectCosmeticId } from '@/effects/cat-effects';
import {
  BOX_CATALOG,
  CAT_CATALOG,
  COSMETIC_CATALOG,
  BACKGROUND_CATALOG,
  type BoxId,
  type CatBreed,
  type CosmeticId,
  type BackgroundId,
  type PlayerState,
} from '@/../shared/state';

// Box gradient colors: [topColor, bottomColor]
const BOX_GRADIENTS: Record<BoxId, [number, number]> = {
  catBox:        [0xff9bbf, 0xc44e87],
  cosmeticBox:   [0xffd34d, 0xc8901f],
  backgroundBox: [0x6fbcff, 0x2c63a6],
};

/**
 * Purchase scene — three box cards stacked vertically, each roughly 1/3 of
 * the canvas height. Tap to open via the server; the existing box-open-animation
 * handles the reveal. Price chip goes red when the player can't afford the box.
 */
export class Purchase extends Scene {
  private playerState: PlayerState | null = null;
  private busy = false;

  private topHud!: TopHud;
  private uiRoot!: GameObjects.Container;

  constructor() {
    super(SceneKeys.Purchase);
  }

  init(data: { playerState?: PlayerState | null }): void {
    this.playerState = data?.playerState ?? null;
    this.busy = false;
  }

  async create(): Promise<void> {
    const { width, height } = this.scale;

    // Solid dark backdrop — no star field for the gated state; the empty
    // dark canvas reads as "blocked" instead of "decorated but empty".
    this.add.rectangle(0, 0, width, height, 0x0b041a, 1).setOrigin(0, 0);

    this.topHud = new TopHud(this, {
      showStats: true,
      currentKey: SceneKeys.Purchase,
      items: buildMenuItems(this, () => this.playerState),
    });

    // Pre-test gate: the box pulls + cosmetic economy aren't ready for
    // the playtest cohort. Hamburger still navigates so testers can get
    // out, but the scene's actual content is hidden until the launch
    // build re-enables it. Drop this branch when boxes ship.
    this.uiRoot = this.add.container(0, 0);
    this.drawComingSoon();
  }

  /** Draws the "coming soon" placeholder used while the box economy is
   *  parked. Centered title, supporting subtitle, faint lock glyph. */
  private drawComingSoon(): void {
    const { width, height } = this.scale;
    const cx = width / 2;
    const cy = height / 2;
    const fontBase = { fontFamily: 'Pixeloid Sans, sans-serif' };

    const lock = this.add
      .text(cx, cy - 70, '🔒', {
        ...fontBase,
        fontSize: '48px',
      })
      .setOrigin(0.5);
    this.uiRoot.add(lock);

    const title = this.add
      .text(cx, cy - 8, 'COMING SOON', {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '24px',
        color: '#ffd34d',
        stroke: '#000000',
        strokeThickness: 4,
      })
      .setOrigin(0.5);
    this.uiRoot.add(title);

    const sub = this.add
      .text(
        cx,
        cy + 28,
        'Merch tables open soon.\nTour shirts, plushies, and cosmetic drops are on the way.',
        {
          ...fontBase,
          fontSize: '11px',
          color: '#c0a0e6',
          align: 'center',
          wordWrap: { width: width - 48 },
        },
      )
      .setOrigin(0.5, 0);
    this.uiRoot.add(sub);
  }

  /**
   * Dev-only inventory panel. Shows what the player owns so we can verify box
   * pulls landed without inspecting Redis. Remove before shipping.
   */
  private drawInventoryDebugPanel(): void {
    const { width } = this.scale;
    const cats = this.playerState?.ownedCats?.length ?? 0;
    const cosmetics = this.playerState?.ownedCosmetics?.length ?? 0;
    const bgs = this.playerState?.ownedBackgrounds?.length ?? 0;
    const catNames = (this.playerState?.ownedCats ?? []).slice(-3).map((c) => c.name).join(', ') || '—';
    const cosNames = (this.playerState?.ownedCosmetics ?? []).slice(-3).map((c) => c.type).join(', ') || '—';
    const bgNames = (this.playerState?.ownedBackgrounds ?? []).join(', ') || '—';

    const x = width - 8;
    const y = TopHud.HEIGHT + 6;
    const text = [
      `INV  🐱 ${cats}  🎩 ${cosmetics}  🖼 ${bgs}`,
      `cats: ${catNames}`,
      `cos:  ${cosNames}`,
      `bgs:  ${bgNames}`,
    ].join('\n');

    const panel = this.add
      .text(x, y, text, {
        fontFamily: 'monospace',
        fontSize: '9px',
        color: '#9fffd4',
        backgroundColor: 'rgba(0,0,0,0.55)',
        padding: { x: 6, y: 4 },
        align: 'right',
      })
      .setOrigin(1, 0)
      .setDepth(500);

    this.uiRoot.add(panel);
  }

  private drawCards(): void {
    const { width, height } = this.scale;
    const hudH = TopHud.HEIGHT + 44; // HUD strip + title row
    const bottomPad = 12;
    const gap = 10;
    const usableH = height - hudH - bottomPad;
    const cardH = Math.floor((usableH - gap * 2) / 3);
    const cardW = Math.min(width - 32, 480);
    const cardX = width / 2;

    const boxIds: BoxId[] = ['catBox', 'cosmeticBox', 'backgroundBox'];
    boxIds.forEach((boxId, i) => {
      const cardY = hudH + i * (cardH + gap) + cardH / 2;
      this.drawCard(boxId, cardX, cardY, cardW, cardH);
    });
  }

  private drawCard(boxId: BoxId, cx: number, cy: number, w: number, h: number): void {
    const entry = BOX_CATALOG[boxId];
    const [topColor, bottomColor] = BOX_GRADIENTS[boxId];
    const container = this.add.container(cx, cy);
    this.uiRoot.add(container);

    // Card background
    const bg = this.add.rectangle(0, 0, w, h, 0x1e0f35, 0.97);
    bg.setStrokeStyle(2, topColor);
    bg.setInteractive({ useHandCursor: true });

    // Left art block: colored gradient rectangle with bow emoji
    const artW = Math.min(80, h - 16);
    const artX = -w / 2 + 12 + artW / 2;
    const artBlock = this.add.graphics();
    artBlock.fillGradientStyle(topColor, topColor, bottomColor, bottomColor, 1);
    artBlock.fillRoundedRect(artX - artW / 2, -artW / 2, artW, artW, 8);

    const bowFontSize = Math.max(20, Math.min(32, artW - 12));
    const bowEmoji = this.add
      .text(artX, 0, '🎀', {
        fontSize: `${bowFontSize}px`,
        align: 'center',
      })
      .setOrigin(0.5);

    // Right text area starts just past the art block
    const textX = artX + artW / 2 + 14;
    const rightW = w / 2 - 10 - (textX - cx + w / 2 - cx);

    const nameFontSize = w >= 360 ? 16 : 13;
    const accentCss = '#' + topColor.toString(16).padStart(6, '0');
    const nameText = this.add
      .text(textX, -h / 2 + 14, entry.displayName, {
        fontFamily: 'Pixeloid Sans, monospace',
        fontStyle: 'bold',
        fontSize: `${nameFontSize}px`,
        color: accentCss,
        wordWrap: { width: Math.max(rightW, 80) },
      })
      .setOrigin(0, 0);

    const descFontSize = w >= 360 ? 12 : 10;
    const descText = this.add
      .text(textX, nameText.y + nameFontSize + 6, entry.description, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: `${descFontSize}px`,
        color: '#a090c0',
        wordWrap: { width: Math.max(rightW, 80) },
      })
      .setOrigin(0, 0);

    // Price chip — bottom-right of card
    const chipText = this.add
      .text(w / 2 - 10, h / 2 - 12, `🪙 ${entry.price}`, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '15px',
        color: '#ffd34d',
        backgroundColor: '#1a0a2e',
        padding: { x: 6, y: 3 },
      })
      .setOrigin(1, 1);

    // Thin accent stripe down the center
    const stripe = this.add.graphics();
    stripe.fillStyle(topColor, 0.15);
    stripe.fillRect(-1, -h / 2 + 4, 2, h - 8);

    container.add([bg, artBlock, bowEmoji, nameText, descText, stripe, chipText]);

    // Tag this container so refreshAffordability can find it
    const tagged = container as TaggedContainer;
    tagged._boxId = boxId;
    tagged._bg = bg;
    tagged._chipText = chipText;
    tagged._topColor = topColor;

    bg.on('pointerdown', () => {
      if (this.busy) return;
      if (!this.canAfford(boxId)) {
        this.flashTooPoor(container);
        return;
      }
      this.tweens.add({ targets: container, scale: 0.97, duration: 70, yoyo: true });
      void this.onOpenBox(boxId);
    });
  }

  private canAfford(boxId: BoxId): boolean {
    return (this.playerState?.coins ?? 0) >= BOX_CATALOG[boxId].price;
  }

  private refreshCoins(): void {
    this.topHud?.setCoins(this.playerState?.coins ?? 0);
  }

  private refreshAffordability(): void {
    for (const child of this.uiRoot.list as TaggedContainer[]) {
      if (!child._boxId) continue;
      const boxId = child._boxId;
      const affordable = this.canAfford(boxId);
      child.setAlpha(affordable ? 1 : 0.45);
      child._bg?.setStrokeStyle(2, affordable ? (child._topColor ?? 0xffffff) : 0x444444);
      const entry = BOX_CATALOG[boxId];
      if (child._chipText) {
        if (affordable) {
          child._chipText.setText(`🪙 ${entry.price}`).setColor('#ffd34d');
        } else {
          const need = entry.price - (this.playerState?.coins ?? 0);
          child._chipText.setText(`🪙 ${entry.price} · need ${need}`).setColor('#cc4444');
        }
      }
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
        console.warn('[purchase] open failed:', result.reason);
        this.busy = false;
        return;
      }
      this.playerState = result.state;
      this.refreshCoins();
      this.refreshAffordability();

      const pull = result.pull;

      if (pull.kind === 'background') {
        const bgId = pull.itemId as BackgroundId;
        const bgEntry = BACKGROUND_CATALOG[bgId];
        playBoxOpenAnimation(
          this,
          {
            textureKey: bgEntry?.backdropKey ?? 'theme-stage-bg',
            frame: '',
            itemName: bgEntry?.displayName ?? bgId,
            rarity: pull.rarity,
            duplicate: pull.duplicate,
            refundCoins: pull.refundCoins,
          },
          () => { this.busy = false; },
        );
        return;
      }

      const isCat = pull.kind === 'cat';
      const isEffect = !isCat && isEffectCosmeticId(pull.itemId as string);
      const catEntry = isCat ? CAT_CATALOG.find((c) => c.id === (pull.itemId as CatBreed)) : undefined;
      const cosEntry = !isCat && !isEffect ? COSMETIC_CATALOG.find((c) => c.id === (pull.itemId as CosmeticId)) : undefined;
      const effectEntry = isEffect ? CAT_EFFECT_BY_ID[pull.itemId as string] : undefined;
      const itemName = catEntry?.name ?? effectEntry?.name ?? cosEntry?.name ?? pull.itemId;
      const { frame, rainbow, tint } = resolveFrame(pull.itemId, isCat);

      playBoxOpenAnimation(
        this,
        {
          textureKey: isCat ? AssetKeys.Atlas.Cats : AssetKeys.Atlas.Cosmetics,
          frame,
          itemName: isCat ? '' : itemName,
          ...(isCat ? { inlineRarityTemplate: { prefix: 'A ', suffix: ' cat has been adopted' } } : {}),
          rarity: pull.rarity,
          ...(rainbow ? { rainbow: true } : {}),
          ...(tint ? { tint: parseInt(tint.replace('#', ''), 16) } : {}),
          ...(isEffect ? { effectId: pull.itemId as string } : {}),
          duplicate: pull.duplicate,
          refundCoins: pull.refundCoins,
        },
        () => {
          if (isCat && pull.instanceId) {
            const defaultName = catEntry?.name ?? (pull.itemId as string);
            const instanceId = pull.instanceId;
            // Exclude the just-pulled instance from the duplicate check.
            const existingCats = (this.playerState?.ownedCats ?? []).filter(
              (c) => c.id !== instanceId,
            );
            const modal = new CatNamingModal(this, {
              defaultName,
              existingCats,
              onSubmit: (name) => {
                const catInState = this.playerState?.ownedCats.find((c) => c.id === instanceId);
                if (catInState) catInState.name = name;
                renameCat(instanceId, name).catch((e) =>
                  console.warn('[Purchase] renameCat failed:', e),
                );
                this.busy = false;
              },
            });
            void modal;
          } else {
            this.busy = false;
          }
        },
      );
    } catch (e) {
      console.warn('[purchase] open error', e);
      this.busy = false;
    }
  }

  shutdown(): void {
    this.tweens.killAll();
    this.topHud?.destroy();
    this.uiRoot?.destroy();
  }
}

// -- helpers ---------------------------------------------------------------

interface TaggedContainer extends GameObjects.Container {
  _boxId?: BoxId;
  _bg?: GameObjects.Rectangle;
  _chipText?: GameObjects.Text;
  _topColor?: number;
}

function resolveFrame(
  itemId: CatBreed | CosmeticId,
  isCat: boolean,
): { frame: string; rainbow?: boolean; tint?: string } {
  if (!isCat) {
    const entry = COSMETIC_CATALOG.find((c) => c.id === itemId);
    const renderId = entry?.sourceFrame?.match(/^cosmetic_(c\d+)_/)?.[1] ?? itemId;
    return {
      frame: `cosmetic_${renderId}_idle_00`,
      ...(entry?.tint ? { tint: entry.tint } : {}),
    };
  }
  if (itemId === 'rainbow') return { frame: 'cat6_idle_00', rainbow: true };
  return { frame: `${itemId}_idle_00` };
}
