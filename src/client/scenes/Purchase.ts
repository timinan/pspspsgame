import { Scene, GameObjects } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { AssetKeys } from '@/constants/assets';
import { playBoxOpenAnimation } from '@/ui/box-open-animation';
import { TopHud } from '@/ui/top-hud';
import { buildMenuItems } from '@/ui/menu-items';
import { playLanternMusic } from '@/systems/home-music';
import { openBox, fetchState, renameCat } from '@/services/state-client';
import { CatNamingModal } from '@/ui/cat-naming-modal';
import { CAT_EFFECT_BY_ID, isEffectCosmeticId, getEffectById } from '@/effects/cat-effects';
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

// -- Shop taxonomy ---------------------------------------------------------

type ShopCategory = 'cosmetic' | 'effect' | 'cat' | 'background';
type ShopTier = 'standard' | 'golden' | 'mythic';

/** The four category cards, in display order, each with an accent color. */
const CATEGORY_DEFS: { key: ShopCategory; label: string; color: number }[] = [
  { key: 'cosmetic',   label: 'COSMETICS',   color: 0xffd34d },
  { key: 'effect',     label: 'EFFECTS',     color: 0xb066ff },
  { key: 'cat',        label: 'CATS',        color: 0xff9bbf },
  { key: 'background', label: 'BACKGROUNDS', color: 0x6fbcff },
];

const TIER_ORDER: ShopTier[] = ['standard', 'golden', 'mythic'];
const TIER_LABEL: Record<ShopTier, string> = {
  standard: 'Standard',
  golden: 'Golden',
  mythic: 'Mythic',
};
const TIER_CHIP_COLOR: Record<ShopTier, number> = {
  standard: 0x9aa4bf,
  golden: 0xffcf3f,
  mythic: 0xc06bff,
};

// Resolve (category, tier) -> BoxId once from the catalog so nothing here
// hardcodes a SKU id, price, or drop rate — the card reads them live.
const BOX_BY_CAT_TIER: Record<string, BoxId> = (() => {
  const map: Record<string, BoxId> = {};
  for (const id of Object.keys(BOX_CATALOG) as BoxId[]) {
    const cfg = BOX_CATALOG[id];
    map[`${cfg.category}:${cfg.tier}`] = id;
  }
  return map;
})();

const hex = (c: number): string => '#' + c.toString(16).padStart(6, '0');

/**
 * Purchase scene — the Merch shop. Four category cards (Cosmetics, Effects,
 * Cats, Backgrounds), each with a Standard/Golden/Mythic tier selector that
 * drives the price, drop odds, and the BOX_CATALOG SKU that BUY opens. Buying
 * reuses the existing `/api/box/open` flow + box-open reveal animation.
 */
export class Purchase extends Scene {
  private playerState: PlayerState | null = null;
  private busy = false;

  private topHud!: TopHud;
  private uiRoot!: GameObjects.Container;

  /** Selected tier per category card; defaults to the cheapest (standard). */
  private selectedTier: Record<ShopCategory, ShopTier> = {
    cosmetic: 'standard',
    effect: 'standard',
    cat: 'standard',
    background: 'standard',
  };

  constructor() {
    super(SceneKeys.Purchase);
  }

  init(data: { playerState?: PlayerState | null }): void {
    this.playerState = data?.playerState ?? null;
    this.busy = false;
  }

  async create(): Promise<void> {
    playLanternMusic(this);
    const { width, height } = this.scale;

    this.add.rectangle(0, 0, width, height, 0x0b041a, 1).setOrigin(0, 0);

    this.topHud = new TopHud(this, {
      showStats: true,
      currentKey: SceneKeys.Purchase,
      items: buildMenuItems(this, () => this.playerState),
    });

    this.uiRoot = this.add.container(0, 0);
    this.drawShop();
    this.refreshCoins();
  }

