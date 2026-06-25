import { GameObjects, Scene } from 'phaser';
import type { LaneId } from '../../shared/state';
import { AssetKeys } from '../constants/assets';
import { LANE_COLORS, liftTowardWhite, BALL_BRIGHTNESS_LIFT } from './note-colors';

export { LANE_COLORS };

/** Hold-tail TileSprite width — narrower than the 54px head ball so the
 *  trailing column reads as a tail, not a second note. Must match the
 *  'tail-stripe' texture width in Preloader.generateTailStripeTexture(). */
const TAIL_WIDTH = 18;

/**
 * A falling rhythm note rendered as the original Phase 1 "PS element" ball
 * (the colored ball that slid down the horizontal rhythm bar). Pooled —
 * configure() is the reset point; recycle() deactivates without resetting
 * `consumed`.
 */
export class Note extends GameObjects.Container {
  laneId: LaneId = 0;
  hitAtMs = 0;
  consumed = false;

  /** True for hold notes — affects miss detection (held holds don't
   *  auto-miss when the head crosses the miss line) and tells Game.ts
   *  to engage the hold instead of consuming on a successful tap. */
  isHold = false;
  /** Game-time when the trailing edge of the hold reaches the target.
   *  Game.ts uses this to time auto-end. 0 for tap notes. */
  holdEndAtMs = 0;
  /** Set true by Game.ts once the player has tapped down on this hold's
   *  head and is currently inside the hold. Cleared on release or
   *  auto-end. */
  holdActive = false;

  /** Game-time of the last recurring hold-effect emit. Game.tickHolds
   *  re-fires the lane effect + cat pulse on a fixed cadence while the
   *  hold is active so the hold feels alive instead of static. 0 until
   *  the hold engages. */
  holdLastEffectMs = 0;

  private ball: GameObjects.Image;
  private letters: GameObjects.Image;
  /** TileSprite using the Preloader-generated 'tail-stripe' texture
   *  (a 1px-tall horizontal slice from the fuzzy ball's widest row).
   *  Vertically tiled, the column inherits the ball's fuzzy left/right
   *  edges — narrow tail with the same visual treatment. Clipped to
   *  the lane band via a GeometryMask applied from Game on spawn. */
  private tail: GameObjects.TileSprite;
  /** Cached tail height so pickRandomVisibleTailWorldPos can locate
   *  the tail's bounds without poking at TileSprite internals. */
  private currentTailHeight = 0;

  constructor(scene: Scene) {
    super(scene, 0, 0);
    // Tail TileSprite FIRST so it renders behind the ball + letters.
    // Origin (0.5, 1) anchors it at bottom-center so it grows UPWARD
    // from the ball's center as we resize. Initial height 0 = invisible
    // for tap notes; hold configure resizes to the actual tail length.
    this.tail = scene.add.tileSprite(0, 0, TAIL_WIDTH, 0, 'tail-stripe');
    this.tail.setOrigin(0.5, 1);
    // 54px — matches the 50% bump applied to the lane hit targets (48 → 72)
    // so the falling notes read at the same visual weight as the target.
    // White-base ball — greyscale-stretched so the per-bg sampled tint
    // paints a clean fuzzball instead of multiplying through the
    // prototype's saturated orange.
    this.ball = scene.add.image(0, 0, AssetKeys.Image.PspspsElementBallWhite);
    this.ball.setDisplaySize(54, 54);
    this.letters = scene.add.image(0, 0, AssetKeys.Image.PspspsElementLetters);
    this.letters.setDisplaySize(54, 54);
    this.add([this.tail, this.ball, this.letters]);
    // Render above cat-effect particles (cat sprite depth 0 → particles
    // depth +2). Without this, a cat with sparkles / fire / hearts equipped
    // visually obscures every falling note in its lane and the player
    // misses everything in that column.
    this.setDepth(40);
    this.setActive(false).setVisible(false);
  }

