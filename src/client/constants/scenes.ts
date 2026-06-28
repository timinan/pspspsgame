export const SceneKeys = {
  Boot: 'Boot',
  Preloader: 'Preloader',
  MainMenu: 'MainMenu',
  Welcome: 'Welcome',
  TutorialOrchestrator: 'TutorialOrchestrator',
  Game: 'Game',
  Purchase: 'Purchase',
  Decorate: 'Decorate',
  DressingRoom: 'DressingRoom',
  ChartEditor: 'ChartEditor',
  VisitShows: 'VisitShows',
  VisitPost: 'VisitPost',
} as const;

export type SceneKey = (typeof SceneKeys)[keyof typeof SceneKeys];
