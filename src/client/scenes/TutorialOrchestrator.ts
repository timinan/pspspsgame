import { Scene, GameObjects } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import {
  nextTutorialStep,
  type TutorialStepId,
} from '@/../shared/tutorial-types';
import { getTutorialDialogue, personalize } from '@/../shared/tutorial-script';
import {
  setTutorialStep,
  completeOnboarding,
} from '@/services/state-client';
import type { PlayerState } from '@/../shared/state';

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

    const { width, height } = this.scale;

    // Deep purple backdrop. Tutorial cat overlay arrives in Phase 4.
    this.add.rectangle(0, 0, width, height, 0x261540, 1).setOrigin(0, 0);

    // Step indicator (debug-ish — replaced with the cat sprite in Phase 4).
    this.add
      .text(width / 2, 24, `[ tutorial step: ${this.currentStep} ]`, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '10px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5, 0);

    // Render the current dialogue line.
    const lines = getTutorialDialogue(this.currentStep);
    const rawLine = lines[Math.min(this.dialogueIndex, lines.length - 1)] ?? '';
    const line = personalize(rawLine, this.posterUsername);
    this.add
      .text(width / 2, height * 0.4, line, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '14px',
        color: '#ffffff',
        align: 'center',
        wordWrap: { width: width - 48 },
      })
      .setOrigin(0.5);

    this.renderContinueButton();
  }

  private renderContinueButton(): void {
    const { width, height } = this.scale;
    const btnY = height * 0.78;

    const lines = getTutorialDialogue(this.currentStep);
    const hasMoreDialogue = this.dialogueIndex < lines.length - 1;
    const label = hasMoreDialogue ? 'Next →' : 'Continue →';

    const bg = this.add
      .rectangle(width / 2, btnY, 220, 56, 0xffd34d, 1)
      .setInteractive({ useHandCursor: true });
    bg.setStrokeStyle(2, 0x1a0a2e, 1);
    this.add
      .text(width / 2, btnY, label, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '18px',
        color: '#1a0a2e',
      })
      .setOrigin(0.5);

    bg.on('pointerdown', () => {
      if (hasMoreDialogue) {
        this.dialogueIndex += 1;
        this.renderStep();
      } else {
        void this.advance();
      }
    });
  }

  // -----------------------------------------------------------------------
  // Private — state-machine advance
  // -----------------------------------------------------------------------

  private async advance(): Promise<void> {
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
