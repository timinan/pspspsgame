import { Scene } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import type { PlayerState } from '@/../shared/state';

/**
 * STUB — Task 8 will replace this with the full onboarding flow
 * (welcome message → open Cat Crate → open Style Pack → complete →
 * transition to Game). For now it just acknowledges the route and
 * forwards into Game so the rest of the wiring can be verified.
 */
export class Welcome extends Scene {
  private playerState: PlayerState | null = null;

  constructor() {
    super(SceneKeys.Welcome);
  }

  init(data: { playerState?: PlayerState | null }): void {
    this.playerState = data?.playerState ?? null;
  }

  create(): void {
    const { width, height } = this.scale;
    this.add.rectangle(0, 0, width, height, 0x261540, 0.95).setOrigin(0, 0);
    this.add
      .text(width / 2, height / 2, 'Welcome (stub)\nTap to continue', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '28px',
        color: '#ffffff',
        align: 'center',
      })
      .setOrigin(0.5);

    this.input.once('pointerdown', () => {
      this.scene.start(SceneKeys.Game, { playerState: this.playerState });
    });
  }
}
