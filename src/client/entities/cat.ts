import * as Phaser from 'phaser';
import { Scene, Scenes, GameObjects } from 'phaser';
import { AssetKeys } from '@/constants/assets';
import { Balance } from '@/constants/balance';
import { hslToInt } from '@/util/color';
import type { CatBreed, CatAnimationState, CatModel, CosmeticId } from '@/types/game';
import { COSMETIC_CATALOG } from '@/../shared/state';

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

/**
 * Pull the parent cosmetic id out of a tint variant's sourceFrame string
 * (`cosmetic_<parent>_idle_00`). Returns null for base cosmetics — they
 * render from their own atlas frames.
 */
function parentIdFor(entry: { sourceFrame?: string } | undefined): string | null {
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
  private cosmeticSprite: GameObjects.Sprite | null = null;
  private readonly postUpdate: () => void;
  private rainbowTween: Phaser.Tweens.Tween | null = null;

  constructor(
    private readonly scene: Scene,
    public readonly model: CatModel,
  ) {
    const initialFrame = Cat.frameName(model.breed, model.animation, 0);
    this.sprite = scene.add.sprite(0, 0, AssetKeys.Atlas.Cats, initialFrame);
    this.sprite.setOrigin(0.5, 1);
    this.ensureAnimation(model.breed, model.animation);
    this.playAnimation(model.animation);

    // Cosmetic follows the cat sprite each frame so tweens on `sprite` (e.g.
    // the petting handoff slide-to-center) carry the accessory along. We
    // could parent via a Container but that would change `cat.sprite`'s
    // type, and callers like Game.ts reach in to set depth on it directly.
    this.postUpdate = () => this.syncCosmeticPosition();
    this.scene.events.on(Scenes.Events.POST_UPDATE, this.postUpdate);

    if (model.breed === 'rainbow') {
      this.startRainbowCycle();
    }

    if (model.equippedCosmetic) {
      this.setCosmetic(model.equippedCosmetic);
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
   * Show or update the cosmetic worn above this cat. Passing `null`
   * removes whatever it's currently wearing. The cosmetic is rendered
   * just above the cat sprite and matches the cat's scale + position.
   */
  setCosmetic(cosmeticId: CosmeticId | null): void {
    if (cosmeticId) {
      this.model.equippedCosmetic = cosmeticId;
    } else {
      delete this.model.equippedCosmetic;
    }

    if (!cosmeticId) {
      this.cosmeticSprite?.destroy();
      this.cosmeticSprite = null;
      return;
    }

    // Catalog entry can be a base (just an id) or a generated tint
    // variant (with sourceFrame + tint). For variants, we render the
    // parent's atlas frames and apply the tint via setTint(). The
    // animation key used here is keyed on the SOURCE id, not the variant
    // id, so multiple variants share the same animation entry.
    const entry = COSMETIC_CATALOG.find((c) => c.id === cosmeticId);
    const renderId = parentIdFor(entry) ?? cosmeticId;
    const idleFrame = `cosmetic_${renderId}_idle_00`;
    if (!this.cosmeticSprite) {
      this.cosmeticSprite = this.scene.add.sprite(0, 0, AssetKeys.Atlas.Cosmetics, idleFrame);
      this.cosmeticSprite.setOrigin(0.5, 1); // match cat — bottom-center anchor
    } else {
      this.cosmeticSprite.setTexture(AssetKeys.Atlas.Cosmetics, idleFrame);
    }
    // Apply the catalog tint (or clear any previous one).
    if (entry?.tint) {
      const colorInt = parseInt(entry.tint.replace('#', ''), 16);
      this.cosmeticSprite.setTint(colorInt);
    } else {
      this.cosmeticSprite.clearTint();
    }
    this.playCosmeticAnimation(this.model.animation);
    this.syncCosmeticPosition();
  }

  destroy(): void {
    this.scene.events.off(Scenes.Events.POST_UPDATE, this.postUpdate);
    this.rainbowTween?.stop();
    this.rainbowTween?.remove();
    this.rainbowTween = null;
    this.cosmeticSprite?.destroy();
    this.cosmeticSprite = null;
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
    if (!this.cosmeticSprite) return;
    // Cosmetic sprite uses the same canvas size + origin as the cat, so
    // copying the cat's position and scale puts it in lock-step. No more
    // per-cosmetic offset hack needed.
    this.cosmeticSprite.setScale(this.sprite.scaleX);
    this.cosmeticSprite.setPosition(this.sprite.x, this.sprite.y);
    this.cosmeticSprite.setDepth(this.sprite.depth + 1);
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
    if (!this.cosmeticSprite || !this.model.equippedCosmetic) return;
    // Resolve the render id — for tint variants we play the PARENT's
    // animation (the tint stays applied across frames).
    const entry = COSMETIC_CATALOG.find((c) => c.id === this.model.equippedCosmetic);
    const renderId = parentIdFor(entry) ?? this.model.equippedCosmetic;
    const key = Cat.cosmeticAnimationKey(renderId, animation);
    this.ensureCosmeticAnimation(renderId, animation);
    if (this.scene.anims.exists(key)) {
      this.cosmeticSprite.play(key, true);
      return;
    }
    // Cosmetic doesn't ship this animation — fall back to idle. Every
    // cosmetic ships an idle frame so this branch is safe.
    const idleKey = Cat.cosmeticAnimationKey(renderId, 'idle');
    this.ensureCosmeticAnimation(renderId, 'idle');
    if (this.scene.anims.exists(idleKey)) {
      this.cosmeticSprite.play(idleKey, true);
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
