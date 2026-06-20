import { Scene } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { AssetKeys } from '@/constants/assets';
import { fetchState } from '@/services/state-client';
import type { PlayerState } from '@/../shared/state';

export class Preloader extends Scene {
  constructor() {
    super(SceneKeys.Preloader);
  }

  init() {
    const { width, height } = this.scale;
    const cx = width / 2;
    const cy = height / 2;

    // Loading bar outline
    this.add.rectangle(cx, cy, 468, 32).setStrokeStyle(1, 0xffffff);

    // Loading bar fill — anchored left, grows right based on load progress
    const fill = this.add.rectangle(cx - 230, cy, 4, 28, 0xffffff).setOrigin(0, 0.5);

    this.load.on('progress', (progress: number) => {
      fill.width = 4 + 460 * progress;
    });
  }

  preload() {
    this.load.setPath('assets');

    this.load.atlas(AssetKeys.Atlas.Cats, 'atlas/cats.png', 'atlas/cats.json');
    this.load.atlas(
      AssetKeys.Atlas.Cosmetics,
      'atlas/cosmetics.png',
      'atlas/cosmetics.json',
    );

    this.load.image(AssetKeys.Image.GameBackground, 'images/gameBackground.png');
    this.load.image(AssetKeys.Image.MeowBarFill, 'images/meowBarFill.png');
    this.load.image(AssetKeys.Image.MeowBarOutline, 'images/meowBarOutline.png');
    this.load.image(AssetKeys.Image.RhythmBarBackground, 'images/rythmBarBackground.png');
    this.load.image(AssetKeys.Image.PspspsTarget, 'images/PSTarget.png');
    this.load.image(AssetKeys.Image.PspspsElement, 'images/PSElement.png');
    this.load.image(AssetKeys.Image.PspspsElementBall, 'images/PSElement_ball.png');
    this.load.image(AssetKeys.Image.PspspsElementLetters, 'images/PSElement_letters.png');

    this.load.audio(AssetKeys.Audio.Background, 'sounds/background.mp3');
    this.load.audio(AssetKeys.Audio.Pspsps, 'sounds/pspsps.mp3');
  }

  async create() {
    // Make sure the Pixeloid Sans face is actually loaded into the browser
    // before we kick off the next scene, otherwise the first frame of
    // Phaser text would render with the system sans-serif and the layout
    // would shift when the font finishes loading.
    await this.loadFontsOrTimeout(2500);

    // Pull the player's persisted state from the server. New users with
    // `onboardingDone === false` head into the Welcome flow first; everyone
    // else goes straight to Game. If the fetch fails (server down, no
    // network) we fall back to Game with a null state so the game is
    // still playable in some degraded form.
    let playerState: PlayerState | null = null;
    try {
      playerState = await fetchState();
    } catch (e) {
      console.warn('[preloader] fetchState failed; starting with no state', e);
    }

    const goToWelcome = playerState !== null && !playerState.onboardingDone;
    this.scene.start(
      goToWelcome ? SceneKeys.Welcome : SceneKeys.Game,
      { playerState },
    );
  }

  private async loadFontsOrTimeout(timeoutMs: number): Promise<void> {
    if (typeof document === 'undefined' || !document.fonts) return;
    const wantedFonts = [
      '400 16px "Pixeloid Sans"',
      '700 16px "Pixeloid Sans"',
    ];
    try {
      await Promise.race([
        Promise.all(wantedFonts.map((f) => document.fonts.load(f))),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    } catch {
      // Swallow — the game still runs with a fallback font, the layout
      // just might shift a touch when Pixeloid resolves later.
    }
  }
}
