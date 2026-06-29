import * as Phaser from 'phaser';
import { Scene, Scenes, GameObjects } from 'phaser';
import { AssetKeys } from '@/constants/assets';
import { Balance } from '@/constants/balance';
import { hslToInt } from '@/util/color';
import type { CatBreed, CatAnimationState, CatModel, CosmeticId } from '@/types/game';
import { COSMETIC_CATALOG } from '@/../shared/state';
import { CAT_EFFECT_BY_ID, type EffectHandle } from '@/effects/cat-effects';

// Cosmetic sprites are drawn on the same 91×64 canvas as the cats, so
// when both share origin (0.5, 1) at the same screen position they
// overlay perfectly. Phaser's trimmed-atlas handling translates each
// trimmed crop back to its original canvas position internally.

// We don't have dedicated atlas frames for the legendary 'rainbow' cat —
// it borrows another breed's frames and cycles its tint through hues. The
// chosen render breed should have idle/lick/meow/sleep/stretch/hiss/happy
// since that's what scenes ask for, and cat6 has the most complete set.
const RAINBOW_RENDER_BREED: CatBreed = 'cat6';
const RAINBOW_CYCLE_MS = 3000;

/** End-round celebration step rotation. Cats cycle through these so the
 *  post-round stage reads as "happy crowd" rather than a single frozen
 *  pose. Breeds without `happy` frames silently skip that step. Each
 *  step plays its animation through ANIMATION_REPEATS_PER_STEP full
 *  loops before handing off to the next — animation-completion driven
 *  instead of a wall-clock timer so the transition lands on a clean
 *  frame boundary (no mid-meow cut to lick that reads as a jump). */
const CELEBRATION_CYCLE: CatAnimationState[] = ['lick', 'meow', 'happy'];
const ANIMATION_REPEATS_PER_STEP = 1;
/** Time spent on a brief idle pose between celebration steps. Gives the
 *  cat a beat to "reset" before the next animation kicks in so the
 *  paw-down → mouth-open transition doesn't read as a jump cut. */
const CELEBRATION_BRIDGE_MS = 280;
/** How often the equipped effect pulses brighter during the celebration.
 *  Each pulse spikes intensity to HIT then decays back to REST over
 *  ~600 ms, so a 1.1 s interval produces a "normal → pronounced →
 *  normal → pronounced" rhythm the player can clearly see. */
const CELEBRATION_PULSE_MS = 1100;
/** How many leading frames the meow animation skips at create time so
 *  the closed-eye anticipation doesn't play. Applied both to the
 *  Phaser anim's frame list AND to the per-frame cosmetic offset
 *  lookup so static cosmetics don't drift by N frames during meow. */
const MEOW_FRAME_SHIFT = 2;

/**
 * Pull the parent cosmetic id out of a tint variant's sourceFrame string
 * (`cosmetic_<parent>_idle_00`). Returns null for base cosmetics — they
 * render from their own atlas frames.
 */
export function parentIdFor(entry: { sourceFrame?: string } | undefined): string | null {
  const sf = entry?.sourceFrame;
  if (!sf) return null;
  const match = sf.match(/^cosmetic_(c\d+)_/);
  return match ? match[1]! : null;
}

/**
 * Phaser sprite wrapper around a CatModel.
 *
 * Animations are registered globally (in the scene's anims manager) the first
 * time a cat needs them. Frame names follow the convention
 * `${breed}_${animation}_${frameIndex:02d}` produced by the asset extractor.
 *
 * If a requested animation has no frames in the atlas (e.g. 'happy' is missing
 * for cat1/cat2/cat3), the sprite holds its current frame and logs a warning.
 */
export class Cat {
  readonly sprite: GameObjects.Sprite;
  /**
   * Cosmetic sprites keyed by slot ('head' / 'neck' / 'body' / etc). Each
   * slot independently renders one cosmetic sprite stacked on the cat. We
   * own them as a plain object instead of a Container so position-syncing
   * via POST_UPDATE keeps working without an extra parent.
   */
  private cosmeticSprites: Record<string, GameObjects.Sprite> = {};
  /** Per-slot anchor: the canvas-space center of the cosmetic's idle_00
   *  art. Cached at setCosmetic time so syncOneCosmetic can position the
   *  sprite without re-querying the atlas every frame. The calibrator's
   *  offsetX/offsetY describe where the art CENTER should land relative
   *  to a fixed reference; we use this cached value to compute the shift
   *  between actual and target. See syncOneCosmetic for the math. */
  private cosmeticAnchors: Record<string, { artCenterX: number; artCenterY: number }> = {};
  /** Last frame-offset successfully applied per slot. Falls back to this
   *  when the cat's current animation has no entry in the offsets
   *  table — keeps static cosmetics from snapping to cat-center on
   *  unmapped anims (e.g. `happy`, which isn't in the offsets json). */
  private lastCosmeticOffset: Record<string, [number, number]> = {};
  /** Active effect-cosmetic handles keyed by slot. Effects don't render a
   *  sprite — they hold tweens, preFX, or particle timers. */
  private activeEffects: Record<string, EffectHandle> = {};
  private readonly postUpdate: () => void;
  private rainbowTween: Phaser.Tweens.Tween | null = null;
  private revertTimer: Phaser.Time.TimerEvent | undefined;
  private celebrating = false;
  private celebrationStep = 0;
  private celebrationPulseTimer: Phaser.Time.TimerEvent | undefined;
  /** Cached resting scale (from model.scale). Animations multiply this so a
   *  1.4× cat doesn't snap back to 1× when playIdle / playMeow tween scaleX. */
  private readonly baseScale: number;
  /** Per-frame translation offsets per cat breed + animation, loaded from
   *  `public/assets/atlas/cat-frame-offsets.json`. Static cosmetics (the
   *  ones uploaded via the quick-add tool — single-frame animations)
   *  ride these so they bob with the cat without their own per-frame art.
   *  Empty {} when the JSON didn't load — falls back to a no-op. */
  private readonly frameOffsets: Record<string, Record<string, [number, number][]>>;

