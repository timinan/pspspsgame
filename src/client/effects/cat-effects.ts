import { Scene, Scenes, GameObjects, Tweens } from 'phaser';

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
  /** Brief intensity spike — used by Game when the lane's cat lands a
   *  perfect/great so the aura/particles surge. Auto-decays back to the
   *  resting baseline over ~600 ms. Optional so older / simpler effect
   *  implementations (ghost) can opt out. */
  pulseHit?(): void;
  /** Brief intensity dip — used by Game when the lane's cat misses, so
   *  the aura/particles momentarily fade out. Auto-restores to baseline
   *  over ~600 ms. Optional, same reasoning as pulseHit. */
  pulseMiss?(): void;
}

/** Resting intensity multiplier the cat-attached effects render at when
 *  no recent hit/miss is biasing them. Tim's note: the on-stage effects
 *  were too loud at baseline — particles spawned too dense, glow was
 *  too bright. 0.55 dampens both so a hit's pulse back up to 1.0 reads
 *  as a meaningful spike instead of "the usual". */
const REST_INTENSITY = 0.55;
const HIT_INTENSITY = 1.0;
const MISS_INTENSITY = 0.3;
const PULSE_DECAY_MS = 600;

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
  /**
   * One-shot radial BURST centered on the target. Used by Game on a hit
   * so the cat's effect "echoes" out of the fuzzball — glows pulse out
   * as a halo, particle effects shoot the emoji out radially. Self-
   * cleaning; no handle returned. Distinct from `apply` (which is the
   * continuous cat-attached form) so the hit feedback can read at
   * fuzzball scale + radial vibe rather than "rises up from feet".
   */
  burst(scene: Scene, target: EffectTarget, scale?: number): void;
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
    graphics.alpha = REST_INTENSITY;

    const sync = (): void => {
      // Compute the on-screen foot position regardless of the target's
      // origin so the flame base sits exactly at the cat's feet whether
      // the target is a seated Sprite (origin 0.5, 1) or the modal hero
      // Image (origin 0.5, 0.5).
      const foot = footPosition(sprite);
      graphics.setPosition(foot.x, foot.y);
    };
    sync();

    // Per-instance phase offset desyncs flicker across multiple cats
    // wearing the same aura — without it, three red-aura cats all
    // breathe in unison and the effect reads as one big light source
    // instead of three independent auras.
    const flicker = scene.tweens.add({
      targets: graphics,
      scaleX: 1.08,
      duration: 380,
      delay: Math.random() * 380,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    // Hit/miss intensity reactions. Brief spike to HIT_INTENSITY (or dip
    // to MISS_INTENSITY) over 80 ms, then a gentle ease back to
    // REST_INTENSITY over PULSE_DECAY_MS. We track the pulse tween so
    // back-to-back taps stack cleanly without orphaning a half-finished
    // ramp on the graphics object.
    let pulseTween: Tweens.Tween | null = null;
    let pulseDecay: Tweens.Tween | null = null;
    const pulseTo = (peak: number): void => {
      pulseTween?.stop();
      pulseDecay?.stop();
      pulseTween = scene.tweens.add({
        targets: graphics,
        alpha: peak,
        duration: 80,
        ease: 'Quad.easeOut',
        onComplete: () => {
          pulseDecay = scene.tweens.add({
            targets: graphics,
            alpha: REST_INTENSITY,
            duration: PULSE_DECAY_MS,
            ease: 'Sine.easeOut',
          });
        },
      });
    };

    scene.events.on(Scenes.Events.POST_UPDATE, sync);
    return {
      destroy: () => {
        scene.events.off(Scenes.Events.POST_UPDATE, sync);
        flicker.stop();
        flicker.remove();
        pulseTween?.stop();
        pulseTween?.remove();
        pulseDecay?.stop();
        pulseDecay?.remove();
        graphics.destroy();
      },
      pulseHit: () => pulseTo(HIT_INTENSITY),
      pulseMiss: () => pulseTo(MISS_INTENSITY),
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
    // Rise distance gets the intensity treatment too: at REST, particles
    // travel ~70% as far up so the column reads softer; HIT bumps it
    // back to ~100%. We sample intensity per spawn, not after, so the
    // tween's max height matches the current vibe.
    const baseRise = opts.riseDistancePx * scale;
    const wobbleX = opts.wobbleX ? opts.wobbleX * scale : undefined;
    const live: GameObjects.Text[] = [];
    // Per-instance intensity (0..1) drives both per-particle alpha and
    // rise distance, so the column visibly dampens/brightens together
    // on miss/hit. pulseTween manipulates this object's `v` field.
    const intensity = { v: REST_INTENSITY };
    let pulseTween: Tweens.Tween | null = null;
    let pulseDecay: Tweens.Tween | null = null;
    const pulseTo = (peak: number): void => {
      pulseTween?.stop();
      pulseDecay?.stop();
      pulseTween = scene.tweens.add({
        targets: intensity,
        v: peak,
        duration: 80,
        ease: 'Quad.easeOut',
        onComplete: () => {
          pulseDecay = scene.tweens.add({
            targets: intensity,
            v: REST_INTENSITY,
            duration: PULSE_DECAY_MS,
            ease: 'Sine.easeOut',
          });
        },
      });
    };

    const spawnOne = (): void => {
      // Skip the spawn outright at very low intensity so MISS doesn't
      // just dim particles — it visibly thins them out too.
      if (intensity.v < REST_INTENSITY * 0.55 && Math.random() > intensity.v / REST_INTENSITY) {
        return;
      }
      const offsetX = (Math.random() - 0.5) * spreadX;
      // Spawn around the cat's feet so particles look like they're rising
      // up from the ground around the cat, not bursting out of its torso.
      const foot = footPosition(sprite);
      const startY = foot.y - sprite.displayHeight * 0.1;
      const startAlpha = Math.min(1, intensity.v + 0.05);
      const riseDistancePx = baseRise * (0.6 + intensity.v * 0.5);
      const t = scene.add
        .text(foot.x + offsetX, startY, opts.emoji, {
          fontSize: `${size}px`,
        })
        .setAlpha(startAlpha)
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

      // Alpha tween — hold at startAlpha for the first 60% of life so the
      // particle stays vivid all the way up to its apex, then fade over
      // the last 40%. Owns the destroy because it's the tween that
      // finishes last.
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
      // Per-instance phase offset on the FIRST spawn desyncs particle
      // cadence across cats wearing the same effect.
      delay: opts.spawnIntervalMs,
      startAt: Math.random() * opts.spawnIntervalMs,
      callback: spawnOne,
      loop: true,
    });
    return {
      destroy: () => {
        timer.remove(false);
        pulseTween?.stop();
        pulseTween?.remove();
        pulseDecay?.stop();
        pulseDecay?.remove();
        for (const t of live) {
          scene.tweens.killTweensOf(t);
          t.destroy();
        }
        live.length = 0;
      },
      pulseHit: () => pulseTo(HIT_INTENSITY),
      pulseMiss: () => pulseTo(MISS_INTENSITY),
    };
  };
}

