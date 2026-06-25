import { GameObjects, Scene } from 'phaser';
import type { LaneId } from '../../shared/state';
import { AssetKeys } from '../constants/assets';
import { LANE_COLORS, liftTowardWhite, BALL_BRIGHTNESS_LIFT } from './note-colors';

export { LANE_COLORS };

/** Hold-tail width — moderately narrower than the 54px head ball so
 *  the column reads as a tail, not a second note. */
const TAIL_WIDTH = 44;
/** Slide-tube thickness (perpendicular to drag direction) — wider than
 *  the hold tail so the sideways path reads as the primary corridor
 *  the head will travel. */
const SLIDE_TUBE_THICKNESS = 64;

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

  /** True for slide notes — tap in sourceLane + drag horizontally to
   *  targetLane. Falls down its source lane like a tap; the slide gesture
   *  is detected on tap-down at the head's hit window. */
  isSlide = false;
  /** Signed horizontal distance (px, in container space) from source lane
   *  center to target lane center. Positive = drag right; negative = left. */
  slideDeltaX = 0;
  /** Set true by Game.registerTap when the player taps the slide head
   *  in the hit window. Tracks pointer-x updates until release. */
  slideActive = false;
  /** Pointer id locked to this slide's drag. -1 when not active. Lets
   *  multi-touch resolve which finger to follow per note. */
  slidePointerId = -1;

  private ball: GameObjects.Image;
  private letters: GameObjects.Image;
  /** Stretchy Image using PspspsTubeWhite for hold tails (vertical
   *  capsule, stretched to tail height). Clipped to the lane band via
   *  a GeometryMask applied from Game on spawn. */
  private tail: GameObjects.Image;
  /** Horizontal sideways tube for slide notes — stays anchored in
   *  container space while the head ball moves toward target lane. */
  private slideTube: GameObjects.Image;
  /** Direction chevron at the target end of the slide tube. */
  private slideArrow: GameObjects.Text;
  /** Cached tail height so pickRandomVisibleTailWorldPos can locate
   *  the tail's bounds. Public so Game.showHoldScorePop can position
   *  the hold's tick popup at the tail's top edge. */
  currentTailHeight = 0;

  constructor(scene: Scene) {
    super(scene, 0, 0);
    // Tail Image FIRST so it renders behind the ball + letters. Origin
    // (0.5, 1) anchors it at bottom-center so it grows UPWARD from the
    // ball's center when we resize via setDisplaySize. Hidden by default;
    // hold configure flips it on and sets the actual tail length.
    this.tail = scene.add.image(0, 0, AssetKeys.Image.PspspsTubeWhite);
    this.tail.setOrigin(0.5, 1);
    this.tail.setVisible(false);
    // Slide tube — same fuzzy capsule rotated 90° so its rounded ends
    // sit LEFT + RIGHT, extending sideways from source to target lane.
    // Stays anchored in container space while head ball moves on drag.
    this.slideTube = scene.add.image(0, 0, AssetKeys.Image.PspspsTubeWhite);
    this.slideTube.setVisible(false);
    // 54px — matches the 50% bump applied to the lane hit targets (48 → 72)
    // so the falling notes read at the same visual weight as the target.
    // White-base ball — greyscale-stretched so the per-bg sampled tint
    // paints a clean fuzzball instead of multiplying through the
    // prototype's saturated orange.
    this.ball = scene.add.image(0, 0, AssetKeys.Image.PspspsElementBallWhite);
    this.ball.setDisplaySize(54, 54);
    this.letters = scene.add.image(0, 0, AssetKeys.Image.PspspsElementLetters);
    this.letters.setDisplaySize(54, 54);
    // Direction chevron drawn at the target end of the slide tube.
    this.slideArrow = scene.add.text(0, 0, '', {
      fontFamily: 'Pixeloid Sans, sans-serif',
      fontStyle: 'bold',
      fontSize: '18px',
      color: '#ffffff',
      stroke: '#1a0a2e',
      strokeThickness: 3,
    }).setOrigin(0.5).setVisible(false);
    // Order: tail + slideTube behind, ball + letters in front, arrow on top.
    this.add([this.tail, this.slideTube, this.ball, this.letters, this.slideArrow]);
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
    /** Optional slide config. When set, a horizontal tube + arrow draw
     *  alongside the ball indicating the drag target. The ball itself
     *  starts at container-local x=0 (= source lane center) and slides
     *  toward x=deltaX (= target lane center) under player input.
     *  sourceTint + targetTint paint a lane-to-lane gradient along the
     *  tube via per-vertex setTint. */
    slide?: { deltaX: number; sourceTint: number; targetTint: number },
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
      this.tail.setDisplaySize(TAIL_WIDTH, hold.tailHeightPx);
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
    }

    if (slide) {
      this.isSlide = true;
      this.slideDeltaX = slide.deltaX;
      this.slideActive = false;
      this.slidePointerId = -1;
      // Tube image is naturally vertical (taller than wide). Set the
      // PRE-rotation displaySize so the post-90°-rotation screen size
      // is `abs(deltaX)` wide × SLIDE_TUBE_THICKNESS tall, then center
      // it between the source (x=0) and target (x=deltaX) in container
      // coords. setSlideHeadX updates size + position during drag so
      // the "already slid" portion behind the ball erases.
      const tubeLen = Math.abs(slide.deltaX);
      this.slideTube.setDisplaySize(SLIDE_TUBE_THICKNESS, tubeLen);
      this.slideTube.setRotation(Math.PI / 2);
      this.slideTube.setPosition(slide.deltaX / 2, 0);
      // Per-vertex tint paints a lane-to-lane gradient. Image's TOP
      // (Y=0) maps to screen RIGHT after 90° CW rotation, BOTTOM maps
      // to screen LEFT. For a rightward slide: source on screen left
      // = image bottom; target on screen right = image top.
      const srcLifted = liftTowardWhite(slide.sourceTint, BALL_BRIGHTNESS_LIFT);
      const tgtLifted = liftTowardWhite(slide.targetTint, BALL_BRIGHTNESS_LIFT);
      const topColor = slide.deltaX > 0 ? tgtLifted : srcLifted;
      const bottomColor = slide.deltaX > 0 ? srcLifted : tgtLifted;
      this.slideTube.setTint(topColor, topColor, bottomColor, bottomColor);
      this.slideTube.setVisible(true);
      // Arrow at the target end, pointing toward target. ▶ for right
      // (deltaX > 0), ◀ for left.
      const arrowSym = slide.deltaX > 0 ? '▶' : '◀';
      const arrowInset = slide.deltaX > 0 ? -14 : 14;
      this.slideArrow.setText(arrowSym);
      this.slideArrow.setPosition(slide.deltaX + arrowInset, 0);
      this.slideArrow.setVisible(true);
    } else {
      this.isSlide = false;
      this.slideDeltaX = 0;
      this.slideActive = false;
      this.slidePointerId = -1;
      this.slideTube.setVisible(false);
      this.slideArrow.setVisible(false);
    }

    // Head starts at container origin regardless of note type. For
    // slides, the ball.x is the only thing that animates during drag.
    this.ball.setPosition(0, 0);
    this.letters.setPosition(0, 0);

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
    this.slideTube.setVisible(false);
    this.slideArrow.setVisible(false);
    this.isHold = false;
    this.holdActive = false;
    this.holdEndAtMs = 0;
    this.holdLastEffectMs = 0;
    this.currentTailHeight = 0;
    this.isSlide = false;
    this.slideActive = false;
    this.slideDeltaX = 0;
    this.slidePointerId = -1;
  }

  /** Set the head ball's local x within the container. Game calls this
   *  on slide-drag pointermove to make the head follow the finger.
   *  Also erases the "already slid" portion of the tube behind the
   *  ball — the visible tube shrinks to cover only the yet-to-cover
   *  path from the ball to the target. Arrow stays pinned at target. */
  setSlideHeadX(localX: number): void {
    this.ball.x = localX;
    this.letters.x = localX;
    // Remaining tube spans [localX, deltaX]. Recenter + resize so the
    // tube only renders the not-yet-covered portion.
    const remainingLen = Math.abs(this.slideDeltaX - localX);
    const center = (localX + this.slideDeltaX) / 2;
    this.slideTube.setPosition(center, 0);
    this.slideTube.setDisplaySize(SLIDE_TUBE_THICKNESS, remainingLen);
  }

  /** Current head ball local-x (= 0 at source, deltaX at target). */
  getSlideHeadX(): number {
    return this.ball.x;
  }

  /** Switch the tail's tint. Game calls this on hold engage to flip
   *  from the lane color to the mint "success" tint. */
  setHoldTint(color: number): void {
    this.tail.setTint(color);
  }

  /** Overwrite the slide tube's gradient with a solid color (no per-
   *  corner tints) — Game calls this on slide engage to flip the tube
   *  to the same mint "great" color a successful tap shows. */
  setSlideEngagedTint(color: number): void {
    this.slideTube.setTint(color);
  }

  /** Evenly-spaced world-y points along the VISIBLE portion of the
   *  tail. Used by Game to fire recurring effect bursts simultaneously
   *  at multiple points along the body so the whole column reads as
   *  "actively emitting" instead of one spot at a time. Returns []
   *  if the tail isn't in the lane band. */
  getVisibleTailWorldPoints(laneTopY: number, targetY: number, count: number): Array<{ x: number; y: number }> {
    if (this.currentTailHeight <= 0 || count <= 0) return [];
    const tailTopWorld = this.y - this.currentTailHeight;
    const tailBottomWorld = this.y;
    const visTop = Math.max(tailTopWorld, laneTopY);
    const visBottom = Math.min(tailBottomWorld, targetY);
    if (visBottom <= visTop) return [];
    const points: Array<{ x: number; y: number }> = [];
    const step = (visBottom - visTop) / (count + 1);
    for (let i = 1; i <= count; i++) {
      points.push({ x: this.x, y: visTop + step * i });
    }
    return points;
  }

  /** Per-frame update for active and falling notes. Manually clips
   *  every visible part to the lane band [laneTopY, disappearY] —
   *  brute-force boundary instead of Phaser's GeometryMask which has
   *  been flaky here. Hides head/letters above lane top AND past the
   *  disappear line; dynamically resizes the hold tail and slide tube
   *  so they only render inside the lane. */
  updateHoldVisuals(laneTopY: number, _targetY: number, disappearY: number, jitterPx: number): void {
    // Head + letters: visible only when the container is fully within
    // [laneTopY, disappearY]. Anything above laneTopY = hide the head
    // so no fuzzball renders in the cat-stage area.
    const headPast = this.y > disappearY;
    const headAbove = this.y < laneTopY;
    const showHead = !headPast && !headAbove;
    this.ball.setVisible(showHead);
    this.letters.setVisible(showHead);

    // Hold tail — bottom anchored at container.y (local 0); top
    // extends UP by currentTailHeight. Clip the visible portion to
    // [laneTopY, container.y] in world space, reshape the Image to
    // match. Hide if no part is in the lane band yet.
    if (this.currentTailHeight > 0) {
      const tailBottomWorld = Math.min(this.y, disappearY);
      const tailTopWorld = Math.max(this.y - this.currentTailHeight, laneTopY);
      const visibleHeight = Math.max(0, tailBottomWorld - tailTopWorld);
      if (visibleHeight <= 0) {
        this.tail.setVisible(false);
      } else {
        this.tail.setVisible(true);
        this.tail.setDisplaySize(TAIL_WIDTH, visibleHeight);
        // Origin (0.5, 1) means tail.y positions the BOTTOM edge in
        // container-local coords. Convert tailBottomWorld back to local.
        this.tail.y = tailBottomWorld - this.y;
      }
    }

    // Slide tube + arrow — same lane-top gate. Slide tube is
    // horizontal so its full vertical extent moves with the container;
    // hide it (and the arrow) whenever the container is above laneTopY.
    if (this.isSlide) {
      this.slideTube.setVisible(!headAbove);
      this.slideArrow.setVisible(!headAbove);
    }

    // Tail vibration jitter — layered sines for organic feel.
    if (this.holdActive) {
      const t = this.scene.time.now;
      this.tail.x = Math.sin(t * 0.15) * jitterPx + Math.sin(t * 0.06) * (jitterPx * 0.35);
    } else {
      this.tail.x = 0;
    }
  }
}
