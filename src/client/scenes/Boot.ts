import { Scene } from 'phaser';
import { SceneKeys } from '@/constants/scenes';

export class Boot extends Scene {
  constructor() {
    super(SceneKeys.Boot);
  }

  create() {
    this.scene.start(SceneKeys.Preloader);
  }
}