  configure(
    laneId: LaneId,
    x: number,
    startY: number,
    endY: number,
    fallMs: number,
    hitAtMs: number,
    /** Override the default LANE_COLORS tint — typically the per-bg
     *  sampled color from `Game.laneTints` so the falling note matches
     *  its lane's hit target. Omit / pass undefined for the default. */
    tintColor?: number,
    /** Optional hold config. When set, the tail Graphics is drawn as a
     *  vertical pill extending upward from the ball (= the trailing
     *  portion yet to be held) and `holdEndAtMs` is recorded so Game
     *  can auto-end when the trailing edge crosses the target. */
    hold?: { tailHeightPx: number; tailWidthPx: number; releaseAtMs: number },
  ): void {
    // Kill any in-flight tween from the pool's previous use FIRST. If we
    // set position before killing, a still-running fall tween from the
    // prior life can re-write y in the same frame and the note appears
    // to "teleport down" instead of starting at startY.
    this.scene.tweens.killTweensOf(this);
    this.laneId = laneId;
    this.hitAtMs = hitAtMs;
    this.consumed = false;
    this.holdActive = false;
    this.holdLastEffectMs = 0;
    this.setPosition(x, startY);
    this.setActive(true).setVisible(true);
    this.setAlpha(1);
    this.setScale(1);
    // Reset ball + letters visibility — updateHoldVisuals may have
    // hidden them on a previous pool use (head fades when past the
    // disappear line). Without this, a recycled note would spawn
    // invisible.
    this.ball.setVisible(true);
    this.letters.setVisible(true);
    // Lift the ball tint toward white so the falling note pops against
    // the alpha-0.55 lane underneath (lane + ball were previously the
    // exact same hue and blended on busy bgs).
    this.ball.setTint(liftTowardWhite(tintColor ?? LANE_COLORS[laneId], BALL_BRIGHTNESS_LIFT));
    // Letters stay white so the "PS" reads clearly on top of any lane tint.
    this.letters.clearTint();

    if (hold) {
      this.isHold = true;
      this.holdEndAtMs = hold.releaseAtMs;
      this.currentTailHeight = hold.tailHeightPx;
      // Resize the TileSprite to the actual tail length. Width is the
      // fixed narrow TAIL_WIDTH (the stripe texture's width); height
      // tiles vertically. Tint colors the white-base stripe.
      this.tail.setSize(TAIL_WIDTH, hold.tailHeightPx);
      this.tail.setTint(
        liftTowardWhite(tintColor ?? LANE_COLORS[laneId], BALL_BRIGHTNESS_LIFT),
      );
      this.tail.setVisible(true);
      this.tail.x = 0;
    } else {
      this.isHold = false;
      this.holdEndAtMs = 0;
      this.currentTailHeight = 0;
      this.tail.setVisible(false);
      this.tail.setSize(TAIL_WIDTH, 0);
    }

    this.scene.tweens.add({
      targets: this,
      y: endY,
      duration: fallMs,
      ease: 'Linear',
    });
  }

  /** Apply the lane-band GeometryMask to the tail TileSprite so the
   *  stripe only renders inside [laneTopY, targetY] regardless of
   *  where the container's position puts it. Called by Game on spawn. */
  applyTailMask(mask: Phaser.Display.Masks.GeometryMask): void {
    this.tail.setMask(mask);
  }

  recycle(): void {
    this.scene.tweens.killTweensOf(this);
    this.setActive(false).setVisible(false);
    this.tail.setVisible(false);
    this.tail.setSize(TAIL_WIDTH, 0);
    this.isHold = false;
    this.holdActive = false;
    this.holdEndAtMs = 0;
    this.holdLastEffectMs = 0;
    this.currentTailHeight = 0;
  }

  /** Switch the tail's tint. Game calls this on hold engage to flip
   *  from the lane color to the mint "success" tint. */
  setHoldTint(color: number): void {
    this.tail.setTint(color);
  }

  /** Pick a uniformly random point along the VISIBLE portion of the
   *  tail and return its world position. Used by Game to spawn the
   *  recurring effect burst along the tail. Returns null if no part
   *  of the tail is currently inside the lane band. */
  pickRandomVisibleTailWorldPos(laneTopY: number, targetY: number): { x: number; y: number } | null {
    if (this.currentTailHeight <= 0) return null;
    const tailTopWorld = this.y - this.currentTailHeight;
    const tailBottomWorld = this.y;
    const visTop = Math.max(tailTopWorld, laneTopY);
    const visBottom = Math.min(tailBottomWorld, targetY);
    if (visBottom <= visTop) return null;
    const y = visTop + Math.random() * (visBottom - visTop);
    return { x: this.x, y };
  }

  /** Per-frame update for active and falling hold notes. Mask handles
   *  tail clipping; this just hides the head past the disappear line
   *  and applies x-jitter to the tail while engaged. */
  updateHoldVisuals(_laneTopY: number, _targetY: number, disappearY: number, jitterPx: number): void {
    const headPast = this.y > disappearY;
    this.ball.setVisible(!headPast);
    this.letters.setVisible(!headPast);
    if (this.holdActive) {
      this.tail.x = (Math.random() - 0.5) * 2 * jitterPx;
    } else {
      this.tail.x = 0;
    }
  }
}
