import { Scene } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { AssetKeys } from '@/constants/assets';
import { Balance } from '@/constants/balance';
import { fetchState } from '@/services/state-client';
import { BACKGROUND_CATALOG, MEOW_STEM_CATALOG } from '@/../shared/state';
import type { PlayerState } from '@/../shared/state';

// All logical cat breeds. 'rainbow' has no atlas frames of its own — it borrows
// cat6's frames but registers them under its own animation keys so the Cat entity
// can play them via `rainbow_idle`, `rainbow_happy`, `rainbow_hiss`.
const CAT_BREEDS = ['cat1', 'cat2', 'cat3', 'cat4', 'cat5', 'cat6', 'rainbow'] as const;
const RAINBOW_RENDER_BREED = 'cat6';

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
    // Backgrounds loaded straight from the catalog so adding a new bg via
    // the themes calibrator (which writes themes.json → regens the catalog)
    // gets picked up automatically. No per-bg AssetKeys entry needed.
    for (const bg of Object.values(BACKGROUND_CATALOG)) {
      this.load.image(bg.backdropKey, `themes/${bg.id}-bg.png`);
    }

    // Per-frame translation offsets for each cat animation. Cat.ts reads
    // this from cache to ride static cosmetics along with their cat. Falls
    // back to a no-op (no offset applied) if the file is missing.
    this.load.json(AssetKeys.Json.CatFrameOffsets, 'atlas/cat-frame-offsets.json');

    this.load.audio(AssetKeys.Audio.Background, ['sounds/background.mp3']);
    this.load.audio(AssetKeys.Audio.Pspsps, ['sounds/pspsps.mp3']);
    this.load.audio(AssetKeys.Audio.ThemeDefaultMusic, ['themes/default-music.mp3']);
    this.load.audio(AssetKeys.Audio.ThemeCozyMusic, ['themes/cozy-music.mp3']);
    this.load.audio(AssetKeys.Audio.ThemeSpookyMusic, ['themes/spooky-music.mp3']);

    // Meow stems are tiny (~50KB each) so they all preload — the cost
    // of upfront-loading the whole pool is well under a single backing
    // and avoids any tap latency on first meow.
    for (const stem of MEOW_STEM_CATALOG) {
      this.load.audio(stem.audioKey, `audio/meows/${stem.id}.wav`);
    }

    // BACKING_CATALOG entries are lazy-loaded by MusicSystem.preload()
    // when the round boots — visitors only ever download the song the
    // host's chart resolves to (~500KB at 96kbps mono), not the whole
    // library.
  }

  async create() {
    // Make sure the Pixeloid Sans face is actually loaded into the browser
    // before we kick off the next scene, otherwise the first frame of
    // Phaser text would render with the system sans-serif and the layout
    // would shift when the font finishes loading.
    await this.loadFontsOrTimeout(2500);

    // Register all cat animations globally so every downstream scene
    // (Game, Decorate, DressingRoom, Purchase) can play them without each
    // scene needing its own lazy-registration pass. The Cat entity's
    // ensureAnimation() skips keys that already exist, so this is safe to
    // run even if a scene also calls ensureAnimation().
    this.registerCatAnimations();

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
    if (goToWelcome) {
      this.scene.start(SceneKeys.Welcome, { playerState });
    } else {
      // Always land in Decorate post-onboarding — that's where the player
      // sees their cat house. They can hit Play from the hamburger when
      // they're ready. (Fresh state seeds 3 cats + seats them so this
      // works immediately without an empty Decorate screen.)
      this.scene.start(SceneKeys.Decorate, { playerState });
    }
  }

  /**
   * Register idle/happy/hiss animations for every cat breed globally so all
   * downstream scenes can play them without per-scene lazy registration.
   *
   * Frame naming convention: `${breed}_${anim}_NN` (e.g. `cat1_idle_00`).
   * 'rainbow' has no atlas frames — it borrows cat6's and registers them under
   * `rainbow_*` keys.
   *
   * Atlas state (June 2026):
   *   idle  — all 6 breeds (cat1–cat6)
   *   hiss  — all 6 breeds
   *   meow  — all 6 breeds (used by Game scene on rhythm hit)
   *   happy — cat5 and cat6 only; cat1–cat4 lack happy frames in the atlas.
   *            Cat.playHappy() guards with anims.exists(), so missing happy
   *            keys are safe — the cat just holds its current frame and tints.
   */
  private registerCatAnimations(): void {
    const atlas = this.textures.get(AssetKeys.Atlas.Cats);
    const allFrameNames = atlas.getFrameNames();

    // Discover every actual breed prefix in the atlas (cat1, cat2, …, cat7,
    // cat8 — any Color Repick variant the extractor packed). The hardcoded
    // CAT_BREEDS list still covers `rainbow` (which has no frames of its
    // own — uses cat6's), so we union the two sets.
    const discoveredBreeds = new Set<string>();
    for (const name of allFrameNames) {
      const m = /^(cat\d+)_/.exec(name);
      if (m) discoveredBreeds.add(m[1]!);
    }
    const allBreeds = [
      ...new Set<string>([...CAT_BREEDS, ...discoveredBreeds]),
    ];

    for (const breed of allBreeds) {
      const renderBreed = breed === 'rainbow' ? RAINBOW_RENDER_BREED : breed;

      for (const anim of ['idle', 'happy', 'hiss', 'meow'] as const) {
        const key = `${breed}_${anim}`;
        if (this.anims.exists(key)) continue;

        const prefix = `${renderBreed}_${anim}_`;
        const frames = allFrameNames
          .filter((n) => n.startsWith(prefix))
          .sort()
          .map((frame) => ({ key: AssetKeys.Atlas.Cats, frame }));

        if (frames.length === 0) {
          // happy is expected to be missing for cat1–cat4; log but don't crash.
          // eslint-disable-next-line no-console
          console.error(`[Preloader] no frames for ${key} in cats atlas — animation NOT registered`);
          continue;
        }

        // Idle stays slow + breathy at the global cadence. Hiss + meow are
        // reaction animations the player triggers on a tap — they need to
        // read as a quick punch, not a leisurely stretch. Bumped to 16fps
        // so the full clip lands close to Balance.catReactionMs.
        const isReaction = anim === 'hiss' || anim === 'meow';
        this.anims.create({
          key,
          frames,
          frameRate: isReaction ? 16 : Balance.catAnimationFrameRate,
          repeat: anim === 'idle' ? -1 : 0,
        });
      }
    }
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
