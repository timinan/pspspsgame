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

const HOST_BREED_FRAME = 'cat13_idle_00';
const HOST_ACCESSORY_FRAME = 'cosmetic_c2_idle_00'; // Grey Glasses
const SPEECH_BUBBLE_COLOR = 0xfff8e7;
const TEXT_COLOR = '#1a0a2e';
const CONTINUE_FILL = 0xffd34d;
const CONTINUE_TEXT = '#1a0a2e';

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
}

export class TutorialCatOverlay {
  private container: GameObjects.Container | undefined;
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
    this.container.setDepth(2000);

    // -- Host cat sprite ----------------------------------------------
    // Two layouts:
    //   hero (intro only): centered + scale 3.2, fills the screen so
    //     Butters has full-screen presence at first introduction.
    //   normal (default): top-left at scale 1.7, bubble runs from his
    //     head across the top of the screen.
    const hero = opts.hero === true;
    const stageMode = opts.stageTailAt !== undefined;
    let catX = 0;
    let catY = 0;
    if (!stageMode) {
      const catScale = hero ? 2.5 : 1.7;
      catX = hero ? width / 2 : 60;
      catY = hero ? 320 : 220;
      const catSprite = this.scene.add
        .sprite(catX, catY, AssetKeys.Atlas.Cats, HOST_BREED_FRAME)
        .setOrigin(0.5, 1)
        .setScale(catScale);
      this.container.add(catSprite);

      // Grey glasses accessory — Butters' tutorial-host signature.
      const accessorySprite = this.scene.add
        .sprite(catX, catY, AssetKeys.Atlas.Cosmetics, HOST_ACCESSORY_FRAME)
        .setOrigin(0.5, 1)
        .setScale(catScale);
      this.container.add(accessorySprite);
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
      const cx = opts.stageBubbleCenterX ?? width / 2;
      bubbleW = Math.min(width - sideMargin * 2, 240);
      bubbleX = Math.max(sideMargin, Math.min(cx - bubbleW / 2, width - sideMargin - bubbleW));
      bubbleY = opts.bubbleY ?? 250;
    } else if (hero) {
      bubbleX = sideMargin;
      bubbleY = opts.bubbleY ?? 28;
      bubbleW = width - sideMargin * 2;
    } else {
      bubbleX = catX + 50;
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

    // -- Tail target: where the tip should point.
    // hero: Butters' head (top of the big seated sprite).
    // normal: face just above his shoulders.
    // stage: caller-supplied stageTailAt.
    const tipX = stageMode ? opts.stageTailAt!.x : (hero ? catX : catX + 16);
    const tipY = stageMode ? opts.stageTailAt!.y : (hero ? catY - 200 : catY - 60);

    // -- Tail emerges from the bubble corner nearest the tip. Two base
    // vertices live on the two edges adjacent to the chosen corner
    // (offset past the rounded-corner radius so the edges fuse cleanly
    // with the bubble fill); third vertex is the tip. Drawn UNDER the
    // bubble so the two shapes read as one organic silhouette per
    // Tim's Image 26 sketch ("come out of the nearest corner... like
    // how i have it").
    const tailOffset = bubbleRadius + 6;
    const corners = [
      {
        x: bubbleX, y: bubbleY,
        b1: { x: bubbleX + tailOffset, y: bubbleY },
        b2: { x: bubbleX, y: bubbleY + tailOffset },
      },
      {
        x: bubbleX + bubbleW, y: bubbleY,
        b1: { x: bubbleX + bubbleW - tailOffset, y: bubbleY },
        b2: { x: bubbleX + bubbleW, y: bubbleY + tailOffset },
      },
      {
        x: bubbleX, y: bubbleY + bubbleH,
        b1: { x: bubbleX + tailOffset, y: bubbleY + bubbleH },
        b2: { x: bubbleX, y: bubbleY + bubbleH - tailOffset },
      },
      {
        x: bubbleX + bubbleW, y: bubbleY + bubbleH,
        b1: { x: bubbleX + bubbleW - tailOffset, y: bubbleY + bubbleH },
        b2: { x: bubbleX + bubbleW, y: bubbleY + bubbleH - tailOffset },
      },
    ];
    let bestCorner = corners[0]!;
    let bestDist = Infinity;
    for (const c of corners) {
      const d = Math.hypot(c.x - tipX, c.y - tipY);
      if (d < bestDist) {
        bestDist = d;
        bestCorner = c;
      }
    }

    // Draw tail FIRST, then bubble fills over its base portion, then
    // text on top. Result: tail and bubble look like one shape.
    const tailGfx = this.scene.add.graphics();
    tailGfx.fillStyle(SPEECH_BUBBLE_COLOR, 1);
    tailGfx.fillTriangle(
      bestCorner.b1.x, bestCorner.b1.y,
      bestCorner.b2.x, bestCorner.b2.y,
      tipX, tipY,
    );
    this.container.add(tailGfx);

    const bubbleGfx = this.scene.add.graphics();
    bubbleGfx.fillStyle(SPEECH_BUBBLE_COLOR, 1);
    bubbleGfx.fillRoundedRect(bubbleX, bubbleY, bubbleW, bubbleH, bubbleRadius);
    this.container.add(bubbleGfx);
    this.container.add(text);

    // -- Continue button ---------------------------------------------
    if (opts.onContinue) {
      const label = opts.continueLabel ?? 'Continue →';
      const btnY = height - 60;
      const btnW = 220;
      const btnH = 52;
      const btnBg = this.scene.add
        .rectangle(width / 2, btnY, btnW, btnH, CONTINUE_FILL, 1)
        .setInteractive({ useHandCursor: true });
      btnBg.setStrokeStyle(2, 0x1a0a2e, 1);
      const btnText = this.scene.add
        .text(width / 2, btnY, label, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '16px',
          color: CONTINUE_TEXT,
        })
        .setOrigin(0.5);
      this.container.add([btnBg, btnText]);
      btnBg.on('pointerdown', () => {
        // Quick scale pulse for tap feedback before firing the
        // callback — same pattern as Welcome.ts had.
        this.scene.tweens.add({
          targets: [btnBg, btnText],
          scale: 0.96,
          duration: 80,
          yoyo: true,
          onComplete: () => opts.onContinue?.(),
        });
      });
    }
  }

  /** Tear down the overlay container. Idempotent — calling on an
   *  already-hidden overlay is a no-op. */
  hide(): void {
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