// ---------------------------------------------------------------------------
// Burst variants used by Game's hit-feedback so the cat's effect echoes
// out of the fuzzball. Glows expand outward as a halo; particle effects
// shoot the emoji out radially. Both self-clean — Game just calls them
// and forgets, no handle to hold.
// ---------------------------------------------------------------------------

/** Expanding circular halo at the target. Starts at roughly the
 *  fuzzball's own radius and grows out past it so the aura visibly
 *  radiates AROUND the target, not just within it. Stacked concentric
 *  fills give the glow a soft edge that reads as "aura" instead of
 *  "hard ring".
 *
 *  Radii: fuzzball target is 72 px (radius 36). baseR=32 with start
 *  scale 1.2 ≈ outer radius 38 ≈ ball edge; end scale 2.5 ≈ outer
 *  radius 80 so the halo expands a full ball-width past the rim. */
function makeGlowBurst(color: number): CatEffect['burst'] {
  return (scene, target, scale = 1) => {
    // Aura now blooms as a RING outside the fuzzball — the previous
    // filled circles covered the hit target itself, which muddied the
    // sprite on every successful hit. Bumped peak alpha slightly so
    // the ring still reads loud without filling the fuzzball.
    const g = scene.add.graphics();
    g.setPosition(target.x, target.y);
    g.setDepth(target.depth + 1);
    const fuzzballR = 38 * scale;          // sits just outside the ~72 px target
    const layers: Array<{ r: number; thickness: number; a: number }> = [
      { r: fuzzballR + 4,  thickness: 8, a: 0.75 },
      { r: fuzzballR + 14, thickness: 6, a: 0.6 },
      { r: fuzzballR + 26, thickness: 4, a: 0.42 },
      { r: fuzzballR + 38, thickness: 2, a: 0.28 },
    ];
    for (const l of layers) {
      g.lineStyle(l.thickness, color, l.a);
      g.strokeCircle(0, 0, l.r);
    }
    scene.tweens.add({
      targets: g,
      scaleX: 1.9,
      scaleY: 1.9,
      alpha: 0,
      duration: 700,
      ease: 'Quad.easeOut',
      onComplete: () => g.destroy(),
    });
  };
}

