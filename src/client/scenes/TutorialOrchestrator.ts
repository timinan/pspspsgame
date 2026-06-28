import { Scene } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { AssetKeys } from '@/constants/assets';
import {
  nextTutorialStep,
  STARTER_CATS,
  STARTER_STAGES,
  type TutorialStepId,
} from '@/../shared/tutorial-types';
import { getTutorialDialogue, personalize } from '@/../shared/tutorial-script';
import {
  setTutorialStep,
  completeOnboarding,
  setBackground,
  seedStarterCat,
  openBox,
} from '@/services/state-client';
import { TutorialCatOverlay } from '@/ui/tutorial-cat';
import { Picker } from '@/ui/picker';
import { playBoxOpenAnimation } from '@/ui/box-open-animation';
import {
  BACKGROUND_CATALOG,
  CAT_CATALOG,
  COSMETIC_CATALOG,
  type BackgroundId,
  type BoxId,
  type CatBreed,
  type CosmeticId,
  type PlayerState,
} from '@/../shared/state';

interface InitData {
  playerState?: PlayerState | null;
  /** Route B context — the post id of the friend's show that deep-
   *  linked this player into the tutorial. When set, the outro routes
   *  to VisitPost(originalPostId) instead of Decorate. */
  originalPostId?: string;
  /** Resume on tab-reopen — the orchestrator starts at this step
   *  instead of 'intro'. Set by Preloader from playerState.tutorialStep. */
  resumeAt?: TutorialStepId;
  /** Optional friendly poster username for the route-b-outro
   *  personalization. Not required (the script falls back to
   *  "your friend" when missing). */
  posterUsername?: string;
}

/**
 * TutorialOrchestrator — first-time onboarding scene that replaces the
 * legacy Welcome.ts. Owns the dialogue UI + the linear state machine +
 * the step-persistence calls. Reads `playerState.tutorialStep` on entry
 * (via the `resumeAt` init prop) so a mid-tutorial tab close picks up
 * exactly where it left off.
 *
 * Phase 3 is a SKELETON — every step renders the dialogue line(s) plus
 * a Continue button. Subsequent phases add: tutorial-cat sprite overlay
 * (Phase 4), pickers (Phase 5), box opens (Phase 6), and the guided-
 * mode handoffs into Decorate / Game / ChartEditor (Phases 7-9).
 *
 * Branches:
 *   editor-tour → visit-pointer (Route A) OR route-b-outro (Route B)
 *   based on originalPostId at branch time.
 *
 * Terminal states (route-a-outro, route-b-outro) call completeTutorial,
 * which flips onboardingDone + clears tutorialStep + transitions to
 * the appropriate next scene.
 */
export class TutorialOrchestrator extends Scene {
  private playerState: PlayerState | null = null;
  private currentStep: TutorialStepId = 'intro';
  private originalPostId: string | undefined;
  private posterUsername: string | undefined;
  /** Index into multi-line dialogue (for `dressing-walkthrough` and
   *  `play-tutorial`). 0 = first line. Reset to 0 on step advance. */
  private dialogueIndex = 0;
  private overlay: TutorialCatOverlay | undefined;
  private picker: Picker<string> | undefined;
  /** True after pick-cat completes — flips on the skip link top-right. */
  private skipUnlocked = false;
  /** True while a box-open animation or other async beat is in flight —
   *  suppresses double-taps on the Continue button. */
  private busy = false;

  constructor() {
    super(SceneKeys.TutorialOrchestrator);
  }

  init(data: InitData): void {
    this.playerState = data?.playerState ?? null;
    this.currentStep = data?.resumeAt ?? 'intro';
    this.originalPostId = data?.originalPostId;
    this.posterUsername = data?.posterUsername;
    this.dialogueIndex = 0;
  }

  create(): void {
    this.renderStep();
    // Persist the entry step so a refresh during the very first beat
    // still resumes here. Subsequent advances persist in `advance()`.
    void this.persistStep(this.currentStep);
  }

  // -----------------------------------------------------------------------
  // Private — rendering
  // -----------------------------------------------------------------------

  private renderStep(): void {
    // Tear down the previous step's children.
    this.children.removeAll(true);
    this.overlay?.destroy();
    this.overlay = undefined;
    this.picker?.destroy();
    this.picker = undefined;

    const { width, height } = this.scale;

    // Deep purple backdrop. The TutorialCatOverlay sits on top.
    this.add.rectangle(0, 0, width, height, 0x261540, 1).setOrigin(0, 0);

    // Step indicator — kept small + dim in the corner during the
    // skeleton phases. Useful for QA + screenshots. Tomorrow's polish
    // pass can remove or replace.
    this.add
      .text(width - 12, 12, this.currentStep, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '8px',
        color: '#6f5a91',
      })
      .setOrigin(1, 0);

