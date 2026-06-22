import { Scene, Scenes, GameObjects } from 'phaser';

/**
 * Catalog of "effect cosmetics" — visual flair attached to a cat sprite via
 * Phaser tweens, Graphics, or particle emitters. Effect cosmetics live in
 * the EFFECT slot of the dressing room.
 *
 * Each effect declares its own apply() function which spins up the necessary
 * Phaser objects on a target sprite and returns a handle. The handle's
 * destroy() unwinds everything (kill tweens, destroy emitters, clean
 * up POST_UPDATE listeners).
 *
 * Every player auto-receives one instance of each effect at fresh-state
 * init (see createFreshPlayerState) so they can immediately try them.
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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fuzzy ground aura — a soft elliptical glow anchored at the cat's feet that
 * wraps up and around the lower body. Built from many thin translucent
 * ellipses for a smooth radial fall-off (Phaser 4's preFX glow is WebGL-only
 * and doesn't render reliably inside the Devvit iframe, so we draw it
 * manually with Graphics).
 */
function makeGlow(color: number): CatEffect['apply'] {
  return (scene, sprite) => {
    const radiusX = 64;
    const radiusY = 38;
    const layers = 20;
    const graphics = scene.add.graphics();
    // Many thin ellipses — outer layers are nearly transparent, inner layers
    // build up to a softer max so the glow reads as a fuzzy aura, not a disc.
    for (let i = layers; i > 0; i--) {
      const t = i / layers;
      const rx = radiusX * t;
      const ry = radiusY * t;
      // Per-layer alpha contribution. Outer (high t) gets the smallest add,
      // inner (low t) the largest. Caps below 0.08/layer to keep it fuzzy.
      const alpha = 0.025 * (1 - t * 0.85);
      graphics.fillStyle(color, alpha);
      graphics.fillEllipse(0, 0, rx * 2, ry * 2);
    }
    graphics.setDepth(sprite.depth - 1);

    const sync = (): void => {
      // sprite.y is the foot (origin 0.5, 1). Anchor the aura center a hair
      // above the feet so it engulfs the lower legs.
      graphics.setPosition(sprite.x, sprite.y - 6);
    };
    sync();

    // Subtle breathing so the aura feels alive without distracting.
    const pulse = scene.tweens.add({
      targets: graphics,
      alpha: 0.55,
      duration: 1100,
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

/**
 * Alpha-breathing "ghost" look. Not a position move so it's kept after the
 * movement-effect cull.
 */
function makeGhost(): CatEffect['apply'] {
  return (scene, sprite) => {
    const baseAlpha = sprite.alpha;
    const tween = scene.tweens.add({
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
 * Floating-emoji particle emitter. Spawns one emoji on a fixed cadence around
 * the cat; each particle drifts upward with optional horizontal wobble and
 * fades out.
 */
interface ParticleOpts {
  emoji: string;
  /** Pixel font-size for the emoji. */
  size: number;
  /** ms between spawns. Smaller = denser. */
  spawnIntervalMs: number;
  /** How far each particle floats upward before fading out. */
  riseDistancePx: number;
  /** ms per particle life. */
  lifeMs: number;
  /** Horizontal spread (random offset from cat center, plus or minus). */
  spreadX: number;
  /** Optional horizontal wobble while rising (peak ±px). 0 = straight up. */
  wobbleX?: number;
}

function makeParticles(opts: ParticleOpts): CatEffect['apply'] {
  return (scene, sprite) => {
    const live: GameObjects.Text[] = [];
    const spawnOne = (): void => {
      const offsetX = (Math.random() - 0.5) * opts.spreadX;
      // Spawn near the cat's body (mid-torso) so particles look like they're
      // coming FROM the cat, not floating above its head.
      const startY = sprite.y - sprite.displayHeight * 0.45;
      const t = scene.add
        .text(sprite.x + offsetX, startY, opts.emoji, {
          fontSize: `${opts.size}px`,
        })
        .setOrigin(0.5)
        .setDepth(sprite.depth + 2);
      live.push(t);

      const targets: Record<string, number | string> = {
        y: startY - opts.riseDistancePx,
        alpha: 0,
      };
      if (opts.wobbleX) {
        targets.x = `+=${(Math.random() < 0.5 ? -1 : 1) * opts.wobbleX}`;
      }

      scene.tweens.add({
        targets: t,
        ...targets,
        duration: opts.lifeMs,
        ease: 'Sine.easeOut',
        onComplete: () => {
          const i = live.indexOf(t);
          if (i >= 0) live.splice(i, 1);
          t.destroy();
        },
      });
    };
    const timer = scene.time.addEvent({
      delay: opts.spawnIntervalMs,
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

// ---------------------------------------------------------------------------
// The effect list. Movement effects (bob / pulse / spin / wobble) removed —
// Tim found them distracting. Keeping ghost (alpha-only) plus six fresh
// particle variants alongside the originals.
// ---------------------------------------------------------------------------

export const CAT_EFFECTS: CatEffect[] = [
  // Auras — fuzzy ground glow at the feet
  { id: 'effect-red-glow',    name: 'Red Aura',    iconEmoji: '🔴', rarity: 'common',    apply: makeGlow(0xff3333) },
  { id: 'effect-blue-glow',   name: 'Blue Aura',   iconEmoji: '🔵', rarity: 'common',    apply: makeGlow(0x3399ff) },
  { id: 'effect-gold-glow',   name: 'Gold Aura',   iconEmoji: '🟡', rarity: 'rare',      apply: makeGlow(0xffd34d) },
  { id: 'effect-green-glow',  name: 'Green Aura',  iconEmoji: '🟢', rarity: 'uncommon',  apply: makeGlow(0x33ff66) },
  { id: 'effect-purple-glow', name: 'Purple Aura', iconEmoji: '🟣', rarity: 'uncommon',  apply: makeGlow(0xa64dff) },
  { id: 'effect-pink-glow',   name: 'Pink Aura',   iconEmoji: '🩷', rarity: 'common',    apply: makeGlow(0xff66cc) },

  // Filter-style
  { id: 'effect-ghost',       name: 'Ghost',       iconEmoji: '👻', rarity: 'rare',      apply: makeGhost() },

  // Particles — originals Tim liked
  {
    id: 'effect-sparkle',     name: 'Sparkles',    iconEmoji: '✨', rarity: 'uncommon',
    apply: makeParticles({ emoji: '✨', size: 14, spawnIntervalMs: 200, riseDistancePx: 30, lifeMs: 1200, spreadX: 50 }),
  },
  {
    id: 'effect-hearts',      name: 'Hearts',      iconEmoji: '💕', rarity: 'rare',
    apply: makeParticles({ emoji: '💕', size: 14, spawnIntervalMs: 220, riseDistancePx: 36, lifeMs: 1300, spreadX: 50 }),
  },

  // Particles — new variants for Tim to evaluate
  {
    id: 'effect-stars',       name: 'Stars',       iconEmoji: '⭐', rarity: 'uncommon',
    apply: makeParticles({ emoji: '⭐', size: 14, spawnIntervalMs: 240, riseDistancePx: 38, lifeMs: 1400, spreadX: 60 }),
  },
  {
    id: 'effect-music',       name: 'Music',       iconEmoji: '🎵', rarity: 'uncommon',
    apply: makeParticles({ emoji: '🎵', size: 16, spawnIntervalMs: 280, riseDistancePx: 50, lifeMs: 1600, spreadX: 40, wobbleX: 14 }),
  },
  {
    id: 'effect-snow',        name: 'Snow',        iconEmoji: '❄️', rarity: 'rare',
    apply: makeParticles({ emoji: '❄️', size: 14, spawnIntervalMs: 180, riseDistancePx: 30, lifeMs: 1500, spreadX: 60, wobbleX: 8 }),
  },
  {
    id: 'effect-blossom',     name: 'Blossoms',    iconEmoji: '🌸', rarity: 'rare',
    apply: makeParticles({ emoji: '🌸', size: 14, spawnIntervalMs: 240, riseDistancePx: 40, lifeMs: 1600, spreadX: 60, wobbleX: 10 }),
  },
  {
    id: 'effect-fire',        name: 'Fire',        iconEmoji: '🔥', rarity: 'rare',
    apply: makeParticles({ emoji: '🔥', size: 16, spawnIntervalMs: 120, riseDistancePx: 30, lifeMs: 800, spreadX: 30 }),
  },
  {
    id: 'effect-bubbles',     name: 'Bubbles',     iconEmoji: '🫧', rarity: 'uncommon',
    apply: makeParticles({ emoji: '🫧', size: 14, spawnIntervalMs: 220, riseDistancePx: 50, lifeMs: 1700, spreadX: 40, wobbleX: 6 }),
  },
  {
    id: 'effect-butterfly',   name: 'Butterflies', iconEmoji: '🦋', rarity: 'legendary',
    apply: makeParticles({ emoji: '🦋', size: 16, spawnIntervalMs: 350, riseDistancePx: 60, lifeMs: 2000, spreadX: 70, wobbleX: 24 }),
  },
];

/** Fast lookup by id. */
export const CAT_EFFECT_BY_ID: Record<string, CatEffect> = Object.fromEntries(
  CAT_EFFECTS.map((e) => [e.id, e]),
);

/** Convenience for catalog filtering. */
export function isEffectCosmeticId(id: string): boolean {
  return id in CAT_EFFECT_BY_ID;
}
