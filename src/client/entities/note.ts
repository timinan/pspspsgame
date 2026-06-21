import { GameObjects, Scene } from 'phaser';
import type { LaneId } from '../../shared/state';
import { LANE_COLORS } from './note-colors';

export { LANE_COLORS };

export class Note extends GameObjects.Container {
  laneId: LaneId = 0;
  hitAtMs = 0;
  consumed = false;
  private graphics: GameObjects.Graphics;

  constructor(scene: Scene) {
    super(scene, 0, 0);
    this.graphics = scene.add.graphics();
    this.add(this.graphics);
    this.setActive(false).setVisible(false);
  }

  // configure() is the RESET POINT — every field that can leak across pool reuses
  // must be set here. recycle() only marks the object inactive and stops tweens.
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
    this.graphics.clear();
    this.graphics.fillStyle(LANE_COLORS[laneId]);
    this.graphics.fillCircle(0, 0, 18);
    this.scene.tweens.killTweensOf(this); // safety — never inherit a stale tween
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
