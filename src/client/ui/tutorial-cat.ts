import * as Phaser from 'phaser';
import { Scene, GameObjects } from 'phaser';
import { AssetKeys } from '@/constants/assets';

/**
 * Tutorial-host cat overlay — the visual representation of "Whiskers"
 * narrating the tutorial. Renders a cat sprite (top-left of the
 * dialogue zone) + a speech-bubble background + the dialogue line +
 * an optional Continue button.
 *
 * Composable: any scene that needs the overlay (orchestrator + the
 * guided-mode steps in Decorate / Game / ChartEditor in later phases)
 * instantiates one, calls show() with the current line + an onContinue
 * callback, and calls hide() / destroy() when done.
 *
 * The host cat uses an existing breed not in the starter pool so it
 * never collides with the player's pick. cat6 (Inkwell, rare) is the
 * pick — present in the cats atlas as `cat6_idle_00`.
 */

const HOST_BREED_FRAME = 'cat12_idle_00';
const HOST_ACCESSORY_FRAME = 'cosmetic_c2_idle_00'; // Grey Glasses
const SPEECH_BUBBLE_COLOR = 0xfff8e7;
const TEXT_COLOR = '#1a0a2e';
const CONTINUE_FILL = 0xffd34d;
const CONTINUE_TEXT = '#1a0a2e';

/** Register a cosmetic's idle animation lazily — the Cat entity does
 *  this internally per cosmetic, but the tutorial overlay sidesteps
 *  Cat and renders a raw sprite, so it needs to register the loop
 *  itself. Returns the anim key on success, '' if no frames matched. */
function ensureCosmeticIdleAnim(scene: Scene, cosmeticRenderId: string): string {
  const key = `cosmetic_${cosmeticRenderId}_idle`;
  if (scene.anims.exists(key)) return key;
  const atlas = scene.textures.get(AssetKeys.Atlas.Cosmetics);
  const prefix = `cosmetic_${cosmeticRenderId}_idle_`;
  const frames = atlas
    .getFrameNames()
    .filter((n) => n.startsWith(prefix))
    .sort()
    .map((frame) => ({ key: AssetKeys.Atlas.Cosmetics, frame }));
  if (frames.length === 0) return '';
  scene.anims.create({ key, frames, frameRate: 7, repeat: -1 });
  return key;
}

interface ShowOptions {
  /** Optional Continue button. When omitted, the overlay is dialogue-
   *  only — the caller controls dismissal externally (e.g. a guided-
   *  mode step that advances on a real game action). */
  onContinue?: () => void;
  /** Default 'Continue →'. Override for "Next →" on multi-line beats. */
  continueLabel?: string;
  /** When true: Butters is rendered large + centered to fill the
   *  screen ('hero' intro layout). Used by the very first tutorial
   *  beat per Tim's feedback ("make butters big and then move him to
   *  the current position for the next screen on"). */
  hero?: boolean;
  /** Override the bubble's top Y. Defaults to 28 (top of canvas).
   *  Push down on merch beats so the bubble sits just above the big
   *  seated cat instead of leaving a giant gap in the middle. */
  bubbleY?: number;
  /** Override the Continue button's center Y. Defaults to `height - 60`.
   *  Editor-tour passes a higher value so the Continue/Next button sits
   *  above the editor mock's bottom strip (REHEARSE row) instead of
   *  covering it. */
  continueY?: number;
  /** Stage-mode layout — Butters is ALREADY rendered elsewhere on the
   *  canvas (e.g. seated at the left lane during play-tutorial); the
   *  overlay skips the inline Butters sprite and draws only the bubble
   *  with its tail pointing at the given anchor (Butters' face). Used
   *  by the rehearsal beats per Tim's feedback ("butters can shrink
   *  down... where the usual other band member goes"). */
  stageTailAt?: { x: number; y: number };
  /** Center the bubble's TIP horizontally on this X. Pairs with
   *  stageTailAt so the bubble width is constrained and the tail
   *  reads as a callout from Butters, not a top-of-screen banner. */
  stageBubbleCenterX?: number;
  /** Tween Butters in from the hero pose (centered, scale 2.5) to the
   *  destination pose for this layout. Bubble + button fade in after
   *  the tween lands. Used on the intro → pick-stage transition so
   *  Butters' move reads as motion, not a snap. */
  tweenFromHero?: boolean;
}

