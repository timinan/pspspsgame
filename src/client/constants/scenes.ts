export const SceneKeys = {
  Boot: 'Boot',
  Preloader: 'Preloader',
  MainMenu: 'MainMenu',
  Game: 'Game',
  GameOver: 'GameOver',
} as const;

export type SceneKey = (typeof SceneKeys)[keyof typeof SceneKeys];
