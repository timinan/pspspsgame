import { GameObjects, Scene } from 'phaser';
import type { LaneId } from '../../shared/state';
import { AssetKeys } from '../constants/assets';
import { LANE_COLORS } from './note-colors';

export { LANE_COLORS };

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
  private ball: GameObjects.Image;
  private letters: GameObjects.Image;

  constructor(scene: Scene) {
    super(scene, 0, 0);
    this.ball = scene.add.image(0, 0, AssetKeys.Image.PspspsElementBall);
    this.ball.setDisplaySize(36, 36);
    this.letters = scene.add.image(0, 0, AssetKeys.Image.PspspsElementLetters);
    this.letters.setDisplaySize(36, 36);
    this.add([this.ball, this.letters]);
    this.setActive(false).setVisible(false);
  }

  configure(
    laneId: LaneId,
    x: number,
    startY: number,
    endY: number,
    fallMs: number,
    hitAtMs: number,
  ): void {
    this.laneId = laneId;
    this.hitAtMs = hitAtMs;
    this.consumed = false;
    this.setPosition(x, startY);
    this.setActive(true).setVisible(true);
    this.setAlpha(1);
    this.setScale(1);
    this.ball.setTint(LANE_COLORS[laneId]);
    // Letters stay white so the "PS" reads clearly on top of any lane tint.
    this.letters.clearTint();
    this.scene.tweens.killTweensOf(this);
    this.scene.tweens.add({
      targets: this,
      y: endY,
      duration: fallMs,
      ease: 'Linear',
    });
  }

  recycle(): void {
    this.scene.tweens.killTweensOf(this);
    this.setActive(false).setVisible(false);
  }
}