/** Depth layers for the tutorial overlay. Butters' sprite sits BELOW
 *  any in-scene mock (e.g. the hamburger-menu drawer at 1000-1002) so
 *  things like a drawer overlay cover his body cleanly; the bubble +
 *  Continue button live ABOVE that so the dialogue is always readable.
 *  Tim Image 31: "you can have the menu overlap butters here instead
 *  of butters over the menu." */
const BUTTERS_DEPTH = 500;
const BUBBLE_DEPTH = 2050;
const BUTTON_DEPTH = 2100;

export class TutorialCatOverlay {
  private container: GameObjects.Container | undefined;
  /** Butters' sprites — kept OUTSIDE the bubble container so they can
   *  sit at a lower depth than scene-level mocks (hamburger drawer).
   *  Cleaned up explicitly in hide(). */
  private buttersSprites: GameObjects.GameObject[] = [];
  private scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  /** Build (or rebuild) the overlay with the given dialogue. Safe to
   *  call repeatedly — each call tears down the previous render. */
  show(dialogue: string, opts: ShowOptions = {}): void {
    this.hide();

    const { width, height } = this.scene.scale;
    this.container = this.scene.add.container(0, 0);
    this.container.setDepth(BUBBLE_DEPTH);

    // -- Host cat sprite ----------------------------------------------
    // Two layouts:
    //   hero (intro only): centered + scale 3.2, fills the screen so
    //     Butters has full-screen presence at first introduction.
    //   normal (default): top-left at scale 1.7, bubble runs from his
    //     head across the top of the screen.
    const hero = opts.hero === true;
    const stageMode = opts.stageTailAt !== undefined;
    const tweenFromHero = opts.tweenFromHero === true && !stageMode && !hero;
    let catX = 0;
    let catY = 0;
    let catSprite: GameObjects.Sprite | undefined;
    let accessorySprite: GameObjects.Sprite | undefined;
    if (!stageMode) {
      const catScale = hero ? 2.5 : 1.7;
      catX = hero ? width / 2 : 60;
      catY = hero ? 320 : 220;
      // tweenFromHero: place Butters at the HERO pose first so we can
      // animate him toward the destination pose for this layout. Bubble
      // + tail + button start hidden and fade in once Butters arrives.
      const startX = tweenFromHero ? width / 2 : catX;
      const startY = tweenFromHero ? 320 : catY;
      const startScale = tweenFromHero ? 2.5 : catScale;
      catSprite = this.scene.add
        .sprite(startX, startY, AssetKeys.Atlas.Cats, HOST_BREED_FRAME)
        .setOrigin(0.5, 1)
        .setScale(startScale)
        .setDepth(BUTTERS_DEPTH);
      // Play the idle anim so Butters' tail wags instead of standing
      // as a still frame. Preloader pre-registered every breed_idle
      // key, so this just kicks off the loop.
      catSprite.play('cat12_idle', true);
      // Kept at scene level (NOT in container) so its low depth can be
      // honored — children of a container share the container's depth.
      this.buttersSprites.push(catSprite);

      // Grey glasses accessory — Butters' tutorial-host signature.
      // Cosmetic anims aren't pre-registered (Cat entity does it
      // lazily); register on first use here so the glasses bob along
      // with the head idle instead of holding frame 00 while the cat
      // moves underneath.
      const accessoryAnimKey = ensureCosmeticIdleAnim(this.scene, 'c2');
      accessorySprite = this.scene.add
        .sprite(startX, startY, AssetKeys.Atlas.Cosmetics, HOST_ACCESSORY_FRAME)
        .setOrigin(0.5, 1)
        .setScale(startScale)
        .setDepth(BUTTERS_DEPTH + 1);
      if (accessoryAnimKey) accessorySprite.play(accessoryAnimKey, true);
      this.buttersSprites.push(accessorySprite);

      // BUTTERS nametag — Game.seatCats style (Courier New, white with
      // black stroke). Font size scales proportionally with the cat's
      // scale per Tim Image 31: "nametag size should be proportional
      // to their body size always. so bigger now when hes in front and
      // smaller later when hes on the stage." Reference: 10px at the
      // standard Game.seatCats scale of 1.4.
      const nameFontPx = Math.round(10 * catScale / 1.4);
      // At hero scale the default crisp/anti-aliased TTF render makes the
      // nametag feel out of place next to the pixel cat. Drop the canvas
      // resolution + NEAREST-filter the texture so the upscale looks
      // pixelated like the rest of the sprite work. Same pattern as the
      // cat-effects emoji pixelation. Below scale 2 the small canvas would
      // be unreadable, so the original crisp path stays for stage size.
      const heroPixelate = catScale >= 2;
      const nameSprite = this.scene.add
        .text(startX, startY + 4, 'BUTTERS', {
          fontFamily: '"Courier New", monospace',
          fontStyle: 'bold',
          fontSize: `${nameFontPx}px`,
          color: '#ffffff',
          stroke: '#000000',
          strokeThickness: 3,
          ...(heroPixelate ? { resolution: 0.5 } : {}),
        })
        .setOrigin(0.5, 0)
        .setDepth(BUTTERS_DEPTH + 2);
      if (heroPixelate) {
        nameSprite.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
      }
      // Sits at the Butters depth (below scene mocks) instead of in the
      // bubble container so the menu drawer covers the nametag along
      // with the cat body.
      this.buttersSprites.push(nameSprite);
      // Stash on the cat sprite so the tween below can drag the label
      // along with the cat in tweenFromHero mode without an extra
      // closure-captured reference.
      (catSprite as unknown as { __nameSprite?: GameObjects.Text }).__nameSprite = nameSprite;
    }

    // -- Dialogue text + auto-sized speech bubble ---------------------
    // Per Tim: bubble must always be the height of the text — no
    // whitespace under it. Approach: render the text first to measure
    // its height, then draw the bubble + tail sized to fit.
    // Hero layout puts the bubble at the top spanning the canvas;
    // normal layout puts it beside Butters in the top-right zone.
    // Per Tim feedback (Image 24): always keep whitespace between
    // bubble borders and screen sides — sideMargin bumped to 24.
    const sideMargin = 24;
    let bubbleX: number;
    let bubbleY: number;
    let bubbleW: number;
    if (stageMode) {
      // Narrower (210 vs 240) and pulled UP into the dead zone above
      // the lanes per Tim Image 31: "the arrow off textbox should be
      // here to not cover the lane too much." bubbleY 220 sits the
      // bubble's top high in the cat-stage band so its body extends
      // down into the lanes less than before.
      bubbleW = Math.min(width - sideMargin * 2, 210);
      const cx = opts.stageBubbleCenterX ?? width / 2;
      bubbleX = Math.max(sideMargin, Math.min(cx - bubbleW / 2, width - sideMargin - bubbleW));
      // Image 32: "text box should be slightly higher" — 220 → 195
      // shifts the bubble further into the cat-stage dead zone.
      bubbleY = opts.bubbleY ?? 195;
    } else if (hero) {
      bubbleX = sideMargin;
      bubbleY = opts.bubbleY ?? 28;
      bubbleW = width - sideMargin * 2;
    } else {
      // catX + 90 clears Butters' visible silhouette — sprite frame is
      // 91×64 (per the cosmetic spec), so at scale 1.7 his body extends
      // to ~x=catX+77. catX+50 (previous) put the bubble's rounded
      // left corner ON his ear/cheek; catX+90 leaves a clean ~13px
      // gap. Image 32 root cause: bubbleX has never been moved across
      // any prior tail tweak.
      bubbleX = catX + 90;
      bubbleY = opts.bubbleY ?? 28;
      bubbleW = Math.min(width - bubbleX - sideMargin, 220);
    }
    const bubblePadding = 16;
    const bubbleRadius = 20;

    const text = this.scene.add
      .text(bubbleX + bubblePadding, bubbleY + bubblePadding, dialogue, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '11px',
        color: TEXT_COLOR,
        wordWrap: { width: bubbleW - bubblePadding * 2 },
        lineSpacing: 2,
      })
      .setOrigin(0, 0);