/** Radial particle burst — emit `count` emoji from the target's center,
 *  each flying outward along an angle slice with a small jitter, fading
 *  to zero alpha as it travels. Particle size scales with the effect's
 *  `apply` size so the visual weight stays consistent across effects. */
function makeParticleBurst(emoji: string, size: number, count = 8): CatEffect['burst'] {
  return (scene, target, scale = 1) => {
    const baseDist = 48 * scale;
    const lifeMs = 600;
    const px = size * scale;
    for (let i = 0; i < count; i++) {
      const slice = (Math.PI * 2) / count;
      const angle = i * slice + (Math.random() - 0.5) * slice * 0.6;
      const dist = baseDist * (0.75 + Math.random() * 0.5);
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist;
      const p = scene.add
        .text(target.x, target.y, emoji, { fontSize: `${px}px` })
        .setOrigin(0.5)
        .setDepth(target.depth + 1);
      scene.tweens.add({
        targets: p,
        x: target.x + dx,
        y: target.y + dy,
        alpha: 0,
        duration: lifeMs,
        ease: 'Quad.easeOut',
        onComplete: () => p.destroy(),
      });
    }
  };
}

// ---------------------------------------------------------------------------
// The effect list. Movement effects (bob / pulse / spin / wobble) removed —
// Tim found them distracting. Keeping ghost (alpha-only) plus six fresh
// particle variants alongside the originals.
// ---------------------------------------------------------------------------

