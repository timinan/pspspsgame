// TODO Phase 5: Game scene rewrite (Tasks 9-11). Dead systems removed; this is a WIP stub.
import { Scene } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import type { PlayerState } from '@/../shared/state';

export class Game extends Scene {
  constructor() {
    super(SceneKeys.Game);
  }

  init(_data: { playerState?: PlayerState | null }): void {
    // TODO Phase 5: init rewritten in Tasks 9-11
  }

  create(): void {
    throw new Error('Phase 5 WIP: Game scene not yet rebuilt (see Tasks 9-11)');
  }
}
