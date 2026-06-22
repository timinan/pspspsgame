import { Scene, Scenes, GameObjects, Tweens } from 'phaser';

/**
 * Catalog of "effect cosmetics" — visual flair attached to a cat sprite via
 * Phaser 4 preFX, tweens, or particle emitters. Effect cosmetics live in the
 * EFFECT slot of the dressing room and apply at the Cat-entity level.
 *
 * Each effect declares its own apply() function which spins up the necessary
 * Phaser objects on a target sprite and returns a handle. The handle's
 * destroy() unwinds everything (kill tweens, remove FX, destroy emitters,
 * restore sprite properties).
 *
 * NOTE: effect cosmetics are CATALOG entries — every player gets one
 * instance of each at fresh-state init (see createFreshPlayerState) for
 * easy testing. We can lock them behind boxes later.
 */

export interface EffectHandle {
  destroy(): void;
}

export interface CatEffect {
  /** Stable catalog id, e.g. 'effect-red-glow'. Used as the CosmeticId. */
  id: string;
  /** Display name for the dressing-room thumbnail label. */
  name: string;
  /** Emoji rendered as the thumb art (effects have no atlas frames). */
  iconEmoji: string;
  /** Drives the rarity badge color. */
  rarity: 'common' | 'uncommon' | 'rare' | 'legendary';
  /** Spin up the effect on the given sprite. Return a handle that tears it down. */
  apply(scene: Scene, sprite: GameObjects.Sprite): EffectHandle;
}

// ---------------------------------------------------------------------------
// Helper builders so the effect entries below stay one-liner declarative.
// ---------------------------------------------------------------------------

/**
 * Build a glow effect using Phaser 4's preFX.addGlow.
 *
 * preFX runs inside the sprite's own quad — no separate object to manage.
 * On destroy we ask the preFX manager to remove the glow we added.
 */
/**
 * Glow implemented as a soft Graphics circle behind the sprite. Works in
 * both Canvas and WebGL renderers (Phaser 4's preFX glow is WebGL-only and
 * may not be available inside the Devvit iframe). The glow follows the
 * sprite each frame via a POST_UPDATE listener so it tracks any tweens.
 */
