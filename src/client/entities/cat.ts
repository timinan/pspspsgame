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
  /** Active effect-cosmetic handles keyed by slot. Effects don't render a
   *  sprite — they hold tweens, preFX, or particle timers. */
  private activeEffects: Record<string, EffectHandle> = {};
  private readonly postUpdate: () => void;
  private rainbowTween: Phaser.Tweens.Tween | null = null;
  private revertTimer: Phaser.Time.TimerEvent | undefined;
  private celebrating = false;
  private celebrationStep = 0;
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
   *  (ANIMATION_REPEATS_PER_STEP + 1) loops then fires
   *  ANIMATION_COMPLETE, which advances us to the next step. Steps the
   *  breed has no frames for are skipped so legacy breeds without
   *  `happy` fall through to whatever they DO have. */
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
          this.celebrationStep = (this.celebrationStep + 1) % CELEBRATION_CYCLE.length;
          this.playCelebrationStep();
        });
        return;
      }
      this.celebrationStep = (this.celebrationStep + 1) % CELEBRATION_CYCLE.length;
      tries++;
    }
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
    sprite.setScale(this.sprite.scaleX);
    sprite.setDepth(this.sprite.depth + depthOffset);

    let dx = 0;
    let dy = 0;

    // The cat's per-frame translation offset is applied ONLY to cosmetics
    // that are explicitly marked `isStatic` in the catalog (set by the
    // Cosmetic Quick Add upload flow). Hand-animated cosmetics (c1–c43)
    // keep their per-frame art driving their motion — this branch is a
    // strict no-op for them.
    const cosId = this.cosmeticIdForSlot(slot);
    const catalogEntry = cosId
      ? COSMETIC_CATALOG.find((c) => c.id === cosId)
      : undefined;
    if (catalogEntry?.isStatic) {
      const catAnimKey = this.sprite.anims.currentAnim?.key;
      const frameIdx = this.sprite.anims.currentFrame?.index;
      if (catAnimKey && typeof frameIdx === 'number') {
        // Animation key shape: "<breed>_<anim>". Use renderBreed so rainbow
        // (which uses cat6's frames) resolves to cat6 in the offsets table.
        const sepIdx = catAnimKey.indexOf('_');
        if (sepIdx > 0) {
          const breed = Cat.renderBreed(catAnimKey.slice(0, sepIdx));
          const anim = catAnimKey.slice(sepIdx + 1);
          const off = this.frameOffsets[breed]?.[anim]?.[frameIdx - 1];
          if (off) {
            const strength = catalogEntry.motionStrength ?? Cat.motionStrengthForSlot(slot);
            dx = off[0] * strength;
            dy = off[1] * strength;
          }
        }
      }
    }

    // Offsets are in SOURCE pixels (91×64 canvas). Scale to display pixels
    // via the cat's render scale.
    sprite.setPosition(
      this.sprite.x + dx * this.sprite.scaleX,
      this.sprite.y + dy * this.sprite.scaleX,
    );
  }

  /** Get the cosmetic id equipped in the given slot, accounting for the
   *  equippedCosmetics map's slot keying. Returns null if nothing is
   *  equipped in that slot. */
  private cosmeticIdForSlot(slot: string): CosmeticId | null {
    return this.model.equippedCosmetics?.[slot] ?? null;
  }

  /** How strongly a cosmetic in this slot rides the cat's per-frame motion.
   *  1.0 = exactly tracks the cat's body-center delta. Lower for body items
   *  (which move less in the source art than the head). Tunable later via a
   *  per-cosmetic `motionStrength` override in the calibrator if needed. */
  private static motionStrengthForSlot(slot: string): number {
    switch (slot) {
      case 'head':
      case 'face':
        return 1.0;
      case 'neck':
        return 0.8;
      case 'body':
        return 0.4;
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
    const key = Cat.cosmeticAnimationKey(renderId, animation);
    this.ensureCosmeticAnimation(renderId, animation);
    if (this.scene.anims.exists(key)) {
      sprite.play(key, true);
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
    const frameNames = atlas
      .getFrameNames()
      .filter((n) => n.startsWith(prefix))
      .sort();

    if (frameNames.length === 0) {
      console.warn(`[cat] No frames for ${prefix} in cats atlas`);
      return;
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