  constructor(
    private readonly scene: Scene,
    public readonly model: CatModel,
  ) {
    this.baseScale = model.scale ?? 1;
    this.frameOffsets = (scene.cache.json.get(AssetKeys.Json.CatFrameOffsets) ?? {}) as Record<
      string,
      Record<string, [number, number][]>
    >;
    const initialFrame = Cat.frameName(model.breed, model.animation, 0);
    this.sprite = scene.add.sprite(0, 0, AssetKeys.Atlas.Cats, initialFrame);
    this.sprite.setOrigin(0.5, 1);
    if (this.baseScale !== 1) this.sprite.setScale(this.baseScale);
    this.ensureAnimation(model.breed, model.animation);
    this.playAnimation(model.animation);

    // Guard: verify all three reactive animation keys exist so missing-anim
    // bugs surface at scene-creation time rather than silently at first hit/miss.
    for (const anim of ['idle', 'happy', 'hiss'] as const) {
      const key = `${model.breed}_${anim}`;
      if (!this.scene.anims.exists(key)) {
        // eslint-disable-next-line no-console
        console.error(`[Cat] missing animation: ${key} — playback will be silent until Boot registers it`);
      }
    }

    // Cosmetic follows the cat sprite each frame so tweens on `sprite` (e.g.
    // the petting handoff slide-to-center) carry the accessory along. We
    // could parent via a Container but that would change `cat.sprite`'s
    // type, and callers like Game.ts reach in to set depth on it directly.
    this.postUpdate = () => this.syncCosmeticPosition();
    this.scene.events.on(Scenes.Events.POST_UPDATE, this.postUpdate);

    if (model.breed === 'rainbow') {
      this.startRainbowCycle();
    }

    if (model.equippedCosmetics) {
      this.setCosmetics(model.equippedCosmetics);
    }
  }

  setPosition(x: number, y: number): void {
    this.sprite.setPosition(x, y);
    this.syncCosmeticPosition();
  }

  setAnimation(animation: CatAnimationState): void {
    this.model.animation = animation;
    this.ensureAnimation(this.model.breed, animation);
    this.playAnimation(animation);
  }

  /**
   * Equip / un-equip a cosmetic in one slot. Passing `null` removes the
   * cosmetic currently in that slot. Each slot owns its own sprite stacked
   * over the cat.
   */
  setCosmetic(slot: string, cosmeticId: CosmeticId | null): void {
    if (!this.model.equippedCosmetics) this.model.equippedCosmetics = {};

    // Always tear down whatever currently occupies this slot first — either
    // a sprite-based cosmetic or an effect handle.
    this.cosmeticSprites[slot]?.destroy();
    delete this.cosmeticSprites[slot];
    this.activeEffects[slot]?.destroy();
    delete this.activeEffects[slot];

    if (!cosmeticId) {
      delete this.model.equippedCosmetics[slot];
      return;
    }

    this.model.equippedCosmetics[slot] = cosmeticId;

    // EFFECT cosmetics are code-driven flair, not atlas sprites. Apply via
    // the registered handler and stash the handle. Pass the cat's render
    // scale so flame width / particle size / spread amplify when seated
    // cats are scaled up (Game scene seats at 1.4×, DressingRoom at 1×).
    const effect = CAT_EFFECT_BY_ID[cosmeticId];
    if (effect) {
      this.activeEffects[slot] = effect.apply(this.scene, this.sprite, this.sprite.scaleX);
      return;
    }

    // Tint variants (sourceFrame + tint) render the parent's atlas frames
    // and apply the tint via setTint(). Animation keys are keyed on the
    // SOURCE id so variants share their parent's animation entries.
    const entry = COSMETIC_CATALOG.find((c) => c.id === cosmeticId);
    const renderId = parentIdFor(entry) ?? cosmeticId;
    const idleFrame = `cosmetic_${renderId}_idle_00`;
    let sprite = this.cosmeticSprites[slot];
    if (!sprite) {
      sprite = this.scene.add.sprite(0, 0, AssetKeys.Atlas.Cosmetics, idleFrame);
      sprite.setOrigin(0.5, 1); // match cat — bottom-center anchor
      this.cosmeticSprites[slot] = sprite;
    } else {
      sprite.setTexture(AssetKeys.Atlas.Cosmetics, idleFrame);
    }
    // Cache where the cosmetic's idle_00 art is centered in its canvas.
    // syncOneCosmetic uses this every frame to compute the screen
    // position so the art CENTER lands at the catalog-specified target.
    //
    // Phaser 4's Frame API exposes the trim rectangle directly:
    //   frame.x, frame.y       = spriteSourceSize.x/y (canvas offset)
    //   frame.width, frame.height = trimmed dimensions (sourceSize.w/h)
    // The older `frame.data.spriteSourceSize` path doesn't exist in v4,
    // so reading from it returned undefined and the fallback collapsed
    // the anchor to the trim half-size — wrong in-game offsets even though
    // the dressing-room renderer (which bypasses this math) looked fine.
    const idleTextureFrame = this.scene.textures.get(AssetKeys.Atlas.Cosmetics).get(idleFrame);
    this.cosmeticAnchors[slot] = {
      artCenterX: idleTextureFrame.x + idleTextureFrame.width / 2,
      artCenterY: idleTextureFrame.y + idleTextureFrame.height / 2,
    };
    if (entry?.tint) {
      const colorInt = parseInt(entry.tint.replace('#', ''), 16);
      sprite.setTint(colorInt);
    } else {
      sprite.clearTint();
    }
    this.playCosmeticAnimationForSlot(slot, cosmeticId, this.model.animation);
    this.syncOneCosmetic(slot, sprite);
  }