function makeGlow(color: number): CatEffect['apply'] {
  return (scene, sprite) => {
    const radius = 56;
    const graphics = scene.add.graphics();
    // Soft glow built from a stack of concentric translucent circles —
    // approximates a radial gradient without needing a PNG asset.
    for (let i = 5; i >= 0; i--) {
      const r = radius * (1 - i * 0.12);
      graphics.fillStyle(color, 0.10 + (5 - i) * 0.04);
      graphics.fillCircle(0, 0, r);
    }
    graphics.setDepth(sprite.depth - 1);
    const sync = (): void => {
      // Anchor the glow at the cat's body center, not its feet origin.
      graphics.setPosition(sprite.x, sprite.y - sprite.displayHeight * 0.4);
    };
    sync();
    // Subtle alpha breathing so the glow doesn't read as a static decal.
    const baseAlpha = 0.9;
    graphics.setAlpha(baseAlpha);
    const pulse = scene.tweens.add({
      targets: graphics,
      alpha: 0.5,
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
    scene.events.on(Scenes.Events.POST_UPDATE, sync);
    return {
      destroy: () => {
        scene.events.off(Scenes.Events.POST_UPDATE, sync);
        pulse.stop();
        pulse.remove();
        graphics.destroy();
      },
    };
  };
}

/** Y-axis bob tween. Stores the base y so destroy() can restore it. */
function makeBob(amplitudePx: number, durationMs: number): CatEffect['apply'] {
  return (scene, sprite) => {
    const baseY = sprite.y;
    const tween: Tweens.Tween = scene.tweens.add({
      targets: sprite,
      y: baseY - amplitudePx,
      duration: durationMs,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
    return {
      destroy: () => {
        tween.stop();
        tween.remove();
        sprite.y = baseY;
      },
    };
  };
}

/** Continuous rotation tween. Restore angle on destroy. */
function makeSpin(durationMs: number): CatEffect['apply'] {
  return (scene, sprite) => {
    const baseAngle = sprite.angle;
    const tween: Tweens.Tween = scene.tweens.add({
      targets: sprite,
      angle: baseAngle + 360,
      duration: durationMs,
      repeat: -1,
      ease: 'Linear',
    });
    return {
      destroy: () => {
        tween.stop();
        tween.remove();
        sprite.angle = baseAngle;
      },
    };
  };
}

/** Side-to-side wobble (small angle yoyo). */
function makeWobble(maxAngle: number, durationMs: number): CatEffect['apply'] {
  return (scene, sprite) => {
    const baseAngle = sprite.angle;
    const tween: Tweens.Tween = scene.tweens.add({
      targets: sprite,
      angle: baseAngle + maxAngle,
      duration: durationMs,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
    return {
      destroy: () => {
        tween.stop();
        tween.remove();
        sprite.angle = baseAngle;
      },
    };
  };
}

/** Alpha pulse — semi-transparent "ghost" look. */
function makeGhost(): CatEffect['apply'] {
  return (scene, sprite) => {
    const baseAlpha = sprite.alpha;
    const tween: Tweens.Tween = scene.tweens.add({
      targets: sprite,
      alpha: 0.35,
      duration: 800,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
    return {
      destroy: () => {
        tween.stop();
        tween.remove();
        sprite.alpha = baseAlpha;
      },
    };
  };
}

/**
 * Particle emitter — small floating shapes around the cat.
 * Uses a runtime-generated 1px white texture so we don't need new assets.
 */
function makeParticles(
  color: number,
  emoji: string,
  speedY: number,
): CatEffect['apply'] {
  return (scene, sprite) => {
    // Render each particle as a Text emoji so we get a recognizable shape
    // without shipping any new image. Phaser supports Text-based particles
    // by using a generated texture; the cheapest path is to spawn floating
    // Text objects on a recurring TimerEvent and tween them up.
    const live: GameObjects.Text[] = [];
    const spawnOne = (): void => {
      const offsetX = (Math.random() - 0.5) * 50;
      const startY = sprite.y - 10;
      const t = scene.add
        .text(sprite.x + offsetX, startY, emoji, {
          fontSize: '14px',
          color: '#' + color.toString(16).padStart(6, '0'),
        })
        .setOrigin(0.5)
        .setDepth(sprite.depth + 2);
      live.push(t);
      scene.tweens.add({
        targets: t,
        y: startY - speedY,
        alpha: 0,
        duration: 1200,
        ease: 'Sine.easeOut',
        onComplete: () => {
          const i = live.indexOf(t);
          if (i >= 0) live.splice(i, 1);
          t.destroy();
        },
      });
    };
    const timer = scene.time.addEvent({
      delay: 200,
      callback: spawnOne,
      loop: true,
    });
    return {
      destroy: () => {
        timer.remove(false);
        for (const t of live) {
          scene.tweens.killTweensOf(t);
          t.destroy();
        }
        live.length = 0;
      },
    };
  };
}

/** Pulse scale around its current value. */
function makePulse(multiplier: number, durationMs: number): CatEffect['apply'] {
  return (scene, sprite) => {
    const baseX = sprite.scaleX;
    const baseY = sprite.scaleY;
    const tween: Tweens.Tween = scene.tweens.add({
      targets: sprite,
      scaleX: baseX * multiplier,
      scaleY: baseY * multiplier,
      duration: durationMs,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
    return {
      destroy: () => {
        tween.stop();
        tween.remove();
        sprite.setScale(baseX, baseY);
      },
    };
  };
}

// ---------------------------------------------------------------------------
// The list. Add or remove freely.
// ---------------------------------------------------------------------------

export const CAT_EFFECTS: CatEffect[] = [
  // Glows (Phaser 4 preFX)
  { id: 'effect-red-glow',    name: 'Red Glow',    iconEmoji: '🔴', rarity: 'common',    apply: makeGlow(0xff3333) },
  { id: 'effect-blue-glow',   name: 'Blue Glow',   iconEmoji: '🔵', rarity: 'common',    apply: makeGlow(0x3399ff) },
  { id: 'effect-gold-glow',   name: 'Gold Glow',   iconEmoji: '🟡', rarity: 'rare',      apply: makeGlow(0xffd34d) },
  { id: 'effect-green-glow',  name: 'Green Glow',  iconEmoji: '🟢', rarity: 'uncommon',  apply: makeGlow(0x33ff66) },
  { id: 'effect-purple-glow', name: 'Purple Glow', iconEmoji: '🟣', rarity: 'uncommon',  apply: makeGlow(0xa64dff) },
  { id: 'effect-pink-glow',   name: 'Pink Glow',   iconEmoji: '🩷', rarity: 'common',    apply: makeGlow(0xff66cc) },
  // Tween-based
  { id: 'effect-bob',         name: 'Bobbing',     iconEmoji: '⬆️', rarity: 'common',    apply: makeBob(6, 600) },
  { id: 'effect-pulse',       name: 'Pulsing',     iconEmoji: '💗', rarity: 'common',    apply: makePulse(1.08, 500) },
  { id: 'effect-spin',        name: 'Spinning',    iconEmoji: '🔄', rarity: 'rare',      apply: makeSpin(2400) },
  { id: 'effect-wobble',      name: 'Wobble',      iconEmoji: '〰️', rarity: 'common',    apply: makeWobble(8, 350) },
  // Filter-style
  { id: 'effect-ghost',       name: 'Ghost',       iconEmoji: '👻', rarity: 'rare',      apply: makeGhost() },
  // Particles
  { id: 'effect-sparkle',     name: 'Sparkles',    iconEmoji: '✨', rarity: 'uncommon',  apply: makeParticles(0xffffff, '✨', 30) },
  { id: 'effect-hearts',      name: 'Hearts',      iconEmoji: '💕', rarity: 'rare',      apply: makeParticles(0xff66aa, '💕', 36) },
];

/** Fast lookup by id. */
export const CAT_EFFECT_BY_ID: Record<string, CatEffect> = Object.fromEntries(
  CAT_EFFECTS.map((e) => [e.id, e]),
);

/** Convenience for the catalog merge in shared/state.ts. */
export function isEffectCosmeticId(id: string): boolean {
  return id in CAT_EFFECT_BY_ID;
}
