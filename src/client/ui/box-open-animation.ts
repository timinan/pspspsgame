import * as Phaser from 'phaser';
import { Scene, GameObjects } from 'phaser';
import { hslToInt } from '@/util/color';
import { CAT_EFFECT_BY_ID, type EffectHandle } from '@/effects/cat-effects';
import type { Rarity } from '@/../shared/state';

const PARTICLE_TEXTURE = 'box-open-particle';

const DIM_DEPTH = 9000;
const BOX_DEPTH = 9100;
const FLASH_DEPTH = 9200;
const GLOW_DEPTH = 9300;
const ITEM_DEPTH = 9400;
const TEXT_DEPTH = 9500;

const RARITY_STYLE: Record<Rarity, { hex: number; css: string; label: string }> = {
  common:    { hex: 0xffffff, css: '#ffffff', label: 'COMMON' },
  uncommon:  { hex: 0x6fbcff, css: '#6fbcff', label: 'UNCOMMON' },
  rare:      { hex: 0xc678ff, css: '#c678ff', label: 'RARE' },
  legendary: { hex: 0xffd34d, css: '#ffd34d', label: 'LEGENDARY' },
};

export interface BoxOpenAnimationOpts {
  /** Texture / atlas key the revealed item lives in. */
  textureKey: string;
  /** Atlas frame name (e.g. 'cat1_idle_00', 'cosmetic_c5_idle_00'). */
  frame: string;
  /** Display name shown below the item. */
  itemName: string;
  /** Drives the glow color and rarity badge. */
  rarity: Rarity;
  /** Optional flat tint applied to the revealed sprite (used as a stand-in
   *  for items we don't have dedicated assets for yet). Ignored when
   *  `rainbow` is set. */
  tint?: number;
  /** Hue-cycle the revealed sprite — used for Rainbow Whiskers so the
   *  reveal animation reads as "this is the legendary you've been chasing." */
  rainbow?: boolean;
  /** When true and refundCoins > 0, shows a "Duplicate · +N coins" hint. */
  duplicate?: boolean;
  refundCoins?: number;
  /**
   * When set, renders the headline as `${prefix}${RARITY_LABEL}${suffix}` with
   * the rarity label inlined and colored, AND suppresses the separate rarity
   * badge below. Use this for the cat-adoption reveal so we don't say
   * "uncommon" twice.
   */
  inlineRarityTemplate?: { prefix: string; suffix: string };
  /**
   * When set, renders the named effect (`effect-red-glow`, `effect-fire`, …)
   * instead of an atlas frame — there's no cat for the effect to live on at
   * reveal time, so we attach it to a transparent placeholder sprite the
   * same size as a seated cat. Used by Purchase when a cosmetic-box pull
   * returns an effect cosmetic.
   */
  effectId?: string;
}

/**
 * Plays a gacha box-open sequence on top of the given scene.
 *
 * Flow: dim backdrop → wrapped present wiggles → white flash + particle burst →
 * item sprite scales in with a rarity-colored glow → name + rarity label fade
 * in → tap (or 3000ms timeout) to dismiss. Every object created here is
 * destroyed before `onDone` fires, so callers don't need to clean up.
 */