    // Use measured text height + symmetric padding for the bubble's
    // height. Floor 50 so a one-line beat still has a sensible shape.
    const bubbleH = Math.max(50, text.height + bubblePadding * 2);

    // -- Tail target: where the tip should point. Tim Image 31 clarified:
    // tail points at Butters' FACE on every layout (not under him), but
    // stopShort ensures it never overlaps his head. Stage mode uses the
    // caller-supplied anchor.
    const rawTipX = stageMode ? opts.stageTailAt!.x : (hero ? catX : catX + 16);
    const rawTipY = stageMode ? opts.stageTailAt!.y : (hero ? catY - 200 : catY - 60);

    // -- Tail anchor: hero ONLY uses the middle of the bubble edge
    // nearest the tip; every other layout uses the bubble CORNER
    // nearest Butters. Tim Image 31: "only the very first one should
    // have the arrow coming out from the middle for all others it
    // should still be to the nearest corner."
    const bubbleCx = bubbleX + bubbleW / 2;
    const bubbleCy = bubbleY + bubbleH / 2;
    let anchorX: number, anchorY: number;
    if (hero) {
      const dxToTip = rawTipX - bubbleCx;
      const dyToTip = rawTipY - bubbleCy;
      if (Math.abs(dxToTip) * bubbleH > Math.abs(dyToTip) * bubbleW) {
        anchorX = dxToTip > 0 ? bubbleX + bubbleW : bubbleX;
        anchorY = bubbleCy;
      } else {
        anchorX = bubbleCx;
        anchorY = dyToTip > 0 ? bubbleY + bubbleH : bubbleY;
      }
    } else {
      // Pick the corner of the bubble nearest the tip; pulled inward
      // past the rounded-corner radius so the tail base attaches to
      // straight edge, not the curved corner pixels.
      const tailOffset = bubbleRadius + 4;
      const corners = [
        { x: bubbleX + tailOffset,           y: bubbleY + tailOffset },
        { x: bubbleX + bubbleW - tailOffset, y: bubbleY + tailOffset },
        { x: bubbleX + tailOffset,           y: bubbleY + bubbleH - tailOffset },
        { x: bubbleX + bubbleW - tailOffset, y: bubbleY + bubbleH - tailOffset },
      ];
      let best = corners[0]!;
      let bestDist = Infinity;
      for (const c of corners) {
        const d = Math.hypot(c.x - rawTipX, c.y - rawTipY);
        if (d < bestDist) { bestDist = d; best = c; }
      }
      anchorX = best.x;
      anchorY = best.y;
    }

