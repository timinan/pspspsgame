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
import { DESIGN_W, DESIGN_H } from './constants/scene-layout';

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
  scene: [Boot, Preloader, MainMenu, Welcome, MainGame, Purchase, Decorate, DressingRoom, ChartEditor],
};

const StartGame = (parent: string) => {
  return new Game({ ...config, parent });
};

document.addEventListener('DOMContentLoaded', () => {
  StartGame('game-container');
});
