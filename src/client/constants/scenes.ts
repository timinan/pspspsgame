export const SceneKeys = {
  Boot: 'Boot',
  Preloader: 'Preloader',
  MainMenu: 'MainMenu',
  Welcome: 'Welcome',
  Game: 'Game',
  Purchase: 'Purchase',
  Decorate: 'Decorate',
  DressingRoom: 'DressingRoom',
  ChartEditor: 'ChartEditor',
} as const;

export type SceneKey = (typeof SceneKeys)[keyof typeof SceneKeys];