    // Pull the cap CENTER back along the line so the cap's outer edge
    // never overlaps Butters' face — stopShort 40 in non-hero layouts
    // gives a clear gap. Hero uses 30 since the bubble is far above.
    const stopShort = hero ? 30 : 40;
    const dx = rawTipX - anchorX;
    const dy = rawTipY - anchorY;
    const fullDist = Math.hypot(dx, dy);
    const targetDist = Math.max(20, fullDist - stopShort);
    const ratio = fullDist > 0 ? targetDist / fullDist : 0;
    const tipX = anchorX + dx * ratio;
    const tipY = anchorY + dy * ratio;

    // -- Tapered teardrop tail per Tim Image 33: "filled in starting
    // wider and the becoming narrow with a rounded tip." Wide base at
    // the bubble edge (16px) tapers to a narrow tip (6px) with a small
    // half-circle cap. NOT a constant-width capsule — the previous
    // shape read as phallic; this one reads as a comma / teardrop.
    const baseHalfW = 14;  // 28px wide where it joins the bubble (Image 34)
    const tipHalfW  = 3;   // 6px wide just before the rounded cap
    const ux = fullDist > 0 ? dx / fullDist : 0;
    const uy = fullDist > 0 ? dy / fullDist : 0;
    const px = -uy;
    const py = ux;
    const baseLeftX  = anchorX + px * baseHalfW;
    const baseLeftY  = anchorY + py * baseHalfW;
    const baseRightX = anchorX - px * baseHalfW;
    const baseRightY = anchorY - py * baseHalfW;
    const tipLeftX  = tipX + px * tipHalfW;
    const tipLeftY  = tipY + py * tipHalfW;
    const tipRightX = tipX - px * tipHalfW;
    const tipRightY = tipY - py * tipHalfW;
    const tailGfx = this.scene.add.graphics();
    tailGfx.fillStyle(SPEECH_BUBBLE_COLOR, 1);
    tailGfx.fillPoints([
      { x: baseLeftX,  y: baseLeftY  },
      { x: tipLeftX,   y: tipLeftY   },
      { x: tipRightX,  y: tipRightY  },
      { x: baseRightX, y: baseRightY },
    ], true);
    tailGfx.fillCircle(tipX, tipY, tipHalfW);
    this.container.add(tailGfx);

    const bubbleGfx = this.scene.add.graphics();
    bubbleGfx.fillStyle(SPEECH_BUBBLE_COLOR, 1);
    bubbleGfx.fillRoundedRect(bubbleX, bubbleY, bubbleW, bubbleH, bubbleRadius);
    this.container.add(bubbleGfx);
    this.container.add(text);