export function playBoxOpenAnimation(
  scene: Scene,
  opts: BoxOpenAnimationOpts,
  onDone: () => void,
): void {
  const { width, height } = scene.scale;
  const cx = width / 2;
  const cy = height / 2;
  const rarity = RARITY_STYLE[opts.rarity];

  ensureParticleTexture(scene);

  const dim = scene.add
    .rectangle(0, 0, width, height, 0x000000, 0)
    .setOrigin(0, 0)
    .setDepth(DIM_DEPTH)
    .setInteractive();
  scene.tweens.add({ targets: dim, alpha: 0.78, duration: 200 });

  const box = drawPresent(scene).setDepth(BOX_DEPTH);
  box.setPosition(cx, cy).setScale(0.4);

  scene.tweens.add({
    targets: box,
    scale: 1.05,
    duration: 320,
    ease: 'Back.easeOut',
  });
  scene.tweens.add({
    targets: box,
    angle: { from: -8, to: 8 },
    yoyo: true,
    repeat: 5,
    duration: 80,
    onComplete: () => reveal(),
  });

  function reveal(): void {
    const flash = scene.add
      .rectangle(0, 0, width, height, 0xffffff, 0.95)
      .setOrigin(0, 0)
      .setDepth(FLASH_DEPTH);
    scene.tweens.add({
      targets: flash,
      alpha: 0,
      duration: 320,
      onComplete: () => flash.destroy(),
    });

    box.destroy();

    const emitter = scene.add
      .particles(cx, cy, PARTICLE_TEXTURE, {
        speed: { min: 220, max: 480 },
        angle: { min: 0, max: 360 },
        scale: { start: 1.6, end: 0 },
        alpha: { start: 1, end: 0 },
        lifespan: { min: 480, max: 900 },
        tint: rarity.hex,
        quantity: 36,
        emitting: false,
      })
      .setDepth(GLOW_DEPTH);
    emitter.explode(36);
    scene.time.delayedCall(1000, () => emitter.destroy());

    const glow = scene.add.graphics().setDepth(GLOW_DEPTH);
    glow.fillStyle(rarity.hex, 0.35);
    glow.fillCircle(cx, cy, 120);
    scene.tweens.add({
      targets: glow,
      alpha: { from: 0.7, to: 0.25 },
      yoyo: true,
      repeat: -1,
      duration: 700,
    });

    // Effect mode: render a code-driven CatEffect (glow / particles) instead
    // of an atlas sprite. We anchor it to a transparent placeholder Image
    // sized like a seated cat so the effect's footPosition / displayHeight
    // math reads sane values. Without this branch, resolveFrame would hand
    // us a non-existent atlas frame, item.width would be 0, targetScale
    // would explode to Infinity, and the reveal would hang behind the
    // depth-9000 dim — which is the "hamburger disappears" symptom.
    let item: GameObjects.Image | GameObjects.Sprite;
    let effectHandle: EffectHandle | null = null;
    if (opts.effectId && CAT_EFFECT_BY_ID[opts.effectId]) {
      const placeholder = scene.add
        .image(cx, cy + 60, opts.textureKey, opts.frame)
        .setOrigin(0.5, 1)
        .setAlpha(0) // invisible — only the effect itself reads
        .setDepth(ITEM_DEPTH);
      placeholder.setDisplaySize(110, 110);
      effectHandle = CAT_EFFECT_BY_ID[opts.effectId]!.apply(scene, placeholder, 1.8);
      item = placeholder;
    } else {
      item = scene.add
        .image(cx, cy, opts.textureKey, opts.frame)
        .setOrigin(0.5)
        .setScale(0)
        .setDepth(ITEM_DEPTH);
      if (opts.tint !== undefined && !opts.rainbow) item.setTint(opts.tint);
      const naturalMax = Math.max(item.width || 64, item.height || 64);
      const targetScale = Math.min(220 / naturalMax, 4);
      scene.tweens.add({
        targets: item,
        scale: targetScale,
        duration: 420,
        ease: 'Back.easeOut',
      });
    }

    let rainbowTween: Phaser.Tweens.Tween | null = null;
    if (opts.rainbow) {
      const hueState = { hue: 0 };
      rainbowTween = scene.tweens.add({
        targets: hueState,
        hue: 360,
        duration: 3000,
        repeat: -1,
        ease: 'Linear',
        onUpdate: () => {
          item.setTint(hslToInt(hueState.hue, 1, 0.65));
        },
      });
    }

    // Wrap inside the canvas so longer adoption sentences don't get clipped.
    // Shrink font on narrow viewports so it stays legible.
    const sceneW = scene.scale.width;
    let nameFontSize = sceneW >= 520 ? 28 : sceneW >= 380 ? 22 : 18;

    const nameTexts: GameObjects.Text[] = [];
    let rarityText: GameObjects.Text | null = null;

    if (opts.inlineRarityTemplate) {
      // Three-part sentence with the rarity label inline and colored. We
      // measure each piece, shrink the font if the whole line overflows,
      // and lay them out horizontally centered.
      const tpl = opts.inlineRarityTemplate;
      const baseStyle = {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        stroke: '#000000',
        strokeThickness: 5,
      };
      const makeRow = (size: number): { pre: GameObjects.Text; mid: GameObjects.Text; suf: GameObjects.Text; totalW: number } => {
        const pre = scene.add.text(0, 0, tpl.prefix, { ...baseStyle, fontSize: `${size}px`, color: '#ffffff' }).setOrigin(0, 0.5);
        const mid = scene.add.text(0, 0, rarity.label, { ...baseStyle, fontSize: `${size}px`, color: rarity.css }).setOrigin(0, 0.5);
        const suf = scene.add.text(0, 0, tpl.suffix, { ...baseStyle, fontSize: `${size}px`, color: '#ffffff' }).setOrigin(0, 0.5);
        return { pre, mid, suf, totalW: pre.width + mid.width + suf.width };
      };
      let row = makeRow(nameFontSize);
      const maxW = sceneW - 32;
      while (row.totalW > maxW && nameFontSize > 12) {
        row.pre.destroy(); row.mid.destroy(); row.suf.destroy();
        nameFontSize -= 2;
        row = makeRow(nameFontSize);
      }
      let xc = cx - row.totalW / 2;
      for (const t of [row.pre, row.mid, row.suf]) {
        t.setPosition(xc, cy + 150);
        xc += t.width;
        t.setAlpha(0).setDepth(TEXT_DEPTH);
        nameTexts.push(t);
      }
    } else {
      // Default single-line headline + separate rarity badge.
      const nameText = scene.add
        .text(cx, cy + 150, opts.itemName, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: `${nameFontSize}px`,
          color: '#ffffff',
          stroke: '#000000',
          strokeThickness: 5,
          align: 'center',
          wordWrap: { width: sceneW - 40 },
        })
        .setOrigin(0.5)
        .setAlpha(0)
        .setDepth(TEXT_DEPTH);
      nameTexts.push(nameText);

      rarityText = scene.add
        .text(cx, cy + 186, rarity.label, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '16px',
          color: rarity.css,
          stroke: '#000000',
          strokeThickness: 4,
        })
        .setOrigin(0.5)
        .setAlpha(0)
        .setDepth(TEXT_DEPTH);
    }

    let dupText: GameObjects.Text | null = null;
    if (opts.duplicate && opts.refundCoins && opts.refundCoins > 0) {
      dupText = scene.add
        .text(cx, cy + 216, `Duplicate · +${opts.refundCoins}🪙 refund`, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontSize: '14px',
          color: '#ffd34d',
          stroke: '#000000',
          strokeThickness: 3,
        })
        .setOrigin(0.5)
        .setAlpha(0)
        .setDepth(TEXT_DEPTH);
    }

    const labels: GameObjects.Text[] = [...nameTexts];
    if (rarityText) labels.push(rarityText);
    if (dupText) labels.push(dupText);
    scene.tweens.add({
      targets: labels,
      alpha: 1,
      duration: 280,
      delay: 180,
    });

    const hint = scene.add
      .text(cx, height - 50, 'Tap to continue', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '16px',
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setAlpha(0)
      .setDepth(TEXT_DEPTH);
    scene.tweens.add({
      targets: hint,
      alpha: 0.9,
      duration: 380,
      delay: 900,
      yoyo: true,
      repeat: -1,
    });

    let resolved = false;
    let canDismiss = false;
    scene.time.delayedCall(700, () => {
      canDismiss = true;
    });

    const finish = (): void => {
      if (resolved) return;
      resolved = true;

      scene.tweens.killTweensOf(glow);
      scene.tweens.killTweensOf(hint);
      scene.tweens.killTweensOf(labels);
      rainbowTween?.stop();
      rainbowTween?.remove();
      // Tear down the effect BEFORE its placeholder dies — the effect's
      // POST_UPDATE sync reads target.x/y, and a destroyed target would
      // throw and skip the rest of cleanup.
      effectHandle?.destroy();
      effectHandle = null;

      scene.tweens.add({
        targets: [item, glow, ...nameTexts, ...(rarityText ? [rarityText] : []), hint, dim, ...(dupText ? [dupText] : [])],
        alpha: 0,
        duration: 240,
        onComplete: () => {
          item.destroy();
          glow.destroy();
          for (const t of nameTexts) t.destroy();
          if (rarityText) rarityText.destroy();
          hint.destroy();
          dim.destroy();
          if (dupText) dupText.destroy();
          if (emitter.active) emitter.destroy();
          onDone();
        },
      });
    };

    dim.on('pointerdown', () => {
      if (canDismiss) finish();
    });
    scene.time.delayedCall(3000, finish);
  }
}

