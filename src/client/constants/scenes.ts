export const SceneKeys = {
  Boot: 'Boot',
  Preloader: 'Preloader',
  MainMenu: 'MainMenu',
  Welcome: 'Welcome',
  Game: 'Game',
  Boxes: 'Boxes',
  GameOver: 'GameOver',
  Decorate: 'Decorate',
  DressingRoom: 'DressingRoom',
  ChartEditor: 'ChartEditor',
} as const;

export type SceneKey = (typeof SceneKeys)[keyof typeof SceneKeys];