    const lines = getTutorialDialogue(this.currentStep);
    const rawLine = lines[Math.min(this.dialogueIndex, lines.length - 1)] ?? '';
    const line = personalize(rawLine, this.posterUsername);
    const hasMoreDialogue = this.dialogueIndex < lines.length - 1;

    // Steps that show a picker INSTEAD of a Continue button. Dialogue
    // still renders (the tutorial cat says what's happening), but the
    // primary interaction is tapping a card.
    if (this.currentStep === 'pick-stage') {
      this.overlay = new TutorialCatOverlay(this);
      this.overlay.show(line, {}); // no Continue — picker drives advance
      this.picker = new Picker(this, {
        items: STARTER_STAGES.map((id) => {
          const entry = BACKGROUND_CATALOG[id as BackgroundId];
          return {
            id,
            imageKey: `${entry.backdropKey}-thumb`,
            label: entry.displayName,
          };
        }),
        onPick: (stageId) => {
          void this.handleStagePick(stageId as BackgroundId);
        },
      });
      return;
    }

    if (this.currentStep === 'pick-cat') {
      this.overlay = new TutorialCatOverlay(this);
      this.overlay.show(line, {});
      this.picker = new Picker(this, {
        items: STARTER_CATS.map((breed) => {
          const entry = CAT_CATALOG.find((c) => c.id === breed);
          return {
            id: breed,
            imageKey: AssetKeys.Atlas.Cats,
            frame: `${breed}_idle_00`,
            label: entry?.name ?? breed,
          };
        }),
        onPick: (breed) => {
          void this.handleCatPick(breed as CatBreed);
        },
      });
      return;
    }

    // Box-open beats — the dialogue plays first, then on Continue we
    // fire openBox + playBoxOpenAnimation, then advance on the
    // animation's onDone callback.
    if (this.currentStep === 'box-cosmetic' || this.currentStep === 'box-effect') {
      const boxId: BoxId = this.currentStep === 'box-cosmetic' ? 'cosmeticBox' : 'effectsBox';
      this.overlay = new TutorialCatOverlay(this);
      this.overlay.show(line, {
        continueLabel: 'Open box →',
        onContinue: () => {
          if (this.busy) return;
          void this.runBoxOpen(boxId);
        },
      });
      this.renderSkipLinkIfUnlocked();
      return;
    }

