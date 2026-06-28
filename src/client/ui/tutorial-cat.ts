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

const HOST_BREED_FRAME = 'cat6_idle_00';
const SPEECH_BUBBLE_COLOR = 0xfff8e7;
const SPEECH_BUBBLE_STROKE = 0xc678ff;
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
    // Anchored top-left of the screen so it shares the top zone with
    // the speech bubble and stays out of the way of pickers / box-open
    // animations / Continue button below. Origin bottom-center so we
    // position by the cat's feet.
    const catScale = 1.6;
    const catX = 56;
    const catY = 28 + 64 * catScale; // top margin 28 + sprite height
    const catSprite = this.scene.add
      .sprite(catX, catY, AssetKeys.Atlas.Cats, HOST_BREED_FRAME)
      .setOrigin(0.5, 1)
      .setScale(catScale);
    this.container.add(catSprite);

    // -- Speech bubble ------------------------------------------------
    // Rounded white bubble with a thick purple stroke + a chunky tail
    // pointing at the cat. Per Tim's reference screenshots — wants the
    // cute pixel-game speech-bubble vibe (rounded corners, hand-drawn
    // tail).
    const bubbleX = catX + 36;
    const bubbleY = 28;
    const bubbleW = Math.min(width - bubbleX - 16, 240);
    const bubbleH = 152;
    const bubbleRadius = 14;
    const strokeW = 3;

    const bubbleGfx = this.scene.add.graphics();
    bubbleGfx.fillStyle(SPEECH_BUBBLE_COLOR, 1);
    bubbleGfx.fillRoundedRect(bubbleX, bubbleY, bubbleW, bubbleH, bubbleRadius);
    bubbleGfx.lineStyle(strokeW, SPEECH_BUBBLE_STROKE, 1);
    bubbleGfx.strokeRoundedRect(bubbleX, bubbleY, bubbleW, bubbleH, bubbleRadius);
    this.container.add(bubbleGfx);

    // Tail — chunky filled triangle pointing down-left toward the cat's
    // head. Drawn as fillTriangle so it inherits the same fill color +
    // separately strokeTriangled with the same purple border. Notch
    // overlap on the bubble bottom is intentional (covers the seam).
    const tailTipX = catX + 20;
    const tailTipY = catY - 56; // up around cat's head
    const tailBaseX = bubbleX + 20;
    const tailBaseY = bubbleY + bubbleH - 2;
    const tailWide = 22;

    const tailGfx = this.scene.add.graphics();
    tailGfx.fillStyle(SPEECH_BUBBLE_COLOR, 1);
    tailGfx.fillTriangle(
      tailBaseX, tailBaseY,
      tailBaseX + tailWide, tailBaseY,
      tailTipX, tailTipY,
    );
    tailGfx.lineStyle(strokeW, SPEECH_BUBBLE_STROKE, 1);
    // Stroke only the two outer edges of the tail (skip the top — the
    // bubble bottom already strokes that). Two line segments.
    tailGfx.beginPath();
    tailGfx.moveTo(tailBaseX, tailBaseY);
    tailGfx.lineTo(tailTipX, tailTipY);
    tailGfx.strokePath();
    tailGfx.beginPath();
    tailGfx.moveTo(tailBaseX + tailWide, tailBaseY);
    tailGfx.lineTo(tailTipX, tailTipY);
    tailGfx.strokePath();
    this.container.add(tailGfx);

    // Small cover-rect to hide the bubble's bottom stroke between the
    // two tail base points (so the bubble + tail read as one continuous
    // shape rather than a tail OVERLAID on a closed rect).
    const seamCover = this.scene.add.rectangle(
      tailBaseX + tailWide / 2,
      tailBaseY,
      tailWide - 4,
      strokeW + 2,
      SPEECH_BUBBLE_COLOR,
      1,
    ).setOrigin(0.5, 0.5);
    this.container.add(seamCover);

    // -- Dialogue text -----------------------------------------------
    const text = this.scene.add
      .text(bubbleX + 14, bubbleY + 14, dialogue, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '11px',
        color: TEXT_COLOR,
        wordWrap: { width: bubbleW - 28 },
        lineSpacing: 2,
      })
      .setOrigin(0, 0);
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
