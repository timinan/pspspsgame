import { GameObjects, Scene } from 'phaser';

/**
 * Small red circle with ✕ glyph. Container designed to be added to the scene
 * at a position and have its onRemove callback fired when tapped.
 *
 * The tap handler uses event.stopPropagation() so the badge tap doesn't
 * bubble up to a tap-outside-to-close handler on the parent scene.
 */
export class RemoveBadge extends GameObjects.Container {
  constructor(scene: Scene, offsetX: number, offsetY: number, onRemove: () => void) {
    super(scene, offsetX, offsetY);

    const bg = scene.add.circle(0, 0, 9, 0xff5050, 1);
    bg.setStrokeStyle(2, 0x0b041a, 1);
    bg.setInteractive({ useHandCursor: true });
    bg.on('pointerdown', (_pointer: Phaser.Input.Pointer, _x: number, _y: number, event: Phaser.Types.Input.EventData) => {
      event.stopPropagation();
      onRemove();
    });

    const x = scene.add
      .text(0, 0, '✕', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '10px',
        fontStyle: 'bold',
        color: '#ffffff',
      })
      .setOrigin(0.5);

    this.add([bg, x]);
  }
}
