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
    // Moved further down per Tim's screenshot feedback — sits lower so
    // the speech bubble tail points naturally at Butters' head.
    const catScale = 1.7;
    const catX = 60;
    const catY = 220;
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

    // -- Speech bubble ------------------------------------------------
    // Borderless white rounded rect with a tail pointing at Butters'
    // head (per the second round of feedback — Tim asked for the tail
    // back, attached to Butters specifically).
    const bubbleX = catX + 50;
    const bubbleY = 28;
    const bubbleW = Math.min(width - bubbleX - 12, 230);
    const bubbleH = 152;
    const bubbleRadius = 16;

    const bubbleGfx = this.scene.add.graphics();
    bubbleGfx.fillStyle(SPEECH_BUBBLE_COLOR, 1);
    bubbleGfx.fillRoundedRect(bubbleX, bubbleY, bubbleW, bubbleH, bubbleRadius);
    this.container.add(bubbleGfx);

    // Tail — filled triangle at bubble's bottom-left area, tip pointing
    // down-left at Butters' head. Same fill as the bubble so the two
    // read as one shape.
    const tailBaseY = bubbleY + bubbleH - 1;
    const tailBaseLeftX = bubbleX + 12;
    const tailBaseRightX = bubbleX + 44;
    const tailTipX = catX + 24; // tip lands near Butters' head
    const tailTipY = catY - 64; // head-level (60% up from feet)

    const tailGfx = this.scene.add.graphics();
    tailGfx.fillStyle(SPEECH_BUBBLE_COLOR, 1);
    tailGfx.fillTriangle(
      tailBaseLeftX, tailBaseY,
      tailBaseRightX, tailBaseY,
      tailTipX, tailTipY,
    );
    this.container.add(tailGfx);

    // -- Dialogue text -----------------------------------------------
    const text = this.scene.add
      .text(bubbleX + 16, bubbleY + 16, dialogue, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '11px',
        color: TEXT_COLOR,
        wordWrap: { width: bubbleW - 32 },
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
