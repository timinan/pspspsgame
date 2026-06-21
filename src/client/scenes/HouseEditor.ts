// TODO Phase 5: HouseEditor replaced by Decorate scene (Task 13). Dead systems removed; WIP stub.
import { Scene } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import type { PlayerState } from '@/../shared/state';

export class HouseEditor extends Scene {
  constructor() {
    super(SceneKeys.HouseEditor);
  }

  init(_data: { playerState?: PlayerState }): void {
    // TODO Phase 5: init rewritten in Task 13
  }

  create(): void {
    throw new Error('Phase 5 WIP: HouseEditor scene not yet rebuilt (see Task 13)');
  }
}
