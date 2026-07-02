import * as Phaser from 'phaser';
import { Scene, Scenes, GameObjects, Tweens } from 'phaser';
import { getUserSettings } from '@/systems/user-settings';

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
 * Multicolor stagelight — same flame-stack geometry as `makeGlow` but
 * cycles the fill color through `colors` over `cycleMs`. Two-color combos
 * cross-fade as a slow color sweep; longer lists rotate around. Drawing
 * is re-issued on every POST_UPDATE since the color changes per frame.
 *
 * Re-uses the same flicker tween + hit/miss pulse semantics as `makeGlow`
 * so multicolor stagelights feel like the other auras — just chromatic.
 */
function makeMultiGlow(
  colors: number[],
  cycleMs = 2400,
): CatEffect['apply'] {
  return (scene, sprite, scale = 1) => {
    const baseWidth = 56 * scale;
    const tipWidth = 10 * scale;
    const flameHeight = 96 * scale;
    const slices = 40;
    const sliceThickness = 10 * scale;

    const graphics = scene.add.graphics();
    graphics.setDepth(sprite.depth - 1);
    graphics.alpha = REST_INTENSITY;

    const draw = (color: number): void => {
      graphics.clear();
      for (let i = 0; i < slices; i++) {
        const t = i / (slices - 1);
        const y = -t * flameHeight;
        const w = baseWidth + (tipWidth - baseWidth) * t;
        const alpha = 0.24 * (1 - t * 0.8);
        graphics.fillStyle(color, alpha);
        graphics.fillEllipse(0, y, w, sliceThickness);
      }
    };

    const sync = (): void => {
      const foot = footPosition(sprite);
      graphics.setPosition(foot.x, foot.y);
    };

    // Color interpolation. phase ∈ [0, 1) advances over cycleMs; segments
    // divide [0,1) evenly between adjacent color pairs. We lerp R/G/B
    // independently for each segment.
    const startedAt = scene.time.now;
    const seg = 1 / colors.length;
    let lastColor = -1;
    const stepColor = (): void => {
      const elapsed = scene.time.now - startedAt;
      const phase = (elapsed / cycleMs) % 1;
      const segIdx = Math.floor(phase / seg);
      const segPhase = (phase - segIdx * seg) / seg;
      const c1 = colors[segIdx];
      const c2 = colors[(segIdx + 1) % colors.length];
      const r1 = (c1 >> 16) & 0xff;
      const g1 = (c1 >> 8) & 0xff;
      const b1 = c1 & 0xff;
      const r2 = (c2 >> 16) & 0xff;
      const g2 = (c2 >> 8) & 0xff;
      const b2 = c2 & 0xff;
      const r = Math.round(r1 + (r2 - r1) * segPhase);
      const g = Math.round(g1 + (g2 - g1) * segPhase);
      const b = Math.round(b1 + (b2 - b1) * segPhase);
      const color = (r << 16) | (g << 8) | b;
      if (color !== lastColor) {
        draw(color);
        lastColor = color;
      }
    };

    const onUpdate = (): void => {
      sync();
      stepColor();
    };
    scene.events.on(Scenes.Events.POST_UPDATE, onUpdate);
    sync();
    stepColor();

    const flicker = scene.tweens.add({
      targets: graphics,
      scaleX: 1.08,
      duration: 380,
      delay: Math.random() * 380,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

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

    return {
      destroy: () => {
        scene.events.off(Scenes.Events.POST_UPDATE, onUpdate);
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
      // Floating particles sit BEHIND the cat (depth-1) outside the play
      // area, so we want them to read clearly without competing with the
      // gameplay. +0.35 offset bumps REST (0.55) → 0.9 alpha, much more
      // visible than the prior +0.05 → 0.6 ghost-y look. User settings
      // multiplier lets the player dial all effects up/down live.
      const { effectAlphaMul, effectSizeMul } = getUserSettings();
      const startAlpha = Math.min(1, (intensity.v + 0.35) * effectAlphaMul);
      const liveSize = Math.max(1, Math.round(size * effectSizeMul));
      const riseDistancePx = baseRise * (0.6 + intensity.v * 0.5);
      const t = scene.add
        .text(foot.x + offsetX, startY, opts.emoji, {
          fontSize: `${liveSize}px`,
          // resolution: 0.5 renders the emoji into a HALF-size internal
          // canvas; combined with NEAREST filter below, the engine then
          // upscales those chunky source pixels with no smoothing → real
          // pixel-art look instead of crisp anti-aliased emoji.
          // Padding prevents crop on tall emoji like ❤️/⭐ whose glyph
          // extends above Phaser's text auto-measure baseline.
          resolution: 0.42,
          padding: { x: 4, y: 6 },
        })
        .setAlpha(startAlpha)
        .setOrigin(0.5)
        // Render BEHIND the cat — particles are ambience around the
        // sprite, not foreground noise on top of it.
        .setDepth(sprite.depth - 1);
      // NEAREST filter on the rendered text texture forces chunky-pixel
      // upscaling instead of the default LINEAR blur. Paired with the
      // resolution: 0.5 above this is what makes the emoji actually look
      // pixelated rather than just low-res anti-aliased.
      t.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
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
    // Aura ring sits just outside the fuzzball. Per Tim: a touch
    // QUIETER than before — alphas + ring thicknesses pulled back so
    // the aura whispers while the particle bursts on the other effects
    // shout.
    const g = scene.add.graphics();
    g.setPosition(target.x, target.y);
    g.setDepth(target.depth + 1);
    const fuzzballR = 38 * scale;
    const layers: Array<{ r: number; thickness: number; a: number }> = [
      { r: fuzzballR + 4,  thickness: 5, a: 0.5 },
      { r: fuzzballR + 12, thickness: 3, a: 0.34 },
      { r: fuzzballR + 22, thickness: 2, a: 0.22 },
    ];
    for (const l of layers) {
      g.lineStyle(l.thickness, color, l.a);
      g.strokeCircle(0, 0, l.r);
    }
    scene.tweens.add({
      targets: g,
      scaleX: 1.5,
      scaleY: 1.5,
      alpha: 0,
      duration: 500,
      ease: 'Quad.easeOut',
      onComplete: () => g.destroy(),
    });
  };
}

/** Radial particle burst — emit `count` emoji from the target's center,
 *  each flying outward along an angle slice with a small jitter, fading
 *  to zero alpha as it travels. Particle size scales with the effect's
 *  `apply` size so the visual weight stays consistent across effects.
 *
 *  Per Tim: bump count + distance + size so sparkles / hearts / etc
 *  feel like a celebratory explosion (was reading too polite). Particles
 *  start slightly larger and hold size for the first 30% of life before
 *  fading. */
function makeParticleBurst(
  emoji: string,
  size: number,
  count = 12,
  /** Optional per-effect override of the default burst alpha. Bubbles +
   *  clouds need to read more solid (their natural translucency looks
   *  weak), so the catalog passes a higher value for those. */
  alphaOverride?: number,
): CatEffect['burst'] {
  return (scene, target, scale = 1) => {
    // Burst particles fire from the hit-target fuzz-ball during play,
    // sitting in the player's read zone. Keep them smaller + tighter +
    // more transparent so they're celebratory without blocking incoming
    // notes. User-settings multipliers let the player dial all effects
    // up/down live without restarting the round.
    const { effectAlphaMul, effectSizeMul } = getUserSettings();
    const baseDist = 56 * scale;
    const lifeMs = 720;
    const px = Math.max(1, Math.round(size * scale * 1.15 * effectSizeMul));
    const BURST_ALPHA = Math.max(0, Math.min(1, (alphaOverride ?? 0.6) * effectAlphaMul));
    for (let i = 0; i < count; i++) {
      const slice = (Math.PI * 2) / count;
      const angle = i * slice + (Math.random() - 0.5) * slice * 0.7;
      const dist = baseDist * (0.85 + Math.random() * 0.55);
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist;
      const p = scene.add
        .text(target.x, target.y, emoji, {
          fontSize: `${px}px`,
          // resolution: 0.5 + NEAREST filter (below) = real pixel-art
          // emoji, not just low-res anti-aliased ones. Padding stops
          // crop on tall glyphs like ❤️/⭐.
          resolution: 0.42,
          padding: { x: 4, y: 6 },
        })
        .setAlpha(BURST_ALPHA)
        .setOrigin(0.5)
        .setDepth(target.depth + 1)
        .setScale(0.6);
      p.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
      // Pop in fast, then drift outward + fade. Holds peak alpha for
      // the first half of life so the burst reads loud, then fades.
      scene.tweens.add({
        targets: p,
        scale: 1,
        duration: 140,
        ease: 'Back.easeOut',
      });
      scene.tweens.add({
        targets: p,
        x: target.x + dx,
        y: target.y + dy,
        duration: lifeMs,
        ease: 'Quad.easeOut',
      });
      scene.tweens.add({
        targets: p,
        alpha: 0,
        delay: lifeMs * 0.45,
        duration: lifeMs * 0.55,
        ease: 'Linear',
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

/**
 * Compact builder used by the 2026-06-30 emoji batch (Tim's list of ~100
 * emoji effects). Standard cadence: size 14 (or 16 for bigger glyphs),
 * spawn 240ms, rise 95px, life 1800ms, spread 55. All rarity 'common' so
 * everything's playable from day one; re-tune individual entries by
 * replacing the call with a full literal.
 */
function emojiEffect(
  id: string,
  name: string,
  emoji: string,
  size = 14,
): CatEffect {
  return {
    id,
    name,
    iconEmoji: emoji,
    rarity: 'common',
    apply: makeParticles({
      emoji,
      size,
      spawnIntervalMs: 240,
      riseDistancePx: 95,
      lifeMs: 1800,
      spreadX: 55,
    }),
    burst: makeParticleBurst(emoji, size),
  };
}

export const CAT_EFFECTS: CatEffect[] = [
  // Stagelights — fuzzy stage-light glow rising from the cat's feet.
  // (Display rename 2026-06-30, was 'Aura'. IDs stay `effect-X-glow` so
  // existing player saves don't break their equipped item.)
  { id: 'effect-red-glow',    name: 'Red Stagelight',    iconEmoji: '🔴', rarity: 'common',    apply: makeGlow(0xff3333), burst: makeGlowBurst(0xff3333) },
  { id: 'effect-blue-glow',   name: 'Blue Stagelight',   iconEmoji: '🔵', rarity: 'common',    apply: makeGlow(0x3399ff), burst: makeGlowBurst(0x3399ff) },
  { id: 'effect-gold-glow',   name: 'Gold Stagelight',   iconEmoji: '🟡', rarity: 'rare',      apply: makeGlow(0xffd34d), burst: makeGlowBurst(0xffd34d) },
  { id: 'effect-green-glow',  name: 'Green Stagelight',  iconEmoji: '🟢', rarity: 'uncommon',  apply: makeGlow(0x33ff66), burst: makeGlowBurst(0x33ff66) },
  { id: 'effect-purple-glow', name: 'Purple Stagelight', iconEmoji: '🟣', rarity: 'uncommon',  apply: makeGlow(0xa64dff), burst: makeGlowBurst(0xa64dff) },
  { id: 'effect-pink-glow',   name: 'Pink Stagelight',   iconEmoji: '🩷', rarity: 'common',    apply: makeGlow(0xff66cc), burst: makeGlowBurst(0xff66cc) },

  // Multicolor stagelights — cycle through a palette using makeMultiGlow.
  // cycleMs is the full rotation duration; longer = slower color sweep.
  { id: 'effect-rainbow-glow',   name: 'Rainbow Stagelight',  iconEmoji: '🌈', rarity: 'legendary',
    apply: makeMultiGlow([0xff3333, 0xffa500, 0xffd34d, 0x33ff66, 0x3399ff, 0xa64dff], 4800),
    burst: makeGlowBurst(0xff66cc) },
  { id: 'effect-sunset-glow',    name: 'Sunset Stagelight',   iconEmoji: '🌇', rarity: 'rare',
    apply: makeMultiGlow([0xff5e3a, 0xff9a3c, 0xffd66b, 0xff5e3a], 3600),
    burst: makeGlowBurst(0xff7a45) },
  { id: 'effect-aurora-glow',    name: 'Aurora Stagelight',   iconEmoji: '🌌', rarity: 'rare',
    apply: makeMultiGlow([0x33ff99, 0x33ffe6, 0x6688ff, 0xa64dff, 0x33ff99], 4400),
    burst: makeGlowBurst(0x33ffd4) },
  { id: 'effect-police-glow',    name: 'Police Stagelight',   iconEmoji: '🚨', rarity: 'uncommon',
    apply: makeMultiGlow([0xff2222, 0x2266ff], 600),
    burst: makeGlowBurst(0xff2222) },
  { id: 'effect-disco-glow',     name: 'Disco Stagelight',    iconEmoji: '🪩', rarity: 'rare',
    apply: makeMultiGlow([0xff33aa, 0x33ddff, 0xffe44d, 0x66ff66, 0xff7a3c], 1200),
    burst: makeGlowBurst(0xff33aa) },
  { id: 'effect-rgb-glow',       name: 'RGB Stagelight',      iconEmoji: '💡', rarity: 'uncommon',
    apply: makeMultiGlow([0xff0000, 0x00ff00, 0x0066ff], 2400),
    burst: makeGlowBurst(0x00ff66) },

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
    // Bubble emoji is inherently translucent — needs an opacity boost
    // over the default 0.6 to read as solid. 0.85 keeps it visibly
    // weightier than peers without going full opaque.
    burst: makeParticleBurst('🫧', 14, 12, 0.85),
  },
  {
    id: 'effect-butterfly',   name: 'Butterflies', iconEmoji: '🦋', rarity: 'legendary',
    apply: makeParticles({ emoji: '🦋', size: 16, spawnIntervalMs: 350, riseDistancePx: 110, lifeMs: 2200, spreadX: 70, wobbleX: 24 }),
    burst: makeParticleBurst('🦋', 16),
  },

  // Nature
  {
    id: 'effect-leaves',      name: 'Leaves',      iconEmoji: '🍃', rarity: 'common',
    apply: makeParticles({ emoji: '🍃', size: 14, spawnIntervalMs: 230, riseDistancePx: 100, lifeMs: 1900, spreadX: 60, wobbleX: 14 }),
    burst: makeParticleBurst('🍃', 14),
  },
  {
    id: 'effect-autumn',      name: 'Autumn Leaves', iconEmoji: '🍂', rarity: 'uncommon',
    apply: makeParticles({ emoji: '🍂', size: 14, spawnIntervalMs: 240, riseDistancePx: 100, lifeMs: 1900, spreadX: 60, wobbleX: 12 }),
    burst: makeParticleBurst('🍂', 14),
  },
  {
    id: 'effect-sunflower',   name: 'Sunflowers',  iconEmoji: '🌻', rarity: 'rare',
    apply: makeParticles({ emoji: '🌻', size: 16, spawnIntervalMs: 260, riseDistancePx: 95, lifeMs: 1800, spreadX: 55 }),
    burst: makeParticleBurst('🌻', 16),
  },
  {
    id: 'effect-clover',      name: 'Lucky Clovers', iconEmoji: '🍀', rarity: 'rare',
    apply: makeParticles({ emoji: '🍀', size: 14, spawnIntervalMs: 240, riseDistancePx: 95, lifeMs: 1800, spreadX: 55 }),
    burst: makeParticleBurst('🍀', 14),
  },
  {
    id: 'effect-mushroom',    name: 'Mushrooms',   iconEmoji: '🍄', rarity: 'uncommon',
    apply: makeParticles({ emoji: '🍄', size: 14, spawnIntervalMs: 250, riseDistancePx: 95, lifeMs: 1800, spreadX: 55 }),
    burst: makeParticleBurst('🍄', 14),
  },

  // Weather / sky
  {
    id: 'effect-lightning',   name: 'Lightning',   iconEmoji: '⚡', rarity: 'rare',
    apply: makeParticles({ emoji: '⚡', size: 16, spawnIntervalMs: 160, riseDistancePx: 95, lifeMs: 1200, spreadX: 40 }),
    burst: makeParticleBurst('⚡', 16),
  },
  {
    id: 'effect-clouds',      name: 'Clouds',      iconEmoji: '☁️', rarity: 'common',
    apply: makeParticles({ emoji: '☁️', size: 16, spawnIntervalMs: 280, riseDistancePx: 100, lifeMs: 2100, spreadX: 60, wobbleX: 8 }),
    // ☁️ is washed-out by default — bump burst alpha so it carries weight.
    burst: makeParticleBurst('☁️', 16, 12, 0.85),
  },
  {
    id: 'effect-sunbeam',     name: 'Sunbeams',    iconEmoji: '☀️', rarity: 'uncommon',
    apply: makeParticles({ emoji: '☀️', size: 16, spawnIntervalMs: 260, riseDistancePx: 95, lifeMs: 1800, spreadX: 50 }),
    burst: makeParticleBurst('☀️', 16),
  },
  {
    id: 'effect-moon',        name: 'Moonlight',   iconEmoji: '🌙', rarity: 'uncommon',
    apply: makeParticles({ emoji: '🌙', size: 16, spawnIntervalMs: 280, riseDistancePx: 100, lifeMs: 2000, spreadX: 55 }),
    burst: makeParticleBurst('🌙', 16),
  },
  {
    id: 'effect-rainbow',     name: 'Rainbows',    iconEmoji: '🌈', rarity: 'legendary',
    apply: makeParticles({ emoji: '🌈', size: 18, spawnIntervalMs: 320, riseDistancePx: 105, lifeMs: 2100, spreadX: 65 }),
    burst: makeParticleBurst('🌈', 18),
  },

  // Sweets
  {
    id: 'effect-cherry',      name: 'Cherries',    iconEmoji: '🍒', rarity: 'common',
    apply: makeParticles({ emoji: '🍒', size: 14, spawnIntervalMs: 240, riseDistancePx: 95, lifeMs: 1800, spreadX: 50 }),
    burst: makeParticleBurst('🍒', 14),
  },
  {
    id: 'effect-candy',       name: 'Candy',       iconEmoji: '🍬', rarity: 'common',
    apply: makeParticles({ emoji: '🍬', size: 14, spawnIntervalMs: 240, riseDistancePx: 95, lifeMs: 1800, spreadX: 55 }),
    burst: makeParticleBurst('🍬', 14),
  },
  {
    id: 'effect-cupcake',     name: 'Cupcakes',    iconEmoji: '🧁', rarity: 'uncommon',
    apply: makeParticles({ emoji: '🧁', size: 16, spawnIntervalMs: 260, riseDistancePx: 100, lifeMs: 1900, spreadX: 55 }),
    burst: makeParticleBurst('🧁', 16),
  },
  {
    id: 'effect-donut',       name: 'Donuts',      iconEmoji: '🍩', rarity: 'uncommon',
    apply: makeParticles({ emoji: '🍩', size: 16, spawnIntervalMs: 260, riseDistancePx: 100, lifeMs: 1900, spreadX: 55 }),
    burst: makeParticleBurst('🍩', 16),
  },

  // Cosmic / magical
  {
    id: 'effect-dizzy',       name: 'Dizzy Stars', iconEmoji: '💫', rarity: 'uncommon',
    apply: makeParticles({ emoji: '💫', size: 14, spawnIntervalMs: 200, riseDistancePx: 95, lifeMs: 1700, spreadX: 60, wobbleX: 18 }),
    burst: makeParticleBurst('💫', 14),
  },
  {
    id: 'effect-glow-star',   name: 'Glow Stars',  iconEmoji: '🌟', rarity: 'rare',
    apply: makeParticles({ emoji: '🌟', size: 16, spawnIntervalMs: 230, riseDistancePx: 100, lifeMs: 1900, spreadX: 60 }),
    burst: makeParticleBurst('🌟', 16),
  },
  {
    id: 'effect-diamond',     name: 'Diamonds',    iconEmoji: '💎', rarity: 'legendary',
    apply: makeParticles({ emoji: '💎', size: 16, spawnIntervalMs: 300, riseDistancePx: 100, lifeMs: 2000, spreadX: 55 }),
    burst: makeParticleBurst('💎', 16),
  },

  // Cat-themed
  {
    id: 'effect-paws',        name: 'Paw Prints',  iconEmoji: '🐾', rarity: 'common',
    apply: makeParticles({ emoji: '🐾', size: 14, spawnIntervalMs: 220, riseDistancePx: 90, lifeMs: 1700, spreadX: 50 }),
    burst: makeParticleBurst('🐾', 14),
  },
  {
    id: 'effect-fish',        name: 'Fish',        iconEmoji: '🐟', rarity: 'rare',
    apply: makeParticles({ emoji: '🐟', size: 16, spawnIntervalMs: 260, riseDistancePx: 100, lifeMs: 1900, spreadX: 60, wobbleX: 14 }),
    burst: makeParticleBurst('🐟', 16),
  },
  {
    id: 'effect-bird',        name: 'Birds',       iconEmoji: '🐦', rarity: 'rare',
    apply: makeParticles({ emoji: '🐦', size: 14, spawnIntervalMs: 280, riseDistancePx: 110, lifeMs: 2000, spreadX: 70, wobbleX: 18 }),
    burst: makeParticleBurst('🐦', 14),
  },

  // Charm
  {
    id: 'effect-balloon',     name: 'Balloons',    iconEmoji: '🎈', rarity: 'common',
    apply: makeParticles({ emoji: '🎈', size: 16, spawnIntervalMs: 280, riseDistancePx: 110, lifeMs: 2100, spreadX: 55, wobbleX: 10 }),
    burst: makeParticleBurst('🎈', 16),
  },
  {
    id: 'effect-crown',       name: 'Crowns',      iconEmoji: '👑', rarity: 'legendary',
    apply: makeParticles({ emoji: '👑', size: 16, spawnIntervalMs: 320, riseDistancePx: 100, lifeMs: 2000, spreadX: 55 }),
    burst: makeParticleBurst('👑', 16),
  },

  // ---------------------------------------------------------------------
  // Tim's 2026-06-30 emoji batch — 94 effects, all `common` rarity,
  // default cadence via emojiEffect(). Skipped: 🍀 ✨ ⚡️ ❄️ 🎈 🍩 already
  // in registry above; 🛘 + 🫯 don't render reliably in Reddit's webview.
  // Re-tune individual entries by swapping to a full literal.
  // ---------------------------------------------------------------------
  emojiEffect('effect-poo',              'Poo',                '💩'),
  emojiEffect('effect-robot',            'Robot',              '🤖'),
  emojiEffect('effect-clown',            'Clown',              '🤡'),
  emojiEffect('effect-pumpkin',          'Jack-O-Lantern',     '🎃'),
  emojiEffect('effect-devil',            'Devil',              '😈'),
  emojiEffect('effect-ogre',             'Ogre',               '👹'),
  emojiEffect('effect-cursing',          'Cursing',            '🤬'),
  emojiEffect('effect-cold',             'Cold Face',          '🥶'),
  emojiEffect('effect-heart-eyes',       'Heart Eyes',         '😍'),
  emojiEffect('effect-smile',            'Smile',              '😊'),
  emojiEffect('effect-cat-face',         'Cat Face',           '🐱'),
  emojiEffect('effect-dragon',           'Dragon',             '🐉', 16),
  emojiEffect('effect-daisy',            'Daisy',              '🌼'),
  emojiEffect('effect-new-moon-face',    'New Moon Face',      '🌚'),
  emojiEffect('effect-rock',             'Rock',               '🪨'),
  emojiEffect('effect-lotus',            'Lotus',              '🪷'),
  emojiEffect('effect-hibiscus',         'Hibiscus',           '🌺'),
  emojiEffect('effect-boom',             'Boom',               '💥', 16),
  emojiEffect('effect-sweat',            'Sweat',              '💦'),
  emojiEffect('effect-droplet',          'Droplet',            '💧'),
  emojiEffect('effect-peach',            'Peach',              '🍑'),
  emojiEffect('effect-watermelon',       'Watermelon',         '🍉'),
  emojiEffect('effect-strawberry',       'Strawberry',         '🍓'),
  emojiEffect('effect-cheese',           'Cheese',             '🧀'),
  emojiEffect('effect-egg',              'Egg',                '🥚'),
  emojiEffect('effect-butter',           'Butter',             '🧈'),
  emojiEffect('effect-pizza',            'Pizza',              '🍕', 16),
  emojiEffect('effect-shrimp',           'Shrimp',             '🍤'),
  emojiEffect('effect-dumpling',         'Dumpling',           '🥟'),
  emojiEffect('effect-lollipop',         'Lollipop',           '🍭'),
  emojiEffect('effect-bubble-tea',       'Bubble Tea',         '🧋'),
  emojiEffect('effect-beer',             'Beer',               '🍻', 16),
  emojiEffect('effect-cocktail',         'Cocktail',           '🍸'),
  emojiEffect('effect-popcorn',          'Popcorn',            '🍿'),
  emojiEffect('effect-ice',              'Ice Cube',           '🧊'),
  emojiEffect('effect-soccer',           'Soccer',             '⚽️'),
  emojiEffect('effect-basketball',       'Basketball',         '🏀'),
  emojiEffect('effect-baseball',         'Baseball',           '⚾️'),
  emojiEffect('effect-football',         'Football',           '🏈'),
  emojiEffect('effect-volleyball',       'Volleyball',         '🏐'),
  emojiEffect('effect-softball',         'Softball',           '🥎'),
  emojiEffect('effect-tennis',           'Tennis',             '🎾'),
  emojiEffect('effect-rugby',            'Rugby',              '🏉'),
  emojiEffect('effect-eightball',        '8 Ball',             '🎱'),
  emojiEffect('effect-boxing',           'Boxing',             '🥊'),
  emojiEffect('effect-skateboard',       'Skateboard',         '🛹'),
  emojiEffect('effect-trophy',           'Trophy',             '🏆', 16),
  emojiEffect('effect-rosette',          'Rosette',            '🏵️'),
  emojiEffect('effect-die',              'Die',                '🎲'),
  emojiEffect('effect-ambulance',        'Ambulance',          '🚑', 16),
  emojiEffect('effect-car',              'Car',                '🚗', 16),
  emojiEffect('effect-suv',              'SUV',                '🚙', 16),
  emojiEffect('effect-airplane',         'Airplane',           '✈️', 16),
  emojiEffect('effect-helicopter',       'Helicopter',         '🚁', 16),
  emojiEffect('effect-moai',             'Moai',               '🗿', 16),
  emojiEffect('effect-cd',               'CD',                 '💿'),
  emojiEffect('effect-phone',            'Phone',              '📞'),
  emojiEffect('effect-lightbulb',        'Lightbulb',          '💡'),
  emojiEffect('effect-cash-wings',       'Flying Cash',        '💸', 16),
  emojiEffect('effect-dollar-bill',      'Dollar Bill',        '💵', 16),
  emojiEffect('effect-yen-bill',         'Yen Bill',           '💴', 16),
  emojiEffect('effect-euro-bill',        'Euro Bill',          '💶', 16),
  emojiEffect('effect-pound-bill',       'Pound Bill',         '💷', 16),
  emojiEffect('effect-money-bag',        'Money Bag',          '💰', 16),
  emojiEffect('effect-coin',             'Coin',               '🪙'),
  emojiEffect('effect-bomb',             'Bomb',               '💣'),
  emojiEffect('effect-pill',             'Pill',               '💊'),
  emojiEffect('effect-blood',            'Blood Drop',         '🩸'),
  emojiEffect('effect-microbe',          'Microbe',            '🦠'),
  emojiEffect('effect-gift',             'Gift',               '🎁', 16),
  emojiEffect('effect-party-popper',     'Party Popper',       '🎉', 16),
  emojiEffect('effect-disco-ball',       'Disco Ball',         '🪩'),
  emojiEffect('effect-confetti',         'Confetti',           '🎊'),
  emojiEffect('effect-pinata',           'Pinata',             '🪅'),
  emojiEffect('effect-fan',              'Hand Fan',           '🪭'),
  emojiEffect('effect-carp-streamer',    'Carp Streamer',      '🎏'),
  emojiEffect('effect-pink-heart',       'Pink Heart',         '🩷'),
  emojiEffect('effect-burning-heart',    'Burning Heart',      '❤️‍🔥', 16),
  emojiEffect('effect-black-heart',      'Black Heart',        '🖤'),
  emojiEffect('effect-beating-heart',    'Beating Heart',      '💓'),
  emojiEffect('effect-mending-heart',    'Mending Heart',      '❤️‍🩹', 16),
  emojiEffect('effect-sparkling-heart',  'Sparkling Heart',    '💖'),
  emojiEffect('effect-heart-arrow',      'Heart Arrow',        '💘'),
  emojiEffect('effect-cross',            'Cross Mark',         '❌'),
  emojiEffect('effect-circle',           'Circle Mark',        '⭕️'),
  emojiEffect('effect-no-smoking',       'No Smoking',         '🚭'),
  emojiEffect('effect-hundred',          '100',                '💯', 16),
  emojiEffect('effect-bangbang',         '!?',                 '⁉️'),
  emojiEffect('effect-check',            'Check',              '✅'),
  emojiEffect('effect-top',              'Top',                '🔝'),
  emojiEffect('effect-dollar-sign',      'Dollar Sign',        '💲'),
  emojiEffect('effect-soon',             'Soon',               '🔜'),
  emojiEffect('effect-flag-ca',          'Canada Flag',        '🇨🇦', 16),
  emojiEffect('effect-flag-tw',          'Taiwan Flag',        '🇹🇼', 16),
];

/** Fast lookup by id. */
export const CAT_EFFECT_BY_ID: Record<string, CatEffect> = Object.fromEntries(
  CAT_EFFECTS.map((e) => [e.id, e]),
);

// ---------------------------------------------------------------------------
// Metadata-driven effect catalog (Tim 2026-06-30 batch — 440 new effects
// generated from the effects smoketest). These live in the generated
// `src/shared/effect-catalog-gen.ts`; the runtime interpreter renders each
// via Phaser Graphics + tweens on demand. Backward-compat: the existing
// hand-authored CAT_EFFECTS above still ships identically; new effects are
// looked up via getEffectById() below.
// ---------------------------------------------------------------------------
import { NEW_EFFECT_CATALOG, type EffectMeta, type EffectCategory } from '@/shared/effect-catalog-gen';
import { makeCatEffectFromMeta } from './effect-interpreter';

const NEW_EFFECT_BY_ID: Record<string, CatEffect> = {};
for (const meta of NEW_EFFECT_CATALOG) {
  NEW_EFFECT_BY_ID[meta.id] = makeCatEffectFromMeta(meta);
}

/**
 * Effects removed via the effects-game review tool (Tim, 2026-07-02 round 1:
 * rainbow stagelight + the whole "Ring of X" family — "too similar to our
 * orbits"). Filtered from every lookup below so they can't be equipped,
 * browsed, or rendered; instances already granted to players resolve to
 * undefined and the isEffectCosmeticId guards keep them off the sprite
 * paths. TODO when the generated-catalog grant loop lands in
 * src/shared/state.ts: filter DELETED_EFFECT_IDS there too so fresh player
 * states stop receiving them.
 */
export const DELETED_EFFECT_IDS = new Set<string>([
  'effect-rainbow-glow',
  'effect-halo-ring-of-dots',
  'effect-halo-ring-of-fire',
  'effect-halo-dots-blue',
  'effect-halo-dots-pink',
  'effect-halo-dots-green',
  'effect-halo-dots-rainbow',
  'effect-halo-dots-gold',
  'effect-halo-dots-red',
  'effect-halo-dots-purple',
  'effect-halo-dots-cyan',
  'effect-halo-dots-white',
  'effect-halo-dots-neon',
]);

/** Return a CatEffect for any id — hand-authored or metadata-driven. */
export function getEffectById(id: string): CatEffect | undefined {
  if (DELETED_EFFECT_IDS.has(id)) return undefined;
  return CAT_EFFECT_BY_ID[id] ?? NEW_EFFECT_BY_ID[id];
}

/** All effect ids the player can equip. */
export function getAllEffectIds(): string[] {
  return [
    ...CAT_EFFECTS.map((e) => e.id),
    ...NEW_EFFECT_CATALOG.map((m) => m.id),
  ].filter((id) => !DELETED_EFFECT_IDS.has(id));
}

/** Metadata for grid rendering (id/name/iconEmoji/rarity/category). */
export interface EffectGridEntry {
  id: string;
  name: string;
  iconEmoji: string;
  rarity: 'common' | 'uncommon' | 'rare' | 'legendary';
  category: EffectCategory;
}

/** Bucket every equippable effect into its display category. */
export function getEffectGridEntries(): EffectGridEntry[] {
  const legacyCat = (id: string): EffectCategory => {
    // The 132 hand-authored effects fall into 3 top-level categories.
    if (id.endsWith('-glow')) return 'Stagelights (live)';
    if (id === 'effect-ghost') return 'Misc / Extras';
    return 'Orbiters';   // emoji particles + stars/hearts read as orbiter-style
  };
  const out: EffectGridEntry[] = [];
  for (const e of CAT_EFFECTS) {
    if (DELETED_EFFECT_IDS.has(e.id)) continue;
    out.push({
      id: e.id, name: e.name, iconEmoji: e.iconEmoji,
      rarity: e.rarity, category: legacyCat(e.id),
    });
  }
  for (const m of NEW_EFFECT_CATALOG) {
    if (DELETED_EFFECT_IDS.has(m.id)) continue;
    out.push({
      id: m.id, name: m.name, iconEmoji: m.iconEmoji,
      rarity: m.rarity, category: m.category,
    });
  }
  return out;
}

/** Convenience for catalog filtering. Deliberately TRUE for deleted
 *  effects — "this id is effect-shaped" — so sprite/cosmetic code paths
 *  skip them instead of hunting for a nonexistent atlas frame. */
export function isEffectCosmeticId(id: string): boolean {
  return DELETED_EFFECT_IDS.has(id) || id in CAT_EFFECT_BY_ID || id in NEW_EFFECT_BY_ID;
}
