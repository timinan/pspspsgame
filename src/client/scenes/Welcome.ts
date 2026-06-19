import { Scene, GameObjects } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { AssetKeys } from '@/constants/assets';
import { playBoxOpenAnimation } from '@/ui/box-open-animation';
import { openBox, completeOnboarding } from '@/services/state-client';
import {
  CAT_CATALOG,
  COSMETIC_CATALOG,
  BOX_CATALOG,
  type BoxId,
  type CatBreed,
  type CosmeticId,
  type PlayerState,
} from '@/../shared/state';

type Step = 'cat' | 'cosmetic' | 'done';

/**
 * One-shot onboarding scene. New users land here with 300 starter coins,
 * open their first Cat Crate and Style Pack in-flow, and only then enter
 * the rhythm game proper. After this scene completes, `onboardingDone` is
 * flipped on the server so returning users skip straight to Game.
 */
export class Welcome extends Scene {
  private playerState: PlayerState | null = null;
  private step: Step = 'cat';
  private busy = false;

  private title!: GameObjects.Text;
  private subtitle!: GameObjects.Text;
  private coinsText!: GameObjects.Text;
  private actionButton: GameObjects.Container | null = null;

  constructor() {
    super(SceneKeys.Welcome);
  }

  init(data: { playerState?: PlayerState | null }): void {
    this.playerState = data?.playerState ?? null;
    this.step = 'cat';
    this.busy = false;
    this.actionButton = null;
  }

  create(): void {
    const { width, height } = this.scale;

    // Deep purple backdrop with a sprinkle of soft "stars" so the empty
    // space behind the title doesn't read as flat. Drawn once at create —
    // no resize handling because welcome is one-shot and short-lived.
    this.add.rectangle(0, 0, width, height, 0x261540, 1).setOrigin(0, 0);
    const stars = this.add.graphics();
    stars.fillStyle(0xffffff, 0.35);
    for (let i = 0; i < 60; i++) {
      stars.fillCircle(
        Math.random() * width,
        Math.random() * height,
        Math.random() * 1.4 + 0.4,
      );
    }

    this.title = this.add
      .text(width / 2, height * 0.16, 'Welcome to pspsps!', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '44px',
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 6,
        align: 'center',
      })
      .setOrigin(0.5);

    this.subtitle = this.add
      .text(
        width / 2,
        height * 0.3,
        "Your cat house is ready.\nHere's 300 coins to get you started —\nlet's open your first boxes!",
        {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontSize: '20px',
          color: '#e0d3ff',
          align: 'center',
          lineSpacing: 8,
        },
      )
      .setOrigin(0.5);

    this.coinsText = this.add
      .text(width - 16, 16, '🪙 0', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '24px',
        color: '#ffd34d',
        stroke: '#000000',
        strokeThickness: 4,
      })
      .setOrigin(1, 0);

    this.refreshCoins();
    this.showStep('cat');
  }

  private refreshCoins(): void {
    const coins = this.playerState?.coins ?? 0;
    this.coinsText.setText(`🪙 ${coins}`);
  }

  private showStep(step: Step): void {
    this.step = step;
    this.clearActionButton();

    if (step === 'cat') {
      this.subtitle.setText(
        "Your cat house is ready.\nHere's 300 coins to get you started —\nlet's open your first boxes!",
      );
      const cost = BOX_CATALOG.catCrate.cost;
      this.actionButton = this.createButton(
        `Open Cat Crate · ${cost}🪙`,
        0x6fbcff,
        () => this.onOpenBox('catCrate'),
      );
    } else if (step === 'cosmetic') {
      this.subtitle.setText(
        'Nice! One more —\npick a style for your crew.',
      );
      const cost = BOX_CATALOG.stylePack.cost;
      this.actionButton = this.createButton(
        `Open Style Pack · ${cost}🪙`,
        0xc678ff,
        () => this.onOpenBox('stylePack'),
      );
    } else {
      this.title.setText("You're all set!");
      this.subtitle.setText(
        'Earn more coins by playing\nthe rhythm game.\nBuy more boxes anytime.',
      );
      this.actionButton = this.createButton(
        'Start playing',
        0xffd34d,
        () => void this.onFinish(),
      );
    }
  }

  private createButton(
    label: string,
    accent: number,
    onClick: () => void,
  ): GameObjects.Container {
    const { width, height } = this.scale;
    const btnW = 360;
    const btnH = 72;

    const container = this.add.container(width / 2, height * 0.62);
    const bg = this.add.rectangle(0, 0, btnW, btnH, 0x1a0a2e, 0.95);
    bg.setStrokeStyle(3, accent);
    bg.setInteractive({ useHandCursor: true });

    const text = this.add
      .text(0, 0, label, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '24px',
        color: '#ffffff',
      })
      .setOrigin(0.5);

    container.add([bg, text]);

    bg.on('pointerdown', () => {
      if (this.busy) return;
      this.tweens.add({
        targets: container,
        scale: 0.96,
        duration: 80,
        yoyo: true,
      });
      onClick();
    });

    this.tweens.add({
      targets: container,
      scale: { from: 1, to: 1.04 },
      duration: 700,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    return container;
  }

  private clearActionButton(): void {
    if (this.actionButton) {
      this.tweens.killTweensOf(this.actionButton);
      this.actionButton.destroy(true);
      this.actionButton = null;
    }
  }

  private async onOpenBox(boxId: BoxId): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.clearActionButton();

    try {
      const result = await openBox(boxId);
      if (!result.ok) {
        console.warn('[welcome] box open failed:', result.reason);
        this.busy = false;
        this.showStep(this.step);
        return;
      }
      this.playerState = result.state;
      this.refreshCoins();

      const pull = result.pull;
      const isCat = pull.kind === 'cat';
      const entry = isCat
        ? CAT_CATALOG.find((c) => c.id === (pull.itemId as CatBreed))
        : COSMETIC_CATALOG.find((c) => c.id === (pull.itemId as CosmeticId));
      const itemName = entry?.name ?? pull.itemId;

      const { frame, rainbow } = resolveFrame(pull.itemId, isCat);

      playBoxOpenAnimation(
        this,
        {
          textureKey: AssetKeys.Atlas.Cats,
          frame,
          itemName,
          rarity: pull.rarity,
          ...(rainbow ? { rainbow: true } : {}),
          duplicate: pull.duplicate,
          refundCoins: pull.refundCoins,
        },
        () => {
          this.busy = false;
          this.showStep(boxId === 'catCrate' ? 'cosmetic' : 'done');
        },
      );
    } catch (e) {
      console.warn('[welcome] box open error', e);
      this.busy = false;
      this.showStep(this.step);
    }
  }

  private async onFinish(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.clearActionButton();
    try {
      this.playerState = await completeOnboarding();
    } catch (e) {
      console.warn('[welcome] completeOnboarding failed', e);
    }
    this.scene.start(SceneKeys.Game, { playerState: this.playerState });
  }
}

function resolveFrame(
  itemId: CatBreed | CosmeticId,
  isCat: boolean,
): { frame: string; rainbow?: boolean } {
  if (!isCat) return { frame: `cosmetic_${itemId}_idle_00` };
  if (itemId === 'rainbow') return { frame: 'cat6_idle_00', rainbow: true };
  return { frame: `${itemId}_idle_00` };
}