  /** Rebuild the title, legend, and all four cards into uiRoot. Called on
   *  first draw and whenever a tier chip flips or coins change. */
  private drawShop(): void {
    const { width, height } = this.scale;
    const fontBase = { fontFamily: 'Pixeloid Sans, sans-serif' };
    const cx = width / 2;

    const titleY = TopHud.HEIGHT + 6;
    const title = this.add
      .text(cx, titleY, 'MERCH SHOP', {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '16px',
        color: '#ffd34d',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5, 0);
    this.uiRoot.add(title);

    const legend = this.add
      .text(cx, titleY + 20, 'Odds: Common / Uncommon / Rare / Legendary', {
        ...fontBase,
        fontSize: '9px',
        color: '#8f80b0',
      })
      .setOrigin(0.5, 0);
    this.uiRoot.add(legend);

    const topPad = TopHud.HEIGHT + 40;
    const bottomPad = 10;
    const gap = 8;
    const cardW = Math.min(width - 20, 300);
    const usableH = height - topPad - bottomPad;
    const cardH = Math.floor((usableH - gap * (CATEGORY_DEFS.length - 1)) / CATEGORY_DEFS.length);

    CATEGORY_DEFS.forEach((def, i) => {
      const cardY = topPad + i * (cardH + gap) + cardH / 2;
      this.drawCategoryCard(def, cx, cardY, cardW, cardH);
    });
  }

  private drawCategoryCard(
    def: { key: ShopCategory; label: string; color: number },
    cx: number,
    cy: number,
    w: number,
    h: number,
  ): void {
    const fontBase = { fontFamily: 'Pixeloid Sans, sans-serif' };
    const tier = this.selectedTier[def.key];
    const boxId = BOX_BY_CAT_TIER[`${def.key}:${tier}`]!;
    const cfg = BOX_CATALOG[boxId];
    const accentCss = hex(def.color);
    const affordable = this.canAfford(boxId);

    const container = this.add.container(cx, cy);
    this.uiRoot.add(container);

    const padX = 10;
    const leftX = -w / 2 + padX;
    const rightX = w / 2 - padX;

    // Card background — always a visible stroke (cell-border rule).
    const bg = this.add.rectangle(0, 0, w, h, 0x1a0e30, 0.98);
    bg.setStrokeStyle(2, def.color);
    container.add(bg);

    // Header row: category name (left) + live price (right).
    const label = this.add
      .text(leftX, -h / 2 + 8, def.label, {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '14px',
        color: accentCss,
      })
      .setOrigin(0, 0);
    const price = this.add
      .text(rightX, -h / 2 + 8, `🪙 ${cfg.price}`, {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '14px',
        color: affordable ? '#ffd34d' : '#cc4444',
      })
      .setOrigin(1, 0);
    container.add([label, price]);

    // Tier selector — three chips, each with a visible stroke; the
    // selected chip is filled with its tier color + dark text.
    const chipH = 22;
    const chipGap = 6;
    const chipY = -h / 2 + 32;
    const chipW = (w - padX * 2 - chipGap * (TIER_ORDER.length - 1)) / TIER_ORDER.length;
    TIER_ORDER.forEach((t, ti) => {
      const chipCx = leftX + chipW / 2 + ti * (chipW + chipGap);
      const selected = t === tier;
      const tc = TIER_CHIP_COLOR[t];
      const chipBg = this.add.rectangle(chipCx, chipY, chipW, chipH, selected ? tc : 0x120826, 1);
      chipBg.setStrokeStyle(selected ? 2 : 1, selected ? 0xffffff : tc, selected ? 1 : 0.6);
      chipBg.setInteractive({ useHandCursor: true });
      chipBg.on('pointerdown', () => {
        if (this.busy) return;
        if (this.selectedTier[def.key] === t) return;
        this.selectedTier[def.key] = t;
        this.redrawCards();
      });
      const chipTxt = this.add
        .text(chipCx, chipY, TIER_LABEL[t], {
          ...fontBase,
          fontStyle: 'bold',
          fontSize: '11px',
          color: selected ? '#1a0a2e' : hex(tc),
        })
        .setOrigin(0.5);
      container.add([chipBg, chipTxt]);
    });

    // Odds line — read straight off the catalog's rates.
    const r = cfg.rates;
    const oddsStr = `${r.common} / ${r.uncommon} / ${r.rare} / ${r.legendary}`;
    const odds = this.add
      .text(leftX, chipY + chipH / 2 + 8, `Drop odds   ${oddsStr}`, {
        ...fontBase,
        fontSize: '11px',
        color: '#b0a0d0',
      })
      .setOrigin(0, 0);
    container.add(odds);

    // BUY button — full-width at the card bottom. Disabled + greyed with a
    // coin-shortfall label when the player can't afford the selected tier.
    const buyH = 26;
    const buyW = w - padX * 2;
    const buyCy = h / 2 - 8 - buyH / 2;
    const buyBg = this.add.rectangle(0, buyCy, buyW, buyH, affordable ? def.color : 0x2a2140, 1);
    buyBg.setStrokeStyle(2, affordable ? 0xffffff : 0x4a4060, affordable ? 1 : 0.8);
    const need = cfg.price - (this.playerState?.coins ?? 0);
    const buyTxt = this.add
      .text(0, buyCy, affordable ? `BUY   🪙 ${cfg.price}` : `NEED ${need} MORE`, {
        ...fontBase,
        fontStyle: 'bold',
        fontSize: '12px',
        color: affordable ? '#1a0a2e' : '#9a8fb5',
      })
      .setOrigin(0.5);
    if (affordable) {
      buyBg.setInteractive({ useHandCursor: true });
      buyBg.on('pointerdown', () => {
        if (this.busy) return;
        this.tweens.add({ targets: container, scale: 0.98, duration: 70, yoyo: true });
        void this.onOpenBox(boxId);
      });
    }
    container.add([buyBg, buyTxt]);
  }

  private canAfford(boxId: BoxId): boolean {
    return (this.playerState?.coins ?? 0) >= BOX_CATALOG[boxId].price;
  }

  private refreshCoins(): void {
    this.topHud?.setCoins(this.playerState?.coins ?? 0);
  }

  /** Tear down and rebuild the shop grid — used on tier flips and after a
   *  purchase so prices/odds/affordability all re-read the current state. */
  private redrawCards(): void {
    this.uiRoot.removeAll(true);
    this.drawShop();
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
      this.redrawCards();

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
      const effectEntry = isEffect ? getEffectById(pull.itemId as string) : undefined;
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