    // -- Continue button ---------------------------------------------
    let btnBg: GameObjects.Rectangle | undefined;
    let btnText: GameObjects.Text | undefined;
    if (opts.onContinue) {
      const label = opts.continueLabel ?? 'Continue →';
      const btnY = opts.continueY ?? height - 60;
      const btnW = 220;
      const btnH = 52;
      btnBg = this.scene.add
        .rectangle(width / 2, btnY, btnW, btnH, CONTINUE_FILL, 1)
        .setInteractive({ useHandCursor: true })
        .setDepth(BUTTON_DEPTH);
      btnBg.setStrokeStyle(2, 0x1a0a2e, 1);
      btnText = this.scene.add
        .text(width / 2, btnY, label, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '16px',
          color: CONTINUE_TEXT,
        })
        .setOrigin(0.5)
        .setDepth(BUTTON_DEPTH + 1);
      // Continue lives ABOVE the bubble container so a tall multi-line
      // bubble can't visually clip the tap target.
      this.container.add([btnBg, btnText]);
      const localBtnBg = btnBg;
      const localBtnText = btnText;
      btnBg.on('pointerdown', () => {
        // Disable the button on first tap so rapid-fire taps during
        // the 160ms feedback tween can't queue up multiple onContinue
        // calls — without this, hammering Continue on a box-open beat
        // fires openBox() three or four times before busy flips,
        // opening more boxes than the script allows.
        localBtnBg.disableInteractive();
        this.scene.tweens.add({
          targets: [localBtnBg, localBtnText],
          scale: 0.96,
          duration: 80,
          yoyo: true,
          onComplete: () => opts.onContinue?.(),
        });
      });
    }

    // -- tweenFromHero: animate Butters from the hero pose to the
    // destination pose, fade bubble + button in on arrival. Skipped
    // for hero + stage layouts (they don't have a separate destination).
    if (tweenFromHero && catSprite && accessorySprite) {
      const fadeTargets: GameObjects.GameObject[] = [tailGfx, bubbleGfx, text];
      if (btnBg) fadeTargets.push(btnBg);
      if (btnText) fadeTargets.push(btnText);
      for (const obj of fadeTargets) {
        (obj as unknown as { setAlpha: (a: number) => unknown }).setAlpha(0);
      }
      const destScale = 1.7;
      const moveTargets: GameObjects.GameObject[] = [catSprite, accessorySprite];
      // Drag the BUTTERS nametag along with the cat — the nametag sits
      // 4px below the cat's bottom edge, so tween its y to catY + 4.
      const nameSprite = (catSprite as unknown as { __nameSprite?: GameObjects.Text }).__nameSprite;
      if (nameSprite) {
        this.scene.tweens.add({
          targets: nameSprite,
          x: catX,
          y: catY + 4,
          duration: 420,
          ease: 'Cubic.Out',
        });
      }
      this.scene.tweens.add({
        targets: moveTargets,
        x: catX,
        y: catY,
        scale: destScale,
        duration: 420,
        ease: 'Cubic.Out',
        onComplete: () => {
          this.scene.tweens.add({
            targets: fadeTargets,
            alpha: 1,
            duration: 180,
            ease: 'Linear',
          });
        },
      });
    }
  }

  /** Tear down the overlay container AND the scene-level Butters
   *  sprites. Idempotent — calling on an already-hidden overlay is a
   *  no-op. */
  hide(): void {
    if (this.container) {
      this.scene.tweens.killTweensOf(this.container);
      this.container.destroy(true);
      this.container = undefined;
    }
    for (const obj of this.buttersSprites) {
      this.scene.tweens.killTweensOf(obj);
      obj.destroy();
    }
    this.buttersSprites = [];
  }

  /** Destroy ONLY the dialogue container (bubble + Continue button +
   *  tail). Keeps the scene-level Butters sprite alive so the narrator
   *  remains on-stage during overlays (e.g., box-open animation) that
   *  would otherwise leave the screen feeling abandoned. The caller is
   *  responsible for the final destroy() to clean up the cat sprite. */
  hideBubbleOnly(): void {
    if (this.container) {
      this.scene.tweens.killTweensOf(this.container);
      this.container.destroy(true);
      this.container = undefined;
    }
  }

  destroy(): void {
    this.hide();
  }
}