  /** Replace ALL cosmetics in one shot — clears anything not in the map. */
  setCosmetics(map: Partial<Record<string, CosmeticId>>): void {
    const incomingSlots = new Set(Object.keys(map));
    // Both sprite-based AND effect-based slots need clearing when absent.
    const liveSlots = new Set([
      ...Object.keys(this.cosmeticSprites),
      ...Object.keys(this.activeEffects),
    ]);
    for (const slot of liveSlots) {
      if (!incomingSlots.has(slot)) this.setCosmetic(slot, null);
    }
    for (const [slot, cosId] of Object.entries(map)) {
      this.setCosmetic(slot, cosId ?? null);
    }
  }

  /** Trigger a brief intensity spike on every equipped EFFECT cosmetic
   *  — called from Game on a successful lane tap so the cat's aura /
   *  particles surge. Handles without a pulseHit (legacy effects like
   *  ghost) just skip the call. */
  pulseEffectHit(): void {
    for (const handle of Object.values(this.activeEffects)) {
      handle.pulseHit?.();
    }
  }

  /** Mirror of pulseEffectHit for a missed note — dims the effect
   *  briefly so the lane visually registers the failure. */
  pulseEffectMiss(): void {
    for (const handle of Object.values(this.activeEffects)) {
      handle.pulseMiss?.();
    }
  }

  playHappy(durationMs = 500): void {
    this.cancelRevert();
    const key = `${this.model.breed}_happy`;
    if (this.scene.anims.exists(key)) {
      this.sprite.play({ key, repeat: 0 });
    }
    const s = this.baseScale * 1.1;
    this.scene.tweens.add({ targets: this.sprite, scaleX: s, scaleY: s, duration: 120, yoyo: false });
    this.sprite.setTint(0x9fffd4);
    this.revertTimer = this.scene.time.delayedCall(durationMs, () => this.playIdle());
  }

  playAngry(durationMs = 500): void {
    this.cancelRevert();
    const key = `${this.model.breed}_hiss`;
    if (this.scene.anims.exists(key)) {
      this.sprite.play({ key, repeat: 0 });
    }
    const s = this.baseScale * 0.95;
    this.scene.tweens.add({ targets: this.sprite, scaleX: s, scaleY: s, duration: 120, yoyo: false });
    this.sprite.setTint(0xff9aa0);
    this.revertTimer = this.scene.time.delayedCall(durationMs, () => this.playIdle());
  }

  /** Play the breed's meow animation — used by Game scene when a rhythm
   *  note is hit. Falls back gracefully if the breed has no meow frames. */
  playMeow(durationMs = 500): void {
    this.cancelRevert();
    const key = `${this.model.breed}_meow`;
    if (this.scene.anims.exists(key)) {
      this.sprite.play({ key, repeat: 0 });
    }
    const s = this.baseScale * 1.08;
    this.scene.tweens.add({ targets: this.sprite, scaleX: s, scaleY: s, duration: 120, yoyo: false });
    this.revertTimer = this.scene.time.delayedCall(durationMs, () => this.playIdle());
  }

  playIdle(): void {
    this.cancelRevert();
    const key = `${this.model.breed}_idle`;
    if (this.scene.anims.exists(key)) {
      this.sprite.play({ key });
    }
    this.scene.tweens.add({ targets: this.sprite, scaleX: this.baseScale, scaleY: this.baseScale, duration: 120 });
    this.sprite.clearTint();
  }

