export const AssetKeys = {
  Atlas: {
    Cats: 'cats-atlas',
    Cosmetics: 'cosmetics-atlas',
  },
  Image: {
    GameBackground: 'game-background',
    MeowBarFill: 'meow-bar-fill',
    MeowBarOutline: 'meow-bar-outline',
    RhythmBarBackground: 'rhythm-bar-background',
    PspspsTarget: 'pspsps-target',
    PspspsElement: 'pspsps-element',
    PspspsElementBall: 'pspsps-element-ball',
    PspspsElementLetters: 'pspsps-element-letters',
    // Background textures load via Preloader.ts iteration over
    // BACKGROUND_CATALOG — keys live on the catalog entries themselves
    // (`entry.backdropKey`), no per-bg AssetKey needed.
  },
  Audio: {
    Background: 'background-music',
    Pspsps: 'pspsps-sfx',
    ThemeDefaultMusic: 'theme-default-music',
    ThemeCozyMusic: 'theme-cozy-music',
    ThemeSpookyMusic: 'theme-spooky-music',
  },
} as const;
