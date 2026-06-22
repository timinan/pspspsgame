import { Scene, GameObjects } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { AssetKeys } from '@/constants/assets';
import { playBoxOpenAnimation } from '@/ui/box-open-animation';
import { CatNamingModal } from '@/ui/cat-naming-modal';
import { openBox, completeOnboarding, renameCat } from '@/services/state-client';
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

    // Title size is picked from a few breakpoints so 'Welcome to pspsps!'
    // fits on one line at narrow widths. lineSpacing is non-zero so even
    // if it does wrap, the two lines don't render on top of each other —
    // that was the bug in the previous screenshot.
    const titleFontSize = width >= 720 ? 44 : width >= 520 ? 32 : 22;
    this.title = this.add
      .text(width / 2, height * 0.14, 'Welcome to pspsps!', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: `${titleFontSize}px`,
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 6,
        align: 'center',
        lineSpacing: 8,
        wordWrap: { width: width - 32 },
      })
      .setOrigin(0.5);

    const subtitleFontSize = width >= 520 ? 20 : 16;
    this.subtitle = this.add
      .text(
        width / 2,
        height * 0.32,
        "Your cat house is ready. Here's 600 coins to get you started — let's open your first boxes!",
        {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontSize: `${subtitleFontSize}px`,
          color: '#e0d3ff',
          align: 'center',
          lineSpacing: 8,
          wordWrap: { width: width - 48 },
        },
      )
      .setOrigin(0.5);

    this.coinsText = this.add
      .text(width - 16, 12, '🪙 0', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '22px',
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
        "Your cat house is ready. Here's 600 coins to get you started — let's open your first boxes!",
      );
      const cost = BOX_CATALOG.catBox.price;
      this.actionButton = this.createButton(
        `Open Cat Box · ${cost}🪙`,
        0x6fbcff,
        () => this.onOpenBox('catBox'),
      );
    } else if (step === 'cosmetic') {
      this.subtitle.setText('Nice! One more — pick a style for your crew.');
      const cost = BOX_CATALOG.cosmeticBox.price;
      this.actionButton = this.createButton(
        `Open Cosmetic Box · ${cost}🪙`,
        0xc678ff,
        () => this.onOpenBox('cosmeticBox'),
      );
    } else {
      this.title.setText("You're all set!");
      this.subtitle.setText(
        'Earn more coins by playing the rhythm game. Buy more boxes anytime.',
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
    // Button shrinks to the available width on narrow viewports, capped
    // at 360 so it doesn't get silly-wide on desktop.
    const btnW = Math.min(360, width - 32);
    const btnH = 72;
    // Internal horizontal padding so the label has visible breathing room
    // from the button edges. Label font scales down if the label would
    // otherwise exceed the inner width — Pixeloid Sans Bold runs ~14px per
    // char at fontSize 24, so divide and clamp.
    const innerPadding = 24;
    const innerW = btnW - innerPadding * 2;
    const maxFontByWidth = Math.floor((innerW / label.length) * 1.6);
    const labelFontSize = Math.max(14, Math.min(24, maxFontByWidth));

    const container = this.add.container(width / 2, height * 0.62);
    const bg = this.add.rectangle(0, 0, btnW, btnH, 0x1a0a2e, 0.95);
    bg.setStrokeStyle(3, accent);
    bg.setInteractive({ useHandCursor: true });

    const text = this.add
      .text(0, 0, label, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: `${labelFontSize}px`,
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

      const { frame, rainbow, tint } = resolveFrame(pull.itemId, isCat);

      playBoxOpenAnimation(
        this,
        {
          textureKey: isCat ? AssetKeys.Atlas.Cats : AssetKeys.Atlas.Cosmetics,
          frame,
          itemName: isCat ? '' : itemName,
          ...(isCat ? { inlineRarityTemplate: { prefix: 'A ', suffix: ' cat has been adopted' } } : {}),
          rarity: pull.rarity,
          ...(rainbow ? { rainbow: true } : {}),
          ...(tint ? { tint: parseInt(tint.replace('#', ''), 16) } : {}),
          duplicate: pull.duplicate,
          refundCoins: pull.refundCoins,
        },
        () => {
          if (isCat && pull.instanceId) {
            // Prompt the player to name the new cat before advancing.
            const defaultName = entry?.name ?? (pull.itemId as string);
            const instanceId = pull.instanceId;
            // Exclude the just-pulled instance from the duplicate check so
            // the default name doesn't false-positive against itself.
            const existingCats = (this.playerState?.ownedCats ?? []).filter(
              (c) => c.id !== instanceId,
            );
            const modal = new CatNamingModal(this, {
              defaultName,
              existingCats,
              onSubmit: (name) => {
                // Update local state optimistically.
                const catInState = this.playerState?.ownedCats.find((c) => c.id === instanceId);
                if (catInState) catInState.name = name;
                // Persist to server (fire-and-forget — onboarding continues regardless).
                renameCat(instanceId, name).catch((e) =>
                  console.warn('[Welcome] renameCat failed:', e),
                );
                this.busy = false;
                this.showStep('cosmetic');
              },
            });
            // Suppress unused-variable warning — modal manages its own lifecycle.
            void modal;
          } else {
            this.busy = false;
            this.showStep(boxId === 'catBox' ? 'cosmetic' : 'done');
          }
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
    // Phase 5 flow: after onboarding, land in Decorate so the player can see
    // their starter cat + cosmetic and set up their house before playing.
    this.scene.start(SceneKeys.Decorate, { playerState: this.playerState });
  }
}

function resolveFrame(
  itemId: CatBreed | CosmeticId,
  isCat: boolean,
): { frame: string; rainbow?: boolean; tint?: string } {
  if (!isCat) {
    // Generated tint variants render the parent's atlas frame with the
    // tint applied at draw time.
    const entry = COSMETIC_CATALOG.find((c) => c.id === itemId);
    const renderId =
      entry?.sourceFrame?.match(/^cosmetic_(c\d+)_/)?.[1] ?? itemId;
    return {
      frame: `cosmetic_${renderId}_idle_00`,
      ...(entry?.tint ? { tint: entry.tint } : {}),
    };
  }
  if (itemId === 'rainbow') return { frame: 'cat6_idle_00', rainbow: true };
  return { frame: `${itemId}_idle_00` };
}