  /** Kick off an end-round celebration. Cats rotate through happy/lick/
   *  meow, advancing on each ANIMATION_COMPLETE so the swap always
   *  lands on a clean frame boundary. Cancels any pending transient
   *  revert so a cat that missed a note in the last 500 ms doesn't snap
   *  back to idle mid-celebration.
   *
   *  Idempotent — safe to call again while a celebration is already
   *  running; the active animation listener is torn down and a new
   *  cycle starts from step 0. */
  startCelebration(): void {
    this.cancelRevert();
    // Strip any in-flight celebration listener from a previous call so a
    // restart doesn't fire two step-advances on the next animation
    // completion. Celebration is the only consumer of this event on
    // the cat sprite, so blanket-clearing is safe.
    this.sprite.off(Phaser.Animations.Events.ANIMATION_COMPLETE);
    this.celebrating = true;
    this.celebrationStep = 0;
    // Kick off the equipped-effect pulse loop. pulseEffectHit fires the
    // intensity spike + decay, so a recurring timer produces a steady
    // alternation between resting and pronounced for the duration of
    // the celebration.
    this.celebrationPulseTimer?.remove(false);
    this.celebrationPulseTimer = this.scene.time.addEvent({
      delay: CELEBRATION_PULSE_MS,
      loop: true,
      startAt: CELEBRATION_PULSE_MS, // fire the first pulse immediately
      callback: () => this.pulseEffectHit(),
    });
    this.scene.tweens.add({
      targets: this.sprite,
      scaleX: this.baseScale,
      scaleY: this.baseScale,
      duration: 120,
    });
    this.sprite.clearTint();
    this.playCelebrationStep();
  }