function drawPresent(scene: Scene): GameObjects.Container {
  const container = scene.add.container(0, 0);
  const body = scene.add.graphics();
  body.fillStyle(0x6e4ad1, 1);
  body.fillRoundedRect(-70, -60, 140, 120, 10);
  body.fillStyle(0xffd34d, 1);
  body.fillRect(-70, -8, 140, 16);
  body.fillRect(-8, -60, 16, 120);
  body.lineStyle(3, 0xffffff, 0.85);
  body.strokeRoundedRect(-70, -60, 140, 120, 10);

  const bow = scene.add.graphics();
  bow.fillStyle(0xffd34d, 1);
  bow.fillCircle(-14, -66, 12);
  bow.fillCircle(14, -66, 12);
  bow.fillCircle(0, -62, 6);
  bow.lineStyle(2, 0xffffff, 0.85);
  bow.strokeCircle(-14, -66, 12);
  bow.strokeCircle(14, -66, 12);

  container.add([body, bow]);
  return container;
}

function ensureParticleTexture(scene: Scene): void {
  if (scene.textures.exists(PARTICLE_TEXTURE)) return;
  const gfx = scene.add.graphics();
  gfx.fillStyle(0xffffff, 1);
  gfx.fillCircle(5, 5, 5);
  gfx.generateTexture(PARTICLE_TEXTURE, 10, 10);
  gfx.destroy();
}
