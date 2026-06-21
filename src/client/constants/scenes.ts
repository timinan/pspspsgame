export const SceneKeys = {
  Boot: 'Boot',
  Preloader: 'Preloader',
  MainMenu: 'MainMenu',
  Welcome: 'Welcome',
  Game: 'Game',
  Boxes: 'Boxes',
  Collection: 'Collection',
  GameOver: 'GameOver',
  HouseEditor: 'HouseEditor',
  DressingRoom: 'DressingRoom',
} as const;

export type SceneKey = (typeof SceneKeys)[keyof typeof SceneKeys];
