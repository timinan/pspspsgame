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

//  Find out more information about the Game Config at:
//  https://docs.phaser.io/api-documentation/typedef/types-core#gameconfig
const config: Phaser.Types.Core.GameConfig = {
  type: AUTO,
  parent: 'game-container',
  backgroundColor: '#028af8',
  scale: {
    // RESIZE lets the canvas fill whatever portrait/landscape area the
    // Devvit web view gives us — important because FIT letterboxes the
    // game with huge black bars in mobile/portrait. The trade-off is that
    // when the viewport changes (DevTools opens, orientation flips),
    // anything positioned in pixels at scene-create time goes out of
    // place. We'll add a resize handler later if it becomes a real
    // problem.
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: 1024,
    height: 768,
  },
  scene: [Boot, Preloader, MainMenu, Welcome, MainGame, Purchase, Decorate, DressingRoom, ChartEditor],
};

const StartGame = (parent: string) => {
  return new Game({ ...config, parent });
};

document.addEventListener('DOMContentLoaded', () => {
  StartGame('game-container');
});