export const CAT_EFFECTS: CatEffect[] = [
  // Auras — fuzzy ground glow at the feet
  { id: 'effect-red-glow',    name: 'Red Aura',    iconEmoji: '🔴', rarity: 'common',    apply: makeGlow(0xff3333), burst: makeGlowBurst(0xff3333) },
  { id: 'effect-blue-glow',   name: 'Blue Aura',   iconEmoji: '🔵', rarity: 'common',    apply: makeGlow(0x3399ff), burst: makeGlowBurst(0x3399ff) },
  { id: 'effect-gold-glow',   name: 'Gold Aura',   iconEmoji: '🟡', rarity: 'rare',      apply: makeGlow(0xffd34d), burst: makeGlowBurst(0xffd34d) },
  { id: 'effect-green-glow',  name: 'Green Aura',  iconEmoji: '🟢', rarity: 'uncommon',  apply: makeGlow(0x33ff66), burst: makeGlowBurst(0x33ff66) },
  { id: 'effect-purple-glow', name: 'Purple Aura', iconEmoji: '🟣', rarity: 'uncommon',  apply: makeGlow(0xa64dff), burst: makeGlowBurst(0xa64dff) },
  { id: 'effect-pink-glow',   name: 'Pink Aura',   iconEmoji: '🩷', rarity: 'common',    apply: makeGlow(0xff66cc), burst: makeGlowBurst(0xff66cc) },

  // Filter-style — ghost reads as a desaturated white halo on hit
  { id: 'effect-ghost',       name: 'Ghost',       iconEmoji: '👻', rarity: 'rare',      apply: makeGhost(),        burst: makeGlowBurst(0xffffff) },

  // Particles — originals Tim liked. riseDistancePx ~95 across the board
  // so the particle column reaches roughly the same apex as the aura's
  // 96px flameHeight; lifeMs lengthened a touch to give the rise room to
  // breathe at the higher target height.
  {
    id: 'effect-sparkle',     name: 'Sparkles',    iconEmoji: '✨', rarity: 'uncommon',
    apply: makeParticles({ emoji: '✨', size: 14, spawnIntervalMs: 200, riseDistancePx: 95, lifeMs: 1600, spreadX: 50 }),
    burst: makeParticleBurst('✨', 14),
  },
  {
    id: 'effect-hearts',      name: 'Hearts',      iconEmoji: '💕', rarity: 'rare',
    apply: makeParticles({ emoji: '💕', size: 14, spawnIntervalMs: 220, riseDistancePx: 95, lifeMs: 1700, spreadX: 50 }),
    burst: makeParticleBurst('💕', 14),
  },

  // Particles — new variants for Tim to evaluate
  {
    id: 'effect-stars',       name: 'Stars',       iconEmoji: '⭐', rarity: 'uncommon',
    apply: makeParticles({ emoji: '⭐', size: 14, spawnIntervalMs: 240, riseDistancePx: 95, lifeMs: 1800, spreadX: 60 }),
    burst: makeParticleBurst('⭐', 14),
  },
  {
    id: 'effect-music',       name: 'Music',       iconEmoji: '🎵', rarity: 'uncommon',
    apply: makeParticles({ emoji: '🎵', size: 16, spawnIntervalMs: 280, riseDistancePx: 100, lifeMs: 1900, spreadX: 40, wobbleX: 14 }),
    burst: makeParticleBurst('🎵', 16),
  },
  {
    id: 'effect-snow',        name: 'Snow',        iconEmoji: '❄️', rarity: 'rare',
    apply: makeParticles({ emoji: '❄️', size: 14, spawnIntervalMs: 180, riseDistancePx: 95, lifeMs: 1800, spreadX: 60, wobbleX: 8 }),
    burst: makeParticleBurst('❄️', 14),
  },
  {
    id: 'effect-blossom',     name: 'Blossoms',    iconEmoji: '🌸', rarity: 'rare',
    apply: makeParticles({ emoji: '🌸', size: 14, spawnIntervalMs: 240, riseDistancePx: 95, lifeMs: 1900, spreadX: 60, wobbleX: 10 }),
    burst: makeParticleBurst('🌸', 14),
  },
  {
    id: 'effect-fire',        name: 'Fire',        iconEmoji: '🔥', rarity: 'rare',
    apply: makeParticles({ emoji: '🔥', size: 16, spawnIntervalMs: 120, riseDistancePx: 95, lifeMs: 1100, spreadX: 30 }),
    burst: makeParticleBurst('🔥', 16),
  },
  {
    id: 'effect-bubbles',     name: 'Bubbles',     iconEmoji: '🫧', rarity: 'uncommon',
    apply: makeParticles({ emoji: '🫧', size: 14, spawnIntervalMs: 220, riseDistancePx: 100, lifeMs: 2000, spreadX: 40, wobbleX: 6 }),
    burst: makeParticleBurst('🫧', 14),
  },
  {
    id: 'effect-butterfly',   name: 'Butterflies', iconEmoji: '🦋', rarity: 'legendary',
    apply: makeParticles({ emoji: '🦋', size: 16, spawnIntervalMs: 350, riseDistancePx: 110, lifeMs: 2200, spreadX: 70, wobbleX: 24 }),
    burst: makeParticleBurst('🦋', 16),
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
