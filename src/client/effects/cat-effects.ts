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

/** Anything Phaser-y that the effects can be applied to. Sprite and Image
 * both supply the position / depth / alpha / scale properties the effects
 * read — animations aren't required. */
export type EffectTarget = GameObjects.Sprite | GameObjects.Image;

/**
 * Compute the on-screen foot position of a target regardless of its origin.
 *
 * Seated cats use origin (0.5, 1) so `target.y` IS the feet. The DressingRoom
 * hero is an `Image` with the Phaser default origin (0.5, 0.5), which puts
 * `target.y` at the sprite's center. Without this helper, ground-anchored
 * effects (flame aura, particles spawning from the body) would float
 * relative to whatever origin the consumer picked.
 */
function footPosition(target: EffectTarget): { x: number; y: number } {
  return {
    x: target.x,
    y: target.y + target.displayHeight * (1 - target.originY),
  };
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
  /**
   * Spin up the effect on the given sprite/image. Return a handle that tears
   * it down. `scale` (default 1) amplifies the effect's footprint — flame
   * width, particle size, spread, etc. — so it reads at the same visual
   * weight as the (possibly scaled-up) cat it's attached to.
   */
  apply(scene: Scene, target: EffectTarget, scale?: number): EffectHandle;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Cylindrical flame glow that rises from the cat's feet upward. The bottom
 * of the flame sits AT the foot line (sprite.y); nothing renders below.
 * Built from a stack of horizontal slice ellipses interpolating from a
 * wide base to a narrow tip — gives a tapered flame shape with smooth
 * fall-off both vertically and horizontally.
 *
 * Phaser 4's preFX.addGlow is WebGL-only and doesn't render reliably inside
 * the Devvit iframe, so we draw it manually with Graphics.
 */
function makeGlow(color: number): CatEffect['apply'] {
  return (scene, sprite, scale = 1) => {
    // Flame footprint. Tuned to engulf the cat's lower body without hiding
    // the cat behind it. Scaled with the cat — a 1.4× seated cat gets a
    // 1.4× wider / taller flame so the glow keeps proportion to its host.
    const baseWidth = 56 * scale;
    const tipWidth = 10 * scale;
    const flameHeight = 96 * scale; // distance from feet upward
    const slices = 40; // resolution — more slices = smoother gradient
    const sliceThickness = 10 * scale; // each slice's vertical thickness (overlap creates the gradient)

    const graphics = scene.add.graphics();

    // Render the flame in local coords with (0,0) = cat's feet. Each slice is
    // a thin horizontal ellipse stacked higher than the last; alpha tapers
    // from a strong base to nearly invisible at the tip.
    for (let i = 0; i < slices; i++) {
      const t = i / (slices - 1); // 0 at base, 1 at tip
      const y = -t * flameHeight; // negative = up (feet are at 0)
      const w = baseWidth + (tipWidth - baseWidth) * t;
      // Stronger at the base (~0.24), tapering to ~0.05 at the tip. Bumped
      // from 0.10 base because the previous setting washed out against
      // the new full-image backdrops — auras need to read against busy
      // art, not just the flat purple void of the early Phase 5 builds.
      const alpha = 0.24 * (1 - t * 0.80);
      graphics.fillStyle(color, alpha);
      graphics.fillEllipse(0, y, w, sliceThickness);
    }
    graphics.setDepth(sprite.depth - 1);

    const sync = (): void => {
      // Compute the on-screen foot position regardless of the target's
      // origin so the flame base sits exactly at the cat's feet whether
      // the target is a seated Sprite (origin 0.5, 1) or the modal hero
      // Image (origin 0.5, 0.5).
      const foot = footPosition(sprite);
      graphics.setPosition(foot.x, foot.y);
    };
    sync();

    // Flicker: gentle horizontal scale tween so the flame feels alive rather
    // than reading as a frozen decal. Width-only — keeps the bottom anchored.
    const flicker = scene.tweens.add({
      targets: graphics,
      scaleX: 1.08,
      duration: 380,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
    // Subtle alpha breath as well.
    const pulse = scene.tweens.add({
      targets: graphics,
      alpha: 0.85,
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    scene.events.on(Scenes.Events.POST_UPDATE, sync);
    return {
      destroy: () => {
        scene.events.off(Scenes.Events.POST_UPDATE, sync);
        flicker.stop();
        flicker.remove();
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
  return (scene, sprite, scale = 1) => {
    // Amplify the particle footprint with the cat's render scale so the
    // emoji size / spread / rise distance keep proportion when seated cats
    // are scaled up. Cadence (spawnIntervalMs / lifeMs) intentionally
    // stays the same — denser spawning at high scales feels noisy.
    const size = opts.size * scale;
    const spreadX = opts.spreadX * scale;
    const riseDistancePx = opts.riseDistancePx * scale;
    const wobbleX = opts.wobbleX ? opts.wobbleX * scale : undefined;
    const live: GameObjects.Text[] = [];
    const spawnOne = (): void => {
      const offsetX = (Math.random() - 0.5) * spreadX;
      // Spawn around the cat's feet so particles look like they're rising
      // up from the ground around the cat, not bursting out of its torso.
      // Use the foot position helper so origin (Sprite vs Image) doesn't matter.
      const foot = footPosition(sprite);
      const startY = foot.y - sprite.displayHeight * 0.1;
      const t = scene.add
        .text(foot.x + offsetX, startY, opts.emoji, {
          fontSize: `${size}px`,
        })
        .setOrigin(0.5)
        // Render BEHIND the cat — particles are ambience around the
        // sprite, not foreground noise on top of it.
        .setDepth(sprite.depth - 1);
      live.push(t);

      // Movement tween — rise (and optionally wobble) over the full life.
      const moveTargets: Record<string, number | string> = {
        y: startY - riseDistancePx,
      };
      if (wobbleX) {
        moveTargets.x = `+=${(Math.random() < 0.5 ? -1 : 1) * wobbleX}`;
      }
      scene.tweens.add({
        targets: t,
        ...moveTargets,
        duration: opts.lifeMs,
        ease: 'Sine.easeOut',
      });

      // Alpha tween — hold at 1 for the first 60% of life so the particle
      // stays vivid all the way up to its apex, then fade over the last
      // 40%. Owns the destroy because it's the tween that finishes last.
      scene.tweens.add({
        targets: t,
        alpha: 0,
        duration: opts.lifeMs * 0.4,
        delay: opts.lifeMs * 0.6,
        ease: 'Sine.easeIn',
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

  // Particles — originals Tim liked. riseDistancePx ~95 across the board
  // so the particle column reaches roughly the same apex as the aura's
  // 96px flameHeight; lifeMs lengthened a touch to give the rise room to
  // breathe at the higher target height.
  {
    id: 'effect-sparkle',     name: 'Sparkles',    iconEmoji: '✨', rarity: 'uncommon',
    apply: makeParticles({ emoji: '✨', size: 14, spawnIntervalMs: 200, riseDistancePx: 95, lifeMs: 1600, spreadX: 50 }),
  },
  {
    id: 'effect-hearts',      name: 'Hearts',      iconEmoji: '💕', rarity: 'rare',
    apply: makeParticles({ emoji: '💕', size: 14, spawnIntervalMs: 220, riseDistancePx: 95, lifeMs: 1700, spreadX: 50 }),
  },

  // Particles — new variants for Tim to evaluate
  {
    id: 'effect-stars',       name: 'Stars',       iconEmoji: '⭐', rarity: 'uncommon',
    apply: makeParticles({ emoji: '⭐', size: 14, spawnIntervalMs: 240, riseDistancePx: 95, lifeMs: 1800, spreadX: 60 }),
  },
  {
    id: 'effect-music',       name: 'Music',       iconEmoji: '🎵', rarity: 'uncommon',
    apply: makeParticles({ emoji: '🎵', size: 16, spawnIntervalMs: 280, riseDistancePx: 100, lifeMs: 1900, spreadX: 40, wobbleX: 14 }),
  },
  {
    id: 'effect-snow',        name: 'Snow',        iconEmoji: '❄️', rarity: 'rare',
    apply: makeParticles({ emoji: '❄️', size: 14, spawnIntervalMs: 180, riseDistancePx: 95, lifeMs: 1800, spreadX: 60, wobbleX: 8 }),
  },
  {
    id: 'effect-blossom',     name: 'Blossoms',    iconEmoji: '🌸', rarity: 'rare',
    apply: makeParticles({ emoji: '🌸', size: 14, spawnIntervalMs: 240, riseDistancePx: 95, lifeMs: 1900, spreadX: 60, wobbleX: 10 }),
  },
  {
    id: 'effect-fire',        name: 'Fire',        iconEmoji: '🔥', rarity: 'rare',
    apply: makeParticles({ emoji: '🔥', size: 16, spawnIntervalMs: 120, riseDistancePx: 95, lifeMs: 1100, spreadX: 30 }),
  },
  {
    id: 'effect-bubbles',     name: 'Bubbles',     iconEmoji: '🫧', rarity: 'uncommon',
    apply: makeParticles({ emoji: '🫧', size: 14, spawnIntervalMs: 220, riseDistancePx: 100, lifeMs: 2000, spreadX: 40, wobbleX: 6 }),
  },
  {
    id: 'effect-butterfly',   name: 'Butterflies', iconEmoji: '🦋', rarity: 'legendary',
    apply: makeParticles({ emoji: '🦋', size: 16, spawnIntervalMs: 350, riseDistancePx: 110, lifeMs: 2200, spreadX: 70, wobbleX: 24 }),
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