    // Default: dialogue + Continue.
    const continueLabel = hasMoreDialogue ? 'Next →' : 'Continue →';
    this.overlay = new TutorialCatOverlay(this);
    this.overlay.show(line, {
      continueLabel,
      onContinue: () => {
        if (this.busy) return;
        if (hasMoreDialogue) {
          this.dialogueIndex += 1;
          this.renderStep();
        } else {
          void this.advance();
        }
      },
    });
    this.renderSkipLinkIfUnlocked();
  }

  /** Render a small "skip tutorial" link in top-right. Only visible
   *  after pick-cat completes (set by `advance()` when transitioning
   *  away from `pick-cat`). Lower visual weight than Continue — it's
   *  an emergency exit, not the normalized path. */
  private renderSkipLinkIfUnlocked(): void {
    if (!this.skipUnlocked) return;
    const { width } = this.scale;
    const skipText = this.add
      .text(width - 16, 36, 'skip tutorial', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '10px',
        color: '#c0a0e6',
      })
      .setOrigin(1, 0)
      .setInteractive({ useHandCursor: true });
    skipText.on('pointerover', () => skipText.setColor('#ffd34d'));
    skipText.on('pointerout', () => skipText.setColor('#c0a0e6'));
    skipText.on('pointerdown', () => {
      if (this.busy) return;
      void this.skipTutorial();
    });
  }

  // -----------------------------------------------------------------------
  // Private — async beat handlers
  // -----------------------------------------------------------------------

  private async runBoxOpen(boxId: BoxId): Promise<void> {
    this.busy = true;
    try {
      const result = await openBox(boxId);
      if (!result.ok) {
        console.warn('[tutorial] openBox failed:', result.reason);
        this.busy = false;
        await this.advance();
        return;
      }
      this.playerState = result.state;
      const pull = result.pull;
      const isCat = pull.kind === 'cat';
      const entry = isCat
        ? CAT_CATALOG.find((c) => c.id === pull.itemId)
        : COSMETIC_CATALOG.find((c) => c.id === (pull.itemId as CosmeticId));
      const itemName = entry?.name ?? pull.itemId;

      // Frame resolution mirrors the existing Welcome.ts pattern.
      let frame: string;
      let tint: number | undefined;
      let rainbow: boolean | undefined;
      if (isCat) {
        if (pull.itemId === 'rainbow') {
          frame = 'cat6_idle_00';
          rainbow = true;
        } else {
          frame = `${pull.itemId}_idle_00`;
        }
      } else {
        const cosEntry = COSMETIC_CATALOG.find((c) => c.id === pull.itemId);
        const renderId = cosEntry?.sourceFrame?.match(/^cosmetic_(c\d+)_/)?.[1] ?? pull.itemId;
        frame = `cosmetic_${renderId}_idle_00`;
        if (cosEntry?.tint) {
          tint = parseInt(cosEntry.tint.replace('#', ''), 16);
        }
      }

      playBoxOpenAnimation(
        this,
        {
          textureKey: isCat ? AssetKeys.Atlas.Cats : AssetKeys.Atlas.Cosmetics,
          frame,
          itemName: isCat ? '' : itemName,
          ...(isCat
            ? { inlineRarityTemplate: { prefix: 'A ', suffix: ' cat has been adopted' } }
            : {}),
          rarity: pull.rarity,
          ...(rainbow ? { rainbow: true } : {}),
          ...(tint !== undefined ? { tint } : {}),
          duplicate: pull.duplicate,
          refundCoins: pull.refundCoins,
        },
        () => {
          this.busy = false;
          void this.advance();
        },
      );
    } catch (e) {
      console.warn('[tutorial] runBoxOpen threw', e);
      this.busy = false;
      await this.advance();
    }
  }

  private async skipTutorial(): Promise<void> {
    this.busy = true;
    try {
      const updated = await completeOnboarding();
      this.playerState = updated;
    } catch (e) {
      console.warn('[tutorial] skip → completeOnboarding failed', e);
    }
    // Route per originalPostId (same rule as completeTutorial).
    if (this.originalPostId) {
      this.scene.start(SceneKeys.VisitPost, {
        postId: this.originalPostId,
        playerState: this.playerState,
      });
      return;
    }
    this.scene.start(SceneKeys.Decorate, { playerState: this.playerState });
  }

  private async handleStagePick(stageId: BackgroundId): Promise<void> {
    try {
      const updated = await setBackground(stageId);
      this.playerState = updated;
    } catch (e) {
      console.warn('[tutorial] setBackground failed (continuing anyway)', e);
    }
    await this.advance();
  }

  private async handleCatPick(breed: CatBreed): Promise<void> {
    try {
      const updated = await seedStarterCat(breed);
      this.playerState = updated;
    } catch (e) {
      console.warn('[tutorial] seedStarterCat failed (continuing anyway)', e);
    }
    await this.advance();
  }

  // -----------------------------------------------------------------------
  // Private — state-machine advance
  // -----------------------------------------------------------------------

  private async advance(): Promise<void> {
    // Flip the skip link on as soon as the player leaves pick-cat —
    // identity-setting beats are unavoidable but everything after is
    // optional.
    if (this.currentStep === 'pick-cat') {
      this.skipUnlocked = true;
    }

    // Branch override: editor-tour decides Route A vs Route B based on
    // originalPostId. Route A goes through the visit-pointer beat
    // before the outro; Route B skips it.
    let next: TutorialStepId | 'complete';
    if (this.currentStep === 'editor-tour') {
      next = this.originalPostId ? 'route-b-outro' : 'visit-pointer';
    } else {
      next = nextTutorialStep(this.currentStep);
    }

    if (next === 'complete') {
      await this.completeTutorial();
      return;
    }

    await this.persistStep(next);
    this.currentStep = next;
    this.dialogueIndex = 0;
    this.renderStep();
  }

  private async persistStep(step: TutorialStepId): Promise<void> {
    try {
      const updated = await setTutorialStep(step);
      this.playerState = updated;
    } catch (e) {
      // Best-effort: a failed persist means the player might resume
      // one step earlier on next open, never lose loot.
      console.warn('[tutorial] setTutorialStep failed (continuing)', e);
    }
  }

  private async completeTutorial(): Promise<void> {
    try {
      const updated = await completeOnboarding();
      this.playerState = updated;
    } catch (e) {
      console.warn('[tutorial] completeOnboarding failed (continuing)', e);
    }

    // Route B → friend's post. Route A → Decorate.
    if (this.originalPostId) {
      this.scene.start(SceneKeys.VisitPost, {
        postId: this.originalPostId,
        playerState: this.playerState,
      });
      return;
    }
    this.scene.start(SceneKeys.Decorate, { playerState: this.playerState });
  }
}
