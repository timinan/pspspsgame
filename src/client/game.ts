import { Boot } from './scenes/Boot';
import { Purchase } from './scenes/Purchase';
import { ChartEditor } from './scenes/ChartEditor';
import { DressingRoom } from './scenes/DressingRoom';
import { Game as MainGame } from './scenes/Game';
import { Decorate } from './scenes/Decorate';
import { MainMenu } from './scenes/MainMenu';
import * as Phaser from 'phaser';
import { AUTO, Game } from 'phaser';
import { Preloader } from './scenes/Preloader';
import { Welcome } from './scenes/Welcome';
import { VisitShows } from './scenes/VisitShows';
import { VisitPost } from './scenes/VisitPost';
import { DESIGN_W, DESIGN_H } from './constants/scene-layout';

// Crisp text on hi-DPI screens. Phaser's Text renders to an internal
// canvas at scale 1 by default; on a retina iPhone that bitmap gets
// upscaled by ~3× and looks fuzzy. We patch the GameObjectFactory so
// every `scene.add.text(...)` inherits a 2× resolution unless the caller
// already specified one. Display size + origin behavior is unchanged
// (resolution only affects the internal canvas density).
const DPR = (typeof window !== 'undefined' && window.devicePixelRatio) || 2;
const TEXT_RESOLUTION = Math.max(2, Math.min(3, DPR));
const _originalAddText = Phaser.GameObjects.GameObjectFactory.prototype.text;
Phaser.GameObjects.GameObjectFactory.prototype.text = function patchedText(
  this: Phaser.GameObjects.GameObjectFactory,
  x: number,
  y: number,
  text: string | string[],
  style?: Phaser.Types.GameObjects.Text.TextStyle,
) {
  const merged: Phaser.Types.GameObjects.Text.TextStyle = {
    ...(style ?? {}),
    resolution: style?.resolution ?? TEXT_RESOLUTION,
  };
  return _originalAddText.call(this, x, y, text, merged);
};

//  Find out more information about the Game Config at:
//  https://docs.phaser.io/api-documentation/typedef/types-core#gameconfig
const config: Phaser.Types.Core.GameConfig = {
  type: AUTO,
  parent: 'game-container',
  backgroundColor: '#0b041a',
  scale: {
    // FIT preserves the 320×580 portrait aspect across every device: on
    // mobile the canvas fills the iframe, on desktop it letterboxes
    // black bars on the sides. We were on RESIZE before — that lets the
    // canvas stretch to the iframe width, but the scenes lay out lane
    // centers / cat positions relative to scene.scale.width, so the
    // desktop iframe stretched the stage horizontally and made every
    // asset look squashed.
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: DESIGN_W,
    height: DESIGN_H,
  },
  scene: [Boot, Preloader, MainMenu, Welcome, MainGame, Purchase, Decorate, DressingRoom, ChartEditor, VisitShows, VisitPost],
};

const StartGame = (parent: string) => {
  return new Game({ ...config, parent });
};

document.addEventListener('DOMContentLoaded', () => {
  StartGame('game-container');
});
