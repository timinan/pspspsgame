import { GameObjects, Scene } from 'phaser';
import { AssetKeys } from '@/constants/assets';
import type { DecorationEntry } from '@/../shared/state';
import type { SceneSlot } from '@/constants/scene-slots';

/**
 * Renders a single decoration prop placed in a fixed scene slot.
 *
 * Lifecycle:
 *  - Instantiate when the scene loads + the slot is filled
 *  - Call destroy() when the slot is cleared, swapped, or the scene shuts down
 *
 * Decorations are static set-dressing. They don't tick, don't respond to input.
 */
export class Decoration extends GameObjects.Sprite {
  readonly slotId: string;
  readonly entry: DecorationEntry;

  constructor(scene: Scene, slot: SceneSlot, entry: DecorationEntry) {
    const renderX = (slot.x / 320) * scene.scale.width;
    const renderY = (slot.y / 480) * scene.scale.height;
    super(scene, renderX, renderY, AssetKeys.Atlas.Decorations, entry.frame);
    this.slotId = slot.id;
    this.entry = entry;
    this.setOrigin(slot.anchor.x, slot.anchor.y);
    this.setDepth(renderY); // simple y-sort so closer decor draws over farther
  }
}
