import { Scene } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { AssetKeys } from '@/constants/assets';
import { Balance } from '@/constants/balance';
import { fetchState } from '@/services/state-client';
import { BACKGROUND_CATALOG, MEOW_STEM_CATALOG } from '@/../shared/state';
import type { PlayerState } from '@/../shared/state';
import { getUserOverride } from '@/../shared/user-overrides.generated';

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

    // Brand dark purple bg — overrides the game's default near-black
    // (#0b041a from game.ts) so the loading screen matches the stage
    // backdrop and feels like part of the game, not a chrome step
    // before it. Drawn as a full-canvas rect rather than swapping the
    // global config so MainMenu / Welcome / etc. still get the global
    // default when they don't draw their own bg.
    this.add.rectangle(0, 0, width, height, 0x1a0a2e).setOrigin(0, 0);

    // V21 logo centered in the top half — preloaded in Boot so it's
    // ready before this scene runs. Source PNG is 256px; we display at
    // 200px on a 320-wide design canvas (~62% width) which leaves
    // breathing room on the sides. `pixelated` rendering preserves the
    // pixel-art letter cells + cat sprites without smoothing them into
    // mush at this downscale.
    const logo = this.add
      .image(cx, height * 0.36, AssetKeys.Image.Logo)
      .setDisplaySize(200, 200);
    (logo.texture.source[0] as { scaleMode: number }).scaleMode = 0; // NEAREST

    // Loading bar: brand yellow fill, cream outline. Sits in the lower
    // third so the logo gets visual priority. Sized to 240×16 (vs the
    // old 468×32) since the design canvas is 320 wide — the old bar
    // was sized for a wider scene and looked oversized on the portrait
    // viewport.
    const barW = 240;
    const barH = 16;
    const barY = height * 0.62;

    this.add
      .rectangle(cx, barY, barW, barH)
      .setStrokeStyle(2, 0xfff8e7); // cream outline

    // Bar fill — anchored left at the inner edge of the outline so it
    // grows rightward without crossing the stroke. 2px inset on each
    // side leaves a 1px gap between fill and stroke.
    const inner = barW - 4;
    const fill = this.add
      .rectangle(cx - inner / 2, barY, 2, barH - 4, 0xffd34d)
      .setOrigin(0, 0.5);

    // "LOADING..." caption under the bar, using the brand font the
    // rest of the game uses (Pixeloid Sans, loaded via index.html's
    // CSS @font-face). Falls back to monospace if the webfont hasn't
    // resolved yet — the loading screen is short-lived so the fallback
    // is an acceptable first frame.
    this.add
      .text(cx, barY + 24, 'LOADING...', {
        fontFamily: 'Pixeloid Sans, monospace',
        fontSize: '10px',
        color: '#fff8e7',
      })
      .setOrigin(0.5);

    this.load.on('progress', (progress: number) => {
      fill.width = 2 + inner * progress;
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
    this.load.image(AssetKeys.Image.RhythmBarBackgroundWhite, 'images/rythmBarBackground-white.png');
    this.load.image(AssetKeys.Image.MeowcertTarget, 'images/PSTarget.png');
    this.load.image(AssetKeys.Image.MeowcertTargetWhite, 'images/PSTarget-white.png');
    this.load.image(AssetKeys.Image.MeowcertElement, 'images/PSElement.png');
    this.load.image(AssetKeys.Image.MeowcertElementBall, 'images/PSElement_ball.png');
    this.load.image(AssetKeys.Image.MeowcertElementBallWhite, 'images/PSElement_ball-white.png');
    this.load.image(AssetKeys.Image.MeowcertElementLetters, 'images/PSElement_letters.png');
    this.load.image(AssetKeys.Image.MeowcertTubeWhite, 'images/PSTube-white.png');
    // Only eager-load the default 'stage' bg — every other theme
    // lazy-loads on demand via BackgroundManager.setBackground() which
    // calls loadBgIfMissing() on first use. Was eagerly loading all
    // ~25 themes (~119MB cold-load); now ships ~1-2MB for the default.
    // Decorate's theme picker falls back to a placeholder rect for
    // un-loaded thumbnails (already-existing graceful path), then the
    // actual bg loads when the user taps to pick it.
    //
    // Prior lazy attempts failed because they used the active scene's
    // `this.load.image + start` (conflicted with hamburger drawer
    // tween) or native Image with URL-resolution issues in Devvit's
    // iframe. The new helper uses a fresh Phaser.Loader.LoaderPlugin
    // instance (no scene-state conflict) + setPath('assets') (Devvit
    // URL resolver). See entities/background-manager.ts loadBgIfMissing.
    const defaultBg = BACKGROUND_CATALOG['stage'];
    if (defaultBg) {
      this.load.image(defaultBg.backdropKey, `themes/${defaultBg.id}-bg.png`);
    }

    // Eager-load the small picker thumbnail for every theme. ~18KB per
    // PNG × ~100 themes = ~1.9MB total, vs the 119MB cold-load if we
    // eager-loaded full bgs. Decorate's BG tray now renders the thumb
    // texture (sharp picture) instead of a grey placeholder rect for
    // unloaded full bgs. Full bgs still lazy-load on equip via
    // BackgroundManager.setBackground() / loadBgIfMissing().
    // Backfilled by tools/gen-thumbs.mjs; per-theme regen via the
    // calibrator's "Save Thumb" button (POST /save-thumb/<id>).
    // If a thumb is missing (newly added theme that hasn't been
    // backfilled yet) Phaser swallows the 404 quietly and Decorate's
    // tray falls back to the placeholder rect for that one cell.
    for (const entry of Object.values(BACKGROUND_CATALOG)) {
      const thumbKey = `${entry.backdropKey}-thumb`;
      this.load.image(thumbKey, `themes/thumbs/${entry.id}-thumb.png`);
    }

    // Per-frame translation offsets for each cat animation. Cat.ts reads
    // this from cache to ride static cosmetics along with their cat. Falls
    // back to a no-op (no offset applied) if the file is missing.
    this.load.json(AssetKeys.Json.CatFrameOffsets, 'atlas/cat-frame-offsets.json');
    // Per-bg lane tint trios. Game.drawLanes reads from this so the lanes
    // pick up colors that already live in the active bg's floor. Falls
    // back to LANE_COLORS when the active bg isn't sampled.
    this.load.json(AssetKeys.Json.BgLaneColors, 'atlas/bg-lane-colors.json');

    this.load.audio(AssetKeys.Audio.Background, ['sounds/background.mp3']);
    this.load.audio(AssetKeys.Audio.Meowcert, ['sounds/meowcert.mp3']);
    this.load.audio(AssetKeys.Audio.ThemeDefaultMusic, ['themes/default-music.mp3']);
    this.load.audio(AssetKeys.Audio.ThemeSpookyMusic, ['themes/spooky-music.mp3']);
    // Lantern Tutorial is the home track under every menu + tutorial
    // beat — preload so scene entries are instant. Steel Phase Loop
    // still lazy-loads via systems/home-music.ts (only needed for the
    // insane joke run).
    this.load.audio(AssetKeys.Audio.LanternTutorial, ['audio/backings/lantern-tutorial.mp3']);

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

    // Extract a paws-only mask from the bar texture. Phaser's setTint
    // tints all pixels uniformly, so blend tricks can't isolate the
    // dark paw shapes from the light bar background. Reading pixel
    // data lets us keep only the dark pixels and emit them as a new
    // texture which Game.drawLanes overlays on top of the cat-colored
    // bar as a solid-pink layer.
    this.generatePawsOnlyTexture();

    // Tile-able body section from MeowcertTubeWhite's middle band — used
    // by Note's TileSprite tail so long stretches REPEAT the texture
    // instead of stretching it (no taper distortion).
    this.generateTailBodyTile();
    this.generateTailCapTexture();

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

    // Visitor entry — if Devvit gave us a postId AND that post has an
    // owner mapping (i.e. it's a published Meowcert show), land on
    // VisitPost so the user sees the show's splash. Owners viewing
    // their own posts also see VisitPost (useful for previewing how
    // visitors land); the splash's content adapts internally to
    // suppress visitor-only UI when isOwner is true.
    // Fire-and-forget: any failure (no post context, no owner mapping,
    // network error) falls through to the normal Welcome/Decorate path.
    let visitPostId: string | null = null;
    try {
      const init = await fetch('/api/init').then((r) => r.ok ? r.json() : null) as { postId?: string } | null;
      if (init?.postId) {
        const v = await fetch(`/api/visit?postId=${encodeURIComponent(init.postId)}`)
          .then((r) => r.ok ? r.json() : null) as { ownerUsername?: string } | null;
        // Owner-mapping presence is the gate (not isOwner) — if /api/visit
        // returns a 404 (post never published) we skip VisitPost; if it
        // returns a real owner, render the splash regardless of who's
        // viewing. Owner-visits-own-post still lands here so the player
        // can preview their show; the post-share / play paths still work.
        if (v?.ownerUsername) {
          visitPostId = init.postId;
        }
      }
    } catch (e) {
      console.warn('[preloader] visit detection failed; falling back to home flow', e);
    }

    // Dev-tooling user overrides (build-time bake from
    // tools/user-management/users.json — empty map in prod when no one
    // is listed). Two override types:
    //   - godmode: POST /api/dev/apply-godmode to grant max coins + every
    //     cat + every cosmetic + every background. Fires once per setAt
    //     bump; player.forcedGodmodeAppliedAt acts as the "consumed" flag.
    //   - tutorialCheck: force the player back through TutorialOrchestrator
    //     regardless of onboardingDone. Fires once per setAt bump;
    //     player.forcedTutorialClearedAt acts as the "consumed" flag (set
    //     by /api/onboarding/complete on tutorial finish). Resets the
    //     visitor-route flag so the standard cold-start route runs.
    if (playerState) {
      const override = getUserOverride(playerState.username);
      if (override) {
        if (override.godmode && override.setAt > (playerState.forcedGodmodeAppliedAt ?? 0)) {
          try {
            const r = await fetch('/api/dev/apply-godmode', { method: 'POST' });
            if (r.ok) {
              const j = await r.json() as { state: PlayerState };
              playerState = j.state;
              console.log('[preloader] godmode override applied for', playerState.username);
            } else {
              console.warn('[preloader] godmode apply failed:', r.status);
            }
          } catch (e) {
            console.warn('[preloader] godmode apply errored:', e);
          }
        }
        if (override.tutorialCheck && override.setAt > (playerState.forcedTutorialClearedAt ?? 0)) {
          // Don't touch onboardingDone server-side — let the orchestrator's
          // existing completion path flip it (and forcedTutorialClearedAt)
          // when the player finishes. Locally mutate so the routing below
          // picks the tutorial branch. tutorialStep cleared so the
          // orchestrator restarts from intro rather than resuming a stale
          // mid-run position.
          playerState.onboardingDone = false;
          playerState.tutorialStep = null;
          console.log('[preloader] tutorial override forced for', playerState.username);
        }
      }
    }

    // Tutorial routing — first-timers run the orchestrator before any
    // other scene. Two flavors:
    //   Route A: cold-start (no visitPostId) + first-time. Orchestrator
    //     runs through to route-a-outro → exits to Decorate.
    //   Route B: visitPostId + first-time. Orchestrator runs the same
    //     content but route-branch picks route-b-outro → exits to
    //     VisitPost(originalPostId) so the player lands on the friend's
    //     post the deep-link was for.
    // Resume on tab-reopen: playerState.tutorialStep is the index;
    // orchestrator starts there instead of 'intro'.
    const isFirstTime = playerState !== null && !playerState.onboardingDone;
    const resumeAt = playerState?.tutorialStep ?? undefined;

    if (visitPostId && isFirstTime) {
      this.scene.start(SceneKeys.TutorialOrchestrator, {
        playerState,
        originalPostId: visitPostId,
        ...(resumeAt ? { resumeAt } : {}),
      });
      return;
    }
    if (visitPostId) {
      this.scene.start(SceneKeys.VisitPost, { postId: visitPostId, playerState });
      return;
    }
    if (isFirstTime) {
      this.scene.start(SceneKeys.TutorialOrchestrator, {
        playerState,
        ...(resumeAt ? { resumeAt } : {}),
      });
      return;
    }
    // Always land in Decorate post-onboarding — that's where the player
    // sees their cat house. They can hit Play from the hamburger when
    // they're ready. (Fresh state seeds 3 cats + seats them so this
    // works immediately without an empty Decorate screen.)
    this.scene.start(SceneKeys.Decorate, { playerState });
  }

  /** Build a paws-only mask from the bar-background texture. Pixels
   *  darker than `paw threshold` are turned WHITE (so any tint reads
   *  cleanly), pixels brighter become fully transparent. Game.drawLanes
   *  renders this as a pink-tinted overlay on top of the cat-color bar
   *  so the toe beans read SOLID pink instead of a darkened shade of
   *  the cat color.
   *
   *  Registered under 'rhythm-bar-paws'. Safe to no-op (try/catch) on
   *  any failure — the lane still falls back to the existing texture
   *  with no pink overlay, just no toe-bean color call-out. */
  /** Generate a tile-able body section from the middle band of
   *  MeowcertTubeWhite. The middle 25 % is uniform top-to-bottom (the
   *  flat parallel-sided section between the rounded caps), so tiling
   *  it vertically gives a seamless continuous tube — no taper, no
   *  visible seams. 44 × 32 size keeps the tile small for cheap GPU
   *  uploads while still capturing the fuzzy left/right edges cleanly. */
  private generateTailBodyTile(): void {
    const KEY = 'tail-body';
    const TARGET_W = 44;
    const TARGET_H = 32;
    const BAND_FRACTION = 0.25;
    if (this.textures.exists(KEY)) return;
    try {
      const source = this.textures.get(AssetKeys.Image.MeowcertTubeWhite);
      const srcImage = source.getSourceImage() as HTMLImageElement | HTMLCanvasElement;
      const srcW = srcImage.width;
      const srcH = srcImage.height;
      if (!srcW || !srcH) return;
      const bandH = Math.max(1, Math.floor(srcH * BAND_FRACTION));
      const bandY = Math.floor((srcH - bandH) / 2);
      const canvas = this.textures.createCanvas(KEY, TARGET_W, TARGET_H);
      if (!canvas) return;
      const ctx = canvas.getContext();
      ctx.clearRect(0, 0, TARGET_W, TARGET_H);
      ctx.drawImage(srcImage, 0, bandY, srcW, bandH, 0, 0, TARGET_W, TARGET_H);
      canvas.refresh();
    } catch (err) {
      console.warn('[Preloader] tail-body texture build failed:', err);
    }
  }

  /** Generate the rounded end-cap texture from the TOP slice of
   *  MeowcertTubeWhite. Sits on top of the body TileSprite so the tail
   *  terminates with a proper rounded end instead of a flat tile edge.
   *  44 × 32 to match TAIL_WIDTH × cap height. */
  private generateTailCapTexture(): void {
    const KEY = 'tail-cap';
    const TARGET_W = 44;
    const TARGET_H = 32;
    const BAND_FRACTION = 0.25;
    if (this.textures.exists(KEY)) return;
    try {
      const source = this.textures.get(AssetKeys.Image.MeowcertTubeWhite);
      const srcImage = source.getSourceImage() as HTMLImageElement | HTMLCanvasElement;
      const srcW = srcImage.width;
      const srcH = srcImage.height;
      if (!srcW || !srcH) return;
      const bandH = Math.max(1, Math.floor(srcH * BAND_FRACTION));
      const canvas = this.textures.createCanvas(KEY, TARGET_W, TARGET_H);
      if (!canvas) return;
      const ctx = canvas.getContext();
      ctx.clearRect(0, 0, TARGET_W, TARGET_H);
      // Top slice of the source — preserves the rounded crown.
      ctx.drawImage(srcImage, 0, 0, srcW, bandH, 0, 0, TARGET_W, TARGET_H);
      canvas.refresh();
    } catch (err) {
      console.warn('[Preloader] tail-cap texture build failed:', err);
    }
  }

  private generatePawsOnlyTexture(): void {
    const KEY = 'rhythm-bar-paws';
    if (this.textures.exists(KEY)) return;
    try {
      const source = this.textures.get(AssetKeys.Image.RhythmBarBackgroundWhite);
      const srcImage = source.getSourceImage() as HTMLImageElement | HTMLCanvasElement;
      const w = srcImage.width;
      const h = srcImage.height;
      if (!w || !h) return;
      const canvas = this.textures.createCanvas(KEY, w, h);
      if (!canvas) return;
      const ctx = canvas.getContext();
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(srcImage, 0, 0);
      const img = ctx.getImageData(0, 0, w, h);
      const data = img.data;
      // Combined check — neither brightness alone nor saturation
      // alone got there cleanly. A pixel counts as a paw if it's
      // EITHER medium-dark + colored (typical brown paw fill) OR
      // outright dark (paw outline / dark grey shadow inside a paw).
      // This catches the full paw shape regardless of whether the
      // asset's paw browns are saturated or pretty close to grey,
      // while still leaving the near-white bar body untouched.
      const BRIGHT_OUTLINE = 130;     // anything this dark = paw
      const BRIGHT_FILL    = 200;     // medium-dark fill ...
      const SAT_FILL       = 0.06;    // ... PLUS slight color = paw
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]!;
        const g = data[i + 1]!;
        const b = data[i + 2]!;
        const brightness = (r + g + b) / 3;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const saturation = max === 0 ? 0 : (max - min) / max;
        const isPaw =
          brightness < BRIGHT_OUTLINE ||
          (brightness < BRIGHT_FILL && saturation > SAT_FILL);
        if (isPaw) {
          // Flatten to opaque white so the Phaser tint comes through
          // as a solid color. Alpha pinned to 255 explicitly — some
          // browser image-loading paths leave premultiplied alpha
          // surprises.
          data[i] = 255;
          data[i + 1] = 255;
          data[i + 2] = 255;
          data[i + 3] = 255;
        } else {
          data[i + 3] = 0;
        }
      }
      ctx.putImageData(img, 0, 0);
      canvas.refresh();
    } catch (err) {
      console.warn('[Preloader] paws-only texture build failed:', err);
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