  /** Play the current celebration step. The step's animation plays for
   *  (ANIMATION_REPEATS_PER_STEP + 1) loops, then ANIMATION_COMPLETE
   *  triggers a brief idle-pose bridge (CELEBRATION_BRIDGE_MS) before
   *  the next step kicks in. The idle bridge is what makes
   *  lick → meow feel like the cat puts its paw down first instead of
   *  snapping into meow mid-lick. */
  private playCelebrationStep(): void {
    if (!this.celebrating) return;
    // Find the next playable step, skipping any animation the breed has
    // no frames for. Bounded by the cycle length so we never loop
    // forever on a breed with zero matching frames.
    let tries = 0;
    while (tries < CELEBRATION_CYCLE.length) {
      const anim = CELEBRATION_CYCLE[this.celebrationStep]!;
      this.ensureAnimation(this.model.breed, anim);
      const key = Cat.animationKey(this.model.breed, anim);
      if (this.scene.anims.exists(key)) {
        this.sprite.play({ key, repeat: ANIMATION_REPEATS_PER_STEP });
        this.model.animation = anim;
        this.playCosmeticAnimation(anim);
        this.sprite.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => {
          if (!this.celebrating) return;
          this.bridgeToNextStep();
        });
        return;
      }
      this.celebrationStep = (this.celebrationStep + 1) % CELEBRATION_CYCLE.length;
      tries++;
    }
  }

  /** Play idle briefly between celebration steps so the cat visibly
   *  returns to a neutral pose before the next animation. Idle is
   *  loop-able so we just play it then schedule the step advance. */
  private bridgeToNextStep(): void {
    if (!this.celebrating) return;
    const idleKey = Cat.animationKey(this.model.breed, 'idle');
    this.ensureAnimation(this.model.breed, 'idle');
    if (this.scene.anims.exists(idleKey)) {
      this.sprite.play(idleKey, true);
      this.playCosmeticAnimation('idle');
    }
    this.scene.time.delayedCall(CELEBRATION_BRIDGE_MS, () => {
      if (!this.celebrating) return;
      this.celebrationStep = (this.celebrationStep + 1) % CELEBRATION_CYCLE.length;
      this.playCelebrationStep();
    });
  }

  /** Snap the sprite to a specific frame of the meow animation and stop
   *  any running anim so the cat HOLDS that frame. Used by the publish
   *  snapshot path — looping meow + 120 ms snapshot delay lands on an
   *  arbitrary frame (often the closed-mouth or eyes-down frame) which
   *  doesn't read as "performing." Picking the middle frame of meow
   *  reliably captures mouth-open, eyes-open. Returns true if a frame
   *  was set, false if the breed has no meow frames in the atlas.
   */
  freezeMeowFrame(): boolean {
    this.cancelRevert();
    this.stopCelebration();
    const renderBreed = Cat.renderBreed(this.model.breed);
    const atlas = this.scene.textures.get(AssetKeys.Atlas.Cats);
    const prefix = `${renderBreed}_meow_`;
    // Get all meow frame names (already sliced down by MEOW_FRAME_SHIFT
    // during ensureAnimation, but raw atlas still has all). Pick the
    // middle-of-cycle frame so we get max mouth-open expressiveness.
    const frameNames = atlas.getFrameNames()
      .filter((n) => n.startsWith(prefix))
      .sort();
    if (frameNames.length === 0) return false;
    const midIdx = Math.floor((frameNames.length + MEOW_FRAME_SHIFT) / 2);
    const targetFrame = frameNames[Math.min(midIdx, frameNames.length - 1)]!;
    this.sprite.anims.stop();
    this.sprite.setFrame(targetFrame);
    this.model.animation = 'meow';
    return true;
  }

  /** Tear down the celebration loop — clears the recurring pulse timer,
   *  rips the ANIMATION_COMPLETE listener that drives bridgeToNextStep,
   *  flips celebrating off. Use this when something else needs to take
   *  over the sprite's animation surface (e.g. the publish-time snapshot
   *  poses cats into 'meow' but the celebration's listener would
   *  immediately bridge back to idle and override the pose). Safe to
   *  call when not celebrating — it's idempotent. */
  stopCelebration(): void {
    if (!this.celebrating && !this.celebrationPulseTimer) return;
    this.celebrating = false;
    this.celebrationPulseTimer?.remove(false);
    this.celebrationPulseTimer = undefined;
    this.sprite.off(Phaser.Animations.Events.ANIMATION_COMPLETE);
  }

  /** End-of-round disappointment — counterpart to startCelebration for a
   *  failed rehearsal. Cat holds a hissing loop with a sad tint and a
   *  recurring effect-dim pulse so its aura / particles visibly droop.
   *  No auto-revert; ends when the scene tears down. */
  startDisappointed(): void {
    this.cancelRevert();
    this.sprite.off(Phaser.Animations.Events.ANIMATION_COMPLETE);
    this.celebrating = false;
    this.celebrationPulseTimer?.remove(false);

    const idleKey = Cat.animationKey(this.model.breed, 'idle');
    const hissKey = Cat.animationKey(this.model.breed, 'hiss');
    this.ensureAnimation(this.model.breed, 'idle');
    this.ensureAnimation(this.model.breed, 'hiss');

    // Tim's note: the failure animation should READ as a transition
    // from bright/idle to dim/hiss, not just a snap into hiss.
    //   Phase 1 — idle, full color, normal scale for ~450 ms.
    //   Phase 2 — tween toward sad pink tint + slight shrink while
    //             swapping to hiss looped.
    if (this.scene.anims.exists(idleKey)) {
      this.sprite.play({ key: idleKey, repeat: -1 });
      this.model.animation = 'idle';
      this.playCosmeticAnimation('idle');
    }
    this.sprite.clearTint();
    this.scene.tweens.add({
      targets: this.sprite,
      scaleX: this.baseScale,
      scaleY: this.baseScale,
      duration: 120,
    });

    const transitionDelay = 450;
    this.scene.time.delayedCall(transitionDelay, () => {
      if (!this.scene) return;
      if (this.scene.anims.exists(hissKey)) {
        this.sprite.play({ key: hissKey, repeat: -1 });
        this.model.animation = 'hiss';
        this.playCosmeticAnimation('hiss');
      }
      // Fade the tint in over ~300 ms so the dimming reads as a
      // gradual mood shift rather than a flash.
      const targetTint = Phaser.Display.Color.IntegerToColor(0xff9aa0);
      const tintTween = { v: 0 };
      this.scene.tweens.add({
        targets: tintTween,
        v: 1,
        duration: 320,
        onUpdate: () => {
          const t = tintTween.v;
          const r = Math.round(255 * (1 - t) + targetTint.red * t);
          const g = Math.round(255 * (1 - t) + targetTint.green * t);
          const b = Math.round(255 * (1 - t) + targetTint.blue * t);
          this.sprite.setTint((r << 16) | (g << 8) | b);
        },
      });
      this.scene.tweens.add({
        targets: this.sprite,
        scaleX: this.baseScale * 0.95,
        scaleY: this.baseScale * 0.95,
        duration: 320,
      });
      // Start dimming the effect on a loop now that we've committed
      // to the disappointed pose. pulseEffectMiss reuses the per-tap
      // miss path so the aura / particles droop visibly.
      this.celebrationPulseTimer?.remove(false);
      this.celebrationPulseTimer = this.scene.time.addEvent({
        delay: CELEBRATION_PULSE_MS,
        loop: true,
        startAt: CELEBRATION_PULSE_MS,
        callback: () => this.pulseEffectMiss(),
      });
    });
  }

  private cancelRevert(): void {
    if (this.revertTimer) {
      this.revertTimer.remove(false);
      this.revertTimer = undefined;
    }
  }

  destroy(): void {
    this.cancelRevert();
    this.celebrating = false;
    this.celebrationPulseTimer?.remove(false);
    this.celebrationPulseTimer = undefined;
    // sprite.off without an event name pulls every listener including
    // the celebration's ANIMATION_COMPLETE chain — safer than tracking
    // the listener handle ourselves through cycle restarts.
    this.sprite.off(Phaser.Animations.Events.ANIMATION_COMPLETE);
    this.scene.events.off(Scenes.Events.POST_UPDATE, this.postUpdate);
    this.rainbowTween?.stop();
    this.rainbowTween?.remove();
    this.rainbowTween = null;
    for (const slot of Object.keys(this.cosmeticSprites)) {
      this.cosmeticSprites[slot]?.destroy();
    }
    this.cosmeticSprites = {};
    for (const slot of Object.keys(this.activeEffects)) {
      this.activeEffects[slot]?.destroy();
    }
    this.activeEffects = {};
    this.sprite.destroy();
  }

  private startRainbowCycle(): void {
    const state = { hue: 0 };
    this.rainbowTween = this.scene.tweens.add({
      targets: state,
      hue: 360,
      duration: RAINBOW_CYCLE_MS,
      repeat: -1,
      ease: 'Linear',
      onUpdate: () => {
        this.sprite.setTint(hslToInt(state.hue, 1, 0.65));
      },
    });
  }

  private syncCosmeticPosition(): void {
    let i = 1;
    for (const slot of Object.keys(this.cosmeticSprites)) {
      const sprite = this.cosmeticSprites[slot];
      if (!sprite) continue;
      this.syncOneCosmetic(slot, sprite, i++);
    }
  }

  private syncOneCosmetic(slot: string, sprite: GameObjects.Sprite, depthOffset = 1): void {
    sprite.setDepth(this.sprite.depth + depthOffset);

    const cosId = this.cosmeticIdForSlot(slot);
    const catalogEntry = cosId
      ? COSMETIC_CATALOG.find((c) => c.id === cosId)
      : undefined;

    // Catalog drives base placement. offsetX/offsetY/scale come from
    // the cosmetics calibrator and now describe REAL screen positioning,
    // not just a preview hint. See scripts/migrate-cosmetic-offsets.ts
    // for the migration script that filled these values in (computed
    // from each cosmetic's idle_00 atlas trim bounds so the runtime
    // baseline matches pre-migration rendering).
    const catalogOffsetX = catalogEntry?.offsetX ?? 0;
    const catalogOffsetY = catalogEntry?.offsetY ?? 0;
    const catalogScale = catalogEntry?.scale ?? 1;

    const catAnimKey = this.sprite.anims.currentAnim?.key;

    // Per-frame head tracking: applies to cosmetics that either (a) are
    // flagged `isStatic` (single-frame Quick Add uploads) or (b) lack
    // their own anim frames for the cat's current anim (so the runtime
    // would otherwise freeze them on the last idle frame while the cat
    // moves underneath — visually that reads as drift). Head/face slots
    // ride 1:1, neck/body slots ride a fraction (chest doesn't move 12px
    // when the head lifts during lick).
    let lacksOwnAnimFrames = false;
    if (cosId && catAnimKey) {
      const sepIdx = catAnimKey.indexOf('_');
      if (sepIdx > 0) {
        const anim = catAnimKey.slice(sepIdx + 1) as CatAnimationState;
        const renderId = parentIdFor(catalogEntry) ?? cosId;
        const cosKey = Cat.cosmeticAnimationKey(renderId, anim);
        lacksOwnAnimFrames = !this.scene.anims.exists(cosKey);
      }
    }
    let frameDx = 0;
    let frameDy = 0;
    if (catalogEntry?.isStatic || lacksOwnAnimFrames) {
      const frameIdx = this.sprite.anims.currentFrame?.index;
      let resolved: [number, number] | null = null;
      if (catAnimKey && typeof frameIdx === 'number') {
        const sepIdx = catAnimKey.indexOf('_');
        if (sepIdx > 0) {
          const breed = Cat.renderBreed(catAnimKey.slice(0, sepIdx));
          const anim = catAnimKey.slice(sepIdx + 1);
          const offsetIdx = anim === 'meow'
            ? frameIdx - 1 + MEOW_FRAME_SHIFT
            : frameIdx - 1;
          const off = this.frameOffsets[breed]?.[anim]?.[offsetIdx];
          if (off) {
            const strength = catalogEntry?.motionStrength ?? Cat.motionStrengthForSlot(slot);
            resolved = [off[0] * strength, off[1] * strength];
          }
        }
      }
      const fallback = resolved ?? this.lastCosmeticOffset[slot];
      if (fallback) {
        frameDx = fallback[0];
        frameDy = fallback[1];
      }
      if (resolved) this.lastCosmeticOffset[slot] = resolved;
    }

    // The math (sprite origin is 0.5, 1 — bottom-center of the 91×64 source canvas):
    //   The cat displays canvas pixel (cx, cy) at screen
    //     ( catX + (cx - 45.5) * catScale,
    //       catY + (cy - 64)   * catScale ).
    //   We want the cosmetic's art-center anchor to land at the screen
    //   position the cat WOULD render canvas pixel (targetX, targetY).
    //   Solving for cosmetic sprite position (its own origin 0.5, 1)
    //   when rendered at cosScale = catalogScale * catScale:
    //     cosX = catX + (target+frame - 45.5)*catScale − (anchor - 45.5)*cosScale
    //     cosY = catY + (target+frame - 64)*catScale   − (anchor - 64)*cosScale
    //   When catalogScale = 1 (cosScale = catScale) this collapses to
    //   `catPos + (target + frame - anchor) * catScale`, matching the
    //   pre-2429720 natural-position rendering whenever the catalog's
    //   offsetX/Y were left at the migrated trim-center defaults.
    //   When catalogScale ≠ 1 the two scale terms separate correctly so
    //   the cosmetic doesn't drift relative to the calibrator preview.
    const anchor = this.cosmeticAnchors[slot] ?? { artCenterX: 45, artCenterY: 32 };
    const targetX = Cat.CANVAS_HORIZONTAL_CENTER + catalogOffsetX;
    const targetY = Cat.CAT_HEAD_TOP_REF + catalogOffsetY;
    const catScale = this.sprite.scaleX;
    const cosScale = catalogScale * catScale;
    sprite.setScale(cosScale);
    sprite.setPosition(
      this.sprite.x
        + (targetX + frameDx - Cat.SOURCE_CANVAS_HALF_W) * catScale
        - (anchor.artCenterX - Cat.SOURCE_CANVAS_HALF_W) * cosScale,
      this.sprite.y
        + (targetY + frameDy - Cat.SOURCE_CANVAS_H) * catScale
        - (anchor.artCenterY - Cat.SOURCE_CANVAS_H) * cosScale,
    );
  }

  /** Reference cat head-top-Y in canvas coordinates. Calibrator + runtime
   *  + migration script all measure cosmetic offsetY against this value.
   *  Cat head tops vary 12-14px across breeds; using 12 as the anchor
   *  means cosmetics on cats with deeper head tops sit 0-2px low.
   *  Must match scripts/migrate-cosmetic-offsets.ts CAT_HEAD_TOP_REF.
   *  Public so DressingRoom can mirror the same math for its hero preview. */
  public static readonly CAT_HEAD_TOP_REF = 12;
  /** Canvas horizontal centerline for the 91-wide cosmetic/cat sprite.
   *  Match migration script's CANVAS_HORIZONTAL_CENTER. */
  public static readonly CANVAS_HORIZONTAL_CENTER = 45;
  /** Half-width of the 91×64 source canvas — used by syncOneCosmetic to
   *  resolve sprite positions relative to the bottom-center anchor that
   *  origin (0.5, 1) sets. 45.5 (not 45) is the actual midpoint of a
   *  91-wide canvas; CANVAS_HORIZONTAL_CENTER above is the integer
   *  catalog reference and stays 45 to keep migration values stable. */
  public static readonly SOURCE_CANVAS_HALF_W = 45.5;
  /** Source canvas height; cosmetic + cat sprites both use 91×64. */
  public static readonly SOURCE_CANVAS_H = 64;

  /** Get the cosmetic id equipped in the given slot, accounting for the
   *  equippedCosmetics map's slot keying. Returns null if nothing is
   *  equipped in that slot. */
  private cosmeticIdForSlot(slot: string): CosmeticId | null {
    return this.model.equippedCosmetics?.[slot] ?? null;
  }

  /** How strongly a cosmetic in this slot rides the cat's per-frame head
   *  motion. The offsets table tracks the TOP of the head's painted bounds,
   *  so 1.0 = move 1:1 with the head's crown. Lower values for items that
   *  sit further down the body, where the cat's actual chest/torso barely
   *  moves while the head can lift up to 12px during lick/meow. Setting
   *  these too high makes necklaces / collars jump off the chest onto the
   *  face. Per-cosmetic `motionStrength` override available in catalog. */
  private static motionStrengthForSlot(slot: string): number {
    switch (slot) {
      case 'head':
      case 'face':
        return 1.0;
      case 'neck':
        return 0.5;
      case 'body':
        return 0.2;
      default:
        return 0.6;
    }
  }

  private playAnimation(animation: CatAnimationState): void {
    const key = Cat.animationKey(this.model.breed, animation);
    if (this.scene.anims.exists(key)) {
      this.sprite.play(key, true);
    } else {
      // Hold whatever frame we have — no fallback animation in Phase 1.
      // Phase 2 may map missing animations to 'idle' when we add accessories.
    }
    this.playCosmeticAnimation(animation);
  }

  private playCosmeticAnimation(animation: CatAnimationState): void {
    const equipped = this.model.equippedCosmetics ?? {};
    for (const [slot, cosId] of Object.entries(equipped)) {
      if (!cosId) continue;
      this.playCosmeticAnimationForSlot(slot, cosId, animation);
    }
  }

  private playCosmeticAnimationForSlot(
    slot: string,
    cosmeticId: CosmeticId,
    animation: CatAnimationState,
  ): void {
    const sprite = this.cosmeticSprites[slot];
    if (!sprite) return;
    const entry = COSMETIC_CATALOG.find((c) => c.id === cosmeticId);
    const renderId = parentIdFor(entry) ?? cosmeticId;
    // isStatic cosmetics ignore per-anim atlas frames even if they exist —
    // pin to idle so syncOneCosmetic's per-frame offsets do all the
    // motion. Useful for cosmetics whose hand-drawn anim frames turned
    // out to be degenerate (e.g. 8 identical lick frames) where the
    // offset path tracks the cat better than the static art ever could.
    if (entry?.isStatic) {
      const idleKey = Cat.cosmeticAnimationKey(renderId, 'idle');
      this.ensureCosmeticAnimation(renderId, 'idle');
      if (this.scene.anims.exists(idleKey)) {
        sprite.play(idleKey, true);
      }
      return;
    }
    const key = Cat.cosmeticAnimationKey(renderId, animation);
    this.ensureCosmeticAnimation(renderId, animation);
    if (this.scene.anims.exists(key)) {
      sprite.play(key, true);
      return;
    }
    // No frames for the requested anim. Two bad alternatives exist:
    //   (a) snap to idle anim — the original "swap to idle" glitch
    //       (visible pop when idle frame 0 differs from mid-lick pose).
    //   (b) leave the cosmetic playing whatever it was on — produces a
    //       wrong-anim mismatch (cat is mid-meow but cosmetic is still
    //       looping its lick poses).
    // Compromise: STOP the cosmetic on its current frame, so it just
    // freezes in pose for the duration of the unsupported anim. No
    // snap, no continued wrong-anim playback. If nothing is currently
    // playing (fresh sprite), fall back to idle frame 0 as last resort.
    if (sprite.anims.isPlaying) {
      sprite.anims.stop();
      return;
    }
    const idleKey = Cat.cosmeticAnimationKey(renderId, 'idle');
    this.ensureCosmeticAnimation(renderId, 'idle');
    if (this.scene.anims.exists(idleKey)) {
      sprite.play(idleKey, true);
    }
  }

  private ensureAnimation(breed: CatBreed, animation: CatAnimationState): void {
    const key = Cat.animationKey(breed, animation);
    if (this.scene.anims.exists(key)) return;

    const renderBreed = Cat.renderBreed(breed);
    const atlas = this.scene.textures.get(AssetKeys.Atlas.Cats);
    const prefix = `${renderBreed}_${animation}_`;
    let frameNames = atlas
      .getFrameNames()
      .filter((n) => n.startsWith(prefix))
      .sort();

    if (frameNames.length === 0) {
      console.warn(`[cat] No frames for ${prefix} in cats atlas`);
      return;
    }

    // Every breed's meow_00 and meow_01 are anticipation frames where
    // the cat closes its eyes before bursting into the meow — visually
    // the eyes look black for ~285 ms (2 frames at the 7 fps cat rate)
    // and Tim called it out as "eyes turning black mid-animation."
    // Drop those two so the meow plays straight through with open eyes
    // matching the idle pose. The matching FRAME_INDEX_SHIFT below
    // keeps the cosmetic offset lookup in sync.
    if (animation === 'meow' && frameNames.length > MEOW_FRAME_SHIFT) {
      frameNames = frameNames.slice(MEOW_FRAME_SHIFT);
    }

    this.scene.anims.create({
      key,
      frames: frameNames.map((frame) => ({ key: AssetKeys.Atlas.Cats, frame })),
      frameRate: Balance.catAnimationFrameRate,
      repeat: animation === 'hiss' || animation === 'happy' ? 0 : -1,
    });
  }

  private ensureCosmeticAnimation(
    cosmeticId: CosmeticId,
    animation: CatAnimationState,
  ): void {
    const key = Cat.cosmeticAnimationKey(cosmeticId, animation);
    if (this.scene.anims.exists(key)) return;
    const atlas = this.scene.textures.get(AssetKeys.Atlas.Cosmetics);
    const prefix = `cosmetic_${cosmeticId}_${animation}_`;
    const frameNames = atlas
      .getFrameNames()
      .filter((n) => n.startsWith(prefix))
      .sort();
    if (frameNames.length === 0) return; // silently — caller falls back to idle

    this.scene.anims.create({
      key,
      frames: frameNames.map((frame) => ({ key: AssetKeys.Atlas.Cosmetics, frame })),
      frameRate: Balance.catAnimationFrameRate,
      repeat: animation === 'hiss' || animation === 'happy' ? 0 : -1,
    });
  }

  static animationKey(breed: CatBreed, animation: CatAnimationState): string {
    return `${breed}_${animation}`;
  }

  static cosmeticAnimationKey(
    cosmeticId: CosmeticId,
    animation: CatAnimationState,
  ): string {
    return `cosmetic_${cosmeticId}_${animation}`;
  }

  static frameName(
    breed: CatBreed,
    animation: CatAnimationState,
    frameIndex: number,
  ): string {
    const renderBreed = Cat.renderBreed(breed);
    return `${renderBreed}_${animation}_${String(frameIndex).padStart(2, '0')}`;
  }

  /** Some logical breeds don't have their own atlas frames (rainbow borrows
   *  cat6's). Anywhere we need to load a frame, use this. */
  static renderBreed(breed: CatBreed): CatBreed {
    return breed === 'rainbow' ? RAINBOW_RENDER_BREED : breed;
  }
}
