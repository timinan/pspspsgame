import * as Phaser from 'phaser';
import { Scene } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { AssetKeys } from '@/constants/assets';
import * as L from '@/constants/scene-layout';
import { LANE_COLORS, liftTowardWhite, LANE_BRIGHTNESS_LIFT } from '@/entities/note-colors';
import { CAT_COLOR_BY_BREED, resolveLaneTintsFromSeatedCats } from '@/constants/cat-colors';
import {
  nextTutorialStep,
  STARTER_CATS,
  STARTER_STAGES,
  TUTORIAL_STEP_ORDER,
  type TutorialStepId,
} from '@/../shared/tutorial-types';
import { getTutorialDialogue, personalize } from '@/../shared/tutorial-script';
import { TUTORIAL_PHASE_CONFIGS } from '@/../shared/tutorial-chart';

/** Slower than Balance.noteFallMs (2400) so the player has time to
 *  learn each gesture during the tutorial round. */
const TUTORIAL_NOTE_FALL_MS = 4800;
import {
  setTutorialStep,
  completeOnboarding,
  setBackground,
  seedStarterCat,
  openBox,
} from '@/services/state-client';
import { TutorialCatOverlay } from '@/ui/tutorial-cat';
import { playTutorialMusic } from '@/systems/home-music';
import { Picker } from '@/ui/picker';
import { playBoxOpenAnimation } from '@/ui/box-open-animation';
import { CatNamingModal } from '@/ui/cat-naming-modal';
import { loadBgIfMissing } from '@/entities/background-manager';
import { renameCat, equipCosmetic } from '@/services/state-client';
import { CAT_EFFECT_BY_ID } from '@/effects/cat-effects';
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
  /** When the orchestrator is resumed from Game scene mid-play-tutorial,
   *  this is the phase index to render (0-7). Game.returnToTutorial
   *  passes it; orchestrator reads it into dialogueIndex on init. */
  playTutorialPhase?: number;
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
  /** The step we were on right before currentStep — set by advance().
   *  renderStep reads it to know when a layout change needs a transition
   *  tween (e.g., intro → pick-stage animates Butters into the corner). */
  private previousStep: TutorialStepId | undefined;
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
  /** Step-specific UI gets thrown into here; renderStep() destroys this
   *  container at the start of every step so we don't leak. Live-preview
   *  elements (stage bg, seated cat, equipped cosmetics) live OUTSIDE
   *  this container so they persist across step transitions. */
  private stepUI: Phaser.GameObjects.Container | undefined;
  /** Hamburger drawer mock objects (drawer bg, header, cells, footer,
   *  icon). Kept SCENE-LEVEL (not in stepUI container) so their
   *  individual setDepth calls win — children of a Phaser Container
   *  render at the container's depth and ignore their own. Cleaned up
   *  at the start of each renderStep. */
  private hamburgerObjects: Phaser.GameObjects.GameObject[] = [];
  /** Persistent backdrop fallback — shows under everything when no
   *  stage has been picked yet. */
  private backdropFallback: Phaser.GameObjects.Rectangle | undefined;
  /** Live stage preview — appears after pick-stage, persists. */
  private stageBg: Phaser.GameObjects.Image | undefined;
  private stageBgId: BackgroundId | undefined;
  /** Live seated cat — appears after pick-cat, persists. */
  private seatedCat: Phaser.GameObjects.Sprite | undefined;
  private seatedCatBreed: CatBreed | undefined;
  /** Cosmetic sprites stacked on the live cat (one per equipped slot
   *  — head/face/neck etc). Persistent across step transitions. */
  private equippedCosmeticSprites: Phaser.GameObjects.Sprite[] = [];
  /** Active effect handle (e.g. particle emitter for sparkles).
   *  Destroyed before applying a new effect. */
  private activeEffectHandle: { destroy(): void } | undefined;
  /** Nametag under the seated cat — shown alongside the live preview
   *  from pick-cat onward. Updates after the rename modal. */
  private seatedCatNameLabel: Phaser.GameObjects.Text | undefined;
  /** For picker steps (pick-stage, pick-cat): tracks the currently
   *  previewed selection. Confirm button only enables once this is
   *  set; advancing clears it. */
  private pendingPickerSelection: string | undefined;
  /** Persistent stage rig drawn by switchToRehearsalStage — 3 lanes +
   *  small Butters at the left seat. Stays alive through play-tutorial
   *  beats so each next dialogue line just swaps the bubble, not the
   *  underlying stage. */
  private stageLaneGfx: Phaser.GameObjects.GameObject[] = [];
  private stageButters: Phaser.GameObjects.Sprite | undefined;
  private stageButtersGlasses: Phaser.GameObjects.Sprite | undefined;
  /** Latches once the rehearsal stage has been built so the tween +
   *  rig set-up only happens once even if a step re-renders. */
  private stageRigBuilt = false;
  /** Timer that auto-advances the rehearsal-intro beat after 5s so the
   *  player can read the line without having to tap Continue. Cleared
   *  on step change or on early Continue tap. */
  private autoAdvanceTimer: Phaser.Time.TimerEvent | undefined;
  /** BUTTERS nametag below the small stage Butters — same scaled style
   *  as the player cat's nametag. Added per Tim Image 31. */
  private stageButtersNameLabel: Phaser.GameObjects.Text | undefined;
  /** Editor-tour mock objects — the 3-column grid drawn behind Butters
   *  during the editor-tour beats so the dialogue's references to taps,
   *  holds, and slides actually have something to point at. Torn down
   *  on step change. */
  private editorMockObjects: Phaser.GameObjects.GameObject[] = [];

  constructor() {
    super(SceneKeys.TutorialOrchestrator);
  }

  init(data: InitData): void {
    this.playerState = data?.playerState ?? null;
    this.currentStep = data?.resumeAt ?? 'intro';
    this.originalPostId = data?.originalPostId;
    this.posterUsername = data?.posterUsername;
    // playTutorialPhase override — Game scene passes this after each
    // tutorial-mode round so we resume at the next phase, NOT 0.
    this.dialogueIndex = typeof data?.playTutorialPhase === 'number' ? data.playTutorialPhase : 0;
  }

  create(): void {
    // Lantern Tutorial loops under every tutorial beat (the insane
    // phase swaps to Steel Phase Loop via Game scene).
    playTutorialMusic(this);
    const { width, height } = this.scale;

    // Persistent backdrop — sits below everything and stays for the
    // whole scene lifecycle. Stage bg (when picked) layers on top of
    // this; otherwise this is the only thing visible behind the
    // overlay.
    this.backdropFallback = this.add
      .rectangle(0, 0, width, height, 0x261540, 1)
      .setOrigin(0, 0)
      .setDepth(-200);

    // BG selection — at the cold-start intro use the first venue card.
    // Once the player has picked a stage, use their actual activeBackground
    // so the post-pick beats (stage-set-confirm onward) sit on their
    // chosen venue, not the intro card.
    const currentIdx = TUTORIAL_STEP_ORDER.indexOf(this.currentStep);
    const pickStageIdx = TUTORIAL_STEP_ORDER.indexOf('pick-stage');
    const useActiveBg = currentIdx > pickStageIdx && !!this.playerState?.activeBackground;
    const initialBg = useActiveBg
      ? (this.playerState!.activeBackground as BackgroundId)
      : STARTER_STAGES[0];
    if (initialBg) {
      this.applyLiveStageBg(initialBg);
    }

    // Re-seat Mochi + draw the lanes if the player is past stage-set-
    // confirm — orchestrator boots fresh after every Game-scene return,
    // so the seatedCat sprite is gone even though the player conceptually
    // still has her on the stage. Without this, the play-tutorial[6]
    // outro and route-a-outro both show an empty stage.
    this.ensureStageRigForCurrentStep();

    this.renderStep();
    // Persist the entry step so a refresh during the very first beat
    // still resumes here. Subsequent advances persist in `advance()`.
    void this.persistStep(this.currentStep);
  }

  // -----------------------------------------------------------------------
  // Private — rendering
  // -----------------------------------------------------------------------

  private renderStep(): void {
    // Tear down ONLY step-specific UI. The live preview (stage bg +
    // seated cat + cosmetics) persists across steps.
    this.autoAdvanceTimer?.destroy();
    this.autoAdvanceTimer = undefined;
    this.tearDownEditorMock();
    this.setStageRigVisible(true); // editor-tour will hide it again below
    this.stepUI?.destroy(true);
    this.stepUI = this.add.container(0, 0);
    for (const obj of this.hamburgerObjects) obj.destroy();
    this.hamburgerObjects = [];
    this.overlay?.destroy();
    this.overlay = undefined;
    this.picker?.destroy();
    this.picker = undefined;

    const { width, height } = this.scale;

    // Step indicator — kept small + dim in the corner during the
    // skeleton phases. Useful for QA + screenshots. Tomorrow's polish
    // pass can remove or replace.
    const stepLabel = this.add
      .text(width - 12, 12, this.currentStep, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '8px',
        color: '#6f5a91',
      })
      .setOrigin(1, 0);
    this.stepUI.add(stepLabel);

    const lines = getTutorialDialogue(this.currentStep);
    const rawLine = lines[Math.min(this.dialogueIndex, lines.length - 1)] ?? '';
    // Resolve the seated cat's name for <catname> substitution in
    // merch-intro etc. Falls back to the breed default if rename
    // hasn't fired yet.
    const seatedCatName = (this.seatedCatBreed
      ? this.playerState?.ownedCats.find((c) => c.breed === this.seatedCatBreed)?.name
      : undefined) ?? this.seatedCatBreed;
    const line = personalize(rawLine, this.posterUsername, seatedCatName);
    const hasMoreDialogue = this.dialogueIndex < lines.length - 1;

    // Picker steps: tapping a card previews the choice live; an
    // explicit Confirm button at the bottom locks the selection in
    // and advances. Re-tapping a different card swaps the preview.
    // Per Tim's screenshot feedback round 2 — "give a preview of the
    // selection and add a button at the bottom to confirm same with cats".
    if (this.currentStep === 'pick-stage') {
      this.overlay = new TutorialCatOverlay(this);
      // Push the bubble down so more of the picked venue bg is visible
      // up top per Tim's feedback. tweenFromHero animates Butters from
      // the intro's centered-large pose into the corner so the move
      // reads as motion, not a snap (Image 30 feedback).
      const fromIntro = this.previousStep === 'intro';
      this.overlay.show(line, { bubbleY: 170, tweenFromHero: fromIntro });
      this.picker = new Picker(this, {
        items: STARTER_STAGES.map((id) => {
          const entry = BACKGROUND_CATALOG[id as BackgroundId];
          return {
            id,
            imageKey: `${entry.backdropKey}-thumb`,
            label: entry.displayName,
          };
        }),
        centerY: 420,
        allowReselect: true,
        defaultSelectedId: STARTER_STAGES[0],
        onPick: (stageId) => {
          this.applyLiveStageBg(stageId as BackgroundId);
          // Server write fires on every preview so a refresh mid-pick
          // doesn't lose the last seen choice. Best-effort.
          void setBackground(stageId as BackgroundId)
            .then((updated) => { this.playerState = updated; })
            .catch((e) => console.warn('[tutorial] setBackground failed (preview only)', e));
          this.pendingPickerSelection = stageId;
          this.renderConfirmButton();
        },
      });
      // Per Tim: default to the first venue highlighted + shown as bg
      // on entry. Subsequent taps swap; Confirm advances.
      const defaultStage = STARTER_STAGES[0];
      if (defaultStage) {
        this.applyLiveStageBg(defaultStage);
        void setBackground(defaultStage)
          .then((updated) => { this.playerState = updated; })
          .catch(() => {});
        this.pendingPickerSelection = defaultStage;
        this.renderConfirmButton();
      }
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
        centerY: 420,
        allowReselect: true,
        onPick: (breed) => {
          // Local preview only on tap — seedStarterCat is deferred to
          // Confirm so re-tapping cards doesn't create duplicate
          // ownedCats entries on the server.
          this.applyLiveCat(breed as CatBreed);
          this.pendingPickerSelection = breed;
          this.renderConfirmButton();
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
        // Per Tim: 'no more open box buttons only continue for both the
        // screens'. The tap still fires the box-open animation; the
        // label just stays consistent with every other beat.
        continueLabel: 'Continue →',
        onContinue: () => {
          if (this.busy) return;
          void this.runBoxOpen(boxId);
        },
      });
      this.renderSkipLinkIfUnlocked();
      return;
    }

    // Merch-reveal: cat now wearing both cosmetic + effect from the two
    // box-open animations. New step per Tim's followup: 'have the cat
    // equipped both with effect and cosmetic we'll add a text that say
    // wow looking great! and then continue for next step'.
    if (this.currentStep === 'merch-reveal') {
      this.overlay = new TutorialCatOverlay(this);
      this.overlay.show(line, {
        continueLabel: 'Continue →',
        onContinue: () => {
          if (this.busy) return;
          void this.advance();
        },
      });
      this.renderSkipLinkIfUnlocked();
      return;
    }

    // Rehearsal-intro: a mocked hamburger drawer with REHEARSE
    // highlighted. Butters narrates from above. On Continue the
    // orchestrator transitions to a Decorate-like "ready to rehearse"
    // stage (full bg + cat in center seat, other 2 lanes empty). The
    // next step (play-tutorial-intro) renders on top of that view.
    if (this.currentStep === 'rehearsal-intro') {
      // Stage rig is already built at stage-set-confirm — no need to
      // re-tween here. Latched guard inside the stage-set-confirm branch
      // covers the re-entry case.
      this.renderHamburgerMock('REHEARSE');
      this.overlay = new TutorialCatOverlay(this);
      this.overlay.show(line, {
        continueLabel: 'Continue →',
        onContinue: () => {
          if (this.busy) return;
          void this.advance();
        },
      });
      this.renderSkipLinkIfUnlocked();
      return;
    }

    // play-tutorial-intro: hand off to Game scene with the intro mini-
    // chart (phase -1). Game runs the round, advances to play-tutorial
    // phase 0 on exit.
    if (this.currentStep === 'play-tutorial-intro') {
      this.scene.start(SceneKeys.Game, {
        playerState: this.playerState,
        tutorialPhase: -1,
        noteFallMs: TUTORIAL_NOTE_FALL_MS,
      });
      return;
    }

    // play-tutorial: 8-phase state machine. Phases 0, 2-6 hand off to
    // Game scene with the matching mini-chart. Phase 1 (lane styling
    // explainer) and phase 7 (outro menu mock) stay in the orchestrator
    // since they don't involve note gameplay.
    if (this.currentStep === 'play-tutorial') {
      this.runPlayTutorialPhase(this.dialogueIndex);
      return;
    }

    // stage-set-confirm: same hamburger menu pattern as rehearsal-intro
    // but PUT ON A SHOW highlighted — that's the gateway Butters is
    // saying you can come back to any time.
    if (this.currentStep === 'stage-set-confirm') {
      // Tween the player cat from the merch floor up to her stage seat
      // (and seat small Butters at the left lane) so the "your stage is
      // set!" line actually matches what the player sees. Tim image 4
      // feedback: "when we transition to this page have their cat also
      // move to their position on the stage". Latched so the tween only
      // runs once even on re-render.
      if (!this.stageRigBuilt) {
        this.switchToRehearsalStage();
        this.stageRigBuilt = true;
      }
      this.renderHamburgerMock('SET STAGE');
      this.overlay = new TutorialCatOverlay(this);
      this.overlay.show(line, {
        continueLabel: 'Continue →',
        onContinue: () => {
          if (this.busy) return;
          void this.advance();
        },
      });
      this.renderSkipLinkIfUnlocked();
      return;
    }

    // Visit-pointer: 4-beat menu walkthrough per Tim image-4 spec — one
    // beat per menu tab (CATCH A SHOW → MERCH → REWARDS → SETTINGS) with
    // the matching row highlighted in the hamburger mock so the player
    // sees where each feature lives.
    if (this.currentStep === 'visit-pointer') {
      const highlights = ['CATCH A SHOW', 'MERCH', 'REWARDS', 'SETTINGS'] as const;
      const highlight = highlights[Math.min(this.dialogueIndex, highlights.length - 1)]!;
      this.renderHamburgerMock(highlight);
      const continueLabelV = hasMoreDialogue ? 'Next →' : 'Continue →';
      this.overlay = new TutorialCatOverlay(this);
      this.overlay.show(line, {
        continueLabel: continueLabelV,
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
      return;
    }

    // Editor-tour beats: render a chart-editor mock behind Butters, pin
    // the bubble at the top, and progressively reveal demo notes as the
    // dialogue cycles through tap → hold → slide. Per Tim image 4 the
    // narrator stays on screen during this stretch (he disappeared in
    // round 2). Stage rig stays in tree but the mock covers it.
    if (this.currentStep === 'editor-tour-intro' || this.currentStep === 'editor-tour') {
      const continueLabelE = hasMoreDialogue ? 'Next →' : 'Continue →';
      // Demo notes are cumulative across the editor-tour cycle:
      //   intro                       — 0 notes
      //   editor-tour[0] tap          — 1 note
      //   editor-tour[1] hold         — 2 notes
      //   editor-tour[2] slide        — 3 notes
      //   editor-tour[3] double-slide — 4 notes
      //   editor-tour[4] rehearse     — 4 notes, REHEARSE pulse
      //   editor-tour[5] must-pass    — 4 notes
      let demoCount: number;
      if (this.currentStep === 'editor-tour-intro') {
        demoCount = 0;
      } else {
        demoCount = Math.min(4, 1 + this.dialogueIndex);
      }
      // REHEARSE pulse moves to beat 4 — the "when ready, press rehearse
      // to practice" line. Beat 3 is now just the double-slide demo.
      const highlightRehearse = this.currentStep === 'editor-tour' && this.dialogueIndex === 4;
      this.renderEditorMock(demoCount, highlightRehearse);
      // Lift Continue so its bottom edge sits just above the editor
      // mock's page-nav row. gridBottom = height - BOTTOM_STRIP_H 78 -
      // PAGE_NAV_H 36 = 466. The overlay's Continue button is 52px
      // tall, so center it at gridBottom - 26 = 440. Keeps the REHEARSE
      // row at the canvas bottom fully visible.
      const editorGridBottom = height - 78 - 36;
      const editorContinueY = editorGridBottom - 26;
      this.overlay = new TutorialCatOverlay(this);
      this.overlay.show(line, {
        continueLabel: continueLabelE,
        bubbleY: 28,
        continueY: editorContinueY,
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
      return;
    }

    // Route-A outro: visual close mirrors stage-set-confirm — menu mock
    // open with SET STAGE highlighted so the player sees one last time
    // where they're about to land. Per Tim image 13: 'cat should remain
    // and go back to showing set a stage'. Mochi is re-seated by
    // ensureStageRigForCurrentStep() on boot.
    if (this.currentStep === 'route-a-outro') {
      this.renderHamburgerMock('SET STAGE');
      this.overlay = new TutorialCatOverlay(this);
      this.overlay.show(line, {
        continueLabel: 'Continue →',
        onContinue: () => {
          if (this.busy) return;
          void this.advance();
        },
      });
      this.renderSkipLinkIfUnlocked();
      return;
    }

    // Default: dialogue + Continue. The intro step uses the 'hero'
    // layout — Butters big + centered to fill the screen on first
    // introduction; every subsequent step uses the normal top-left
    // position. Steps past rehearsal-intro (when stageButters is on
    // the stage) use stage-mode so the bubble points at the seated
    // small Butters instead of rendering a duplicate avatar.
    const continueLabel = hasMoreDialogue ? 'Next →' : 'Continue →';
    const useStageMode = this.stageButters !== undefined;
    const stageTailAt = useStageMode
      ? this.getStageButtersFacePos()
      : undefined;
    this.overlay = new TutorialCatOverlay(this);
    this.overlay.show(line, {
      continueLabel,
      hero: this.currentStep === 'intro',
      ...(stageTailAt ? { stageTailAt, stageBubbleCenterX: width / 2 } : {}),
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

  /** Where the stage-mode bubble's tail should point — Butters' face
   *  at the left seat. Returns undefined if the stage rig isn't up. */
  private getStageButtersFacePos(): { x: number; y: number } | undefined {
    if (!this.stageButters) return undefined;
    // Cat sprites are bottom-anchored (origin 0.5, 1) and roughly 64px
    // tall at scale 1; face sits ~mid-sprite — offset up by half the
    // visible height for a clean tail target.
    const halfH = (this.stageButters.height * this.stageButters.scaleY) / 2;
    return { x: this.stageButters.x, y: this.stageButters.y - halfH };
  }

  /** Bottom-of-screen Confirm button used by picker steps (pick-stage,
   *  pick-cat). Initially absent — renders once `pendingPickerSelection`
   *  is set, advances on tap. */
  private confirmButton: Phaser.GameObjects.Container | undefined;
  private renderConfirmButton(): void {
    this.confirmButton?.destroy(true);
    if (!this.pendingPickerSelection) return;
    const { width, height } = this.scale;
    const btnY = height - 40;
    const btnW = 220;
    const btnH = 52;
    const container = this.add.container(0, 0);
    const bg = this.add
      .rectangle(width / 2, btnY, btnW, btnH, 0xffd34d, 1)
      .setStrokeStyle(2, 0x1a0a2e, 1)
      .setInteractive({ useHandCursor: true });
    const text = this.add
      .text(width / 2, btnY, 'Continue →', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '16px',
        color: '#1a0a2e',
      })
      .setOrigin(0.5);
    container.add([bg, text]);
    bg.on('pointerdown', () => {
      if (this.busy) return;
      this.busy = true;
      this.tweens.add({
        targets: [bg, text],
        scale: 0.96,
        duration: 80,
        yoyo: true,
        onComplete: () => {
          this.busy = false;
          this.pendingPickerSelection = undefined;
          // Tear the picker down NOW so it doesn't sit under the
          // name-choice modal / next step's UI.
          this.picker?.destroy();
          this.picker = undefined;
          if (this.currentStep === 'pick-cat') {
            // Cat-pick: seed the chosen breed server-side, then gate
            // on the name-choice modal before advancing to merch-intro.
            // Per Tim feedback (Image 23): keep the Continue button
            // visible — just dim and disable it — so the player still
            // sees the action target underneath the modal.
            this.disableConfirmButton();
            const breed = this.seatedCatBreed;
            if (!breed) {
              void this.advance();
              return;
            }
            void seedStarterCat(breed)
              .then((updated) => {
                this.playerState = updated;
                // Re-render the name label off the now-canonical
                // ownedCats entry so the label below the seated cat
                // shows the real name, not the breed default.
                this.renderSeatedCatNameLabel();
                this.showNameChoice(breed);
              })
              .catch((e) => {
                console.warn('[tutorial] seedStarterCat failed; advancing', e);
                void this.advance();
              });
          } else {
            this.confirmButton?.destroy(true);
            this.confirmButton = undefined;
            void this.advance();
          }
        },
      });
    });
    this.confirmButton = container;
    this.stepUI?.add(container);
  }

  /** Dim + de-interact the Confirm button without destroying it. Used
   *  during the name-choice modal so the bottom-of-screen button stays
   *  in place (no layout shift) while the modal is the active target.
   *  Tim's feedback (Image 23): "don't get rid of continue button at the
   *  bottom just have it unclickable and darkened." */
  private disableConfirmButton(): void {
    if (!this.confirmButton) return;
    for (const child of this.confirmButton.list) {
      const obj = child as Phaser.GameObjects.GameObject & { setAlpha?: (a: number) => unknown };
      const interactive = child as Phaser.GameObjects.GameObject;
      if ((interactive as { disableInteractive?: () => void }).disableInteractive) {
        (interactive as { disableInteractive: () => void }).disableInteractive();
      }
      obj.setAlpha?.(0.4);
    }
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
    this.stepUI?.add(skipText);
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
          // Animation finished — auto-equip the pull on the live cat
          // before advancing so the player sees it land. Cat-pull
          // (not used in the tutorial) is a no-op here.
          if (pull.kind === 'cosmetic' && pull.instanceId) {
            void this.autoEquipCosmetic(pull.itemId, pull.instanceId);
          }
          this.busy = false;
          // box-cosmetic: PAUSE on a fresh Continue overlay so the
          // player sees the equipped cosmetic on the cat before being
          // dropped into the next box's Open Box flow. Without this
          // pause, a queued OS-level tap can land on the freshly-
          // rendered box-effect button and skip box 2 entirely (Tim
          // Image 33 bug). box-effect onDone keeps the auto-advance
          // since stage-set-confirm is the next section, not another
          // open-box beat to accidentally fire.
          if (this.currentStep === 'box-cosmetic') {
            this.showPostBoxOpenContinue("looking good! now let's open the effects box.");
            return;
          }
          void this.advance();
        },
      );
    } catch (e) {
      console.warn('[tutorial] runBoxOpen threw', e);
      this.busy = false;
      await this.advance();
    }
  }

  /** After a box-open animation finishes, re-render the dialogue
   *  overlay with a fresh Continue button so the player can see the
   *  equipped pull on their cat before tapping forward. The new
   *  button is a brand-new interactive object, so queued OS taps that
   *  hit the previous Open button don't carry through. */
  private showPostBoxOpenContinue(copy: string): void {
    this.overlay?.destroy();
    this.overlay = new TutorialCatOverlay(this);
    this.overlay.show(copy, {
      continueLabel: 'Continue →',
      onContinue: () => {
        if (this.busy) return;
        void this.advance();
      },
    });
    this.renderSkipLinkIfUnlocked();
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

  // (Legacy `handleStagePick` / `handleCatPick` removed — picker steps
  //  now drive preview-then-confirm. See `renderConfirmButton` for the
  //  advance gate.)

  /** Tutorial-only naming flow per Tim:
   *  "as if they are good with the original name or would you like to
   *   name them something else?"
   *  Two buttons rendered over the live preview — Keep [default] or
   *  Rename (opens the existing CatNamingModal HTML overlay). Either
   *  path advances to merch-intro when resolved. */
  private showNameChoice(breed: CatBreed): void {
    const seatedInstance = this.playerState?.ownedCats.find((c) => c.breed === breed);
    if (!seatedInstance) {
      // Defensive — couldn't find the just-seated instance. Skip the
      // naming UX, advance.
      void this.advance();
      return;
    }
    const defaultName = seatedInstance.name;

    // Dim backdrop + panel — pushed DOWN per Tim's feedback so the
    // modal sits below Butters' bubble instead of overlapping. Center
    // the panel at y=410 (down from height/2 = 290) — leaves the top
    // ~220px free for Butters + bubble.
    const { width, height } = this.scale;
    const dim = this.add.rectangle(0, 0, width, height, 0x000000, 0.5).setOrigin(0, 0).setDepth(2500);
    const panelW = Math.min(280, width - 40);
    const panelH = 200;
    const panelCy = 410;
    const panel = this.add
      .rectangle(width / 2, panelCy, panelW, panelH, 0x1a0a2e, 1)
      .setStrokeStyle(2, 0xc678ff, 1)
      .setDepth(2500);
    const title = this.add
      .text(width / 2, panelCy - 70, `Meet ${defaultName}!`, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '14px',
        color: '#ffd34d',
      })
      .setOrigin(0.5)
      .setDepth(2501);
    const body = this.add
      .text(width / 2, panelCy - 30, `${defaultName} is a fine name — but if\nyou'd like to call them something\nelse, tap Rename.`, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '10px',
        color: '#c0a0e6',
        align: 'center',
        lineSpacing: 2,
      })
      .setOrigin(0.5)
      .setDepth(2501);

    const btnY = panelCy + 50;
    const keepBg = this.add
      .rectangle(width / 2 - 70, btnY, 120, 40, 0xffd34d, 1)
      .setStrokeStyle(2, 0x1a0a2e, 1)
      .setInteractive({ useHandCursor: true })
      .setDepth(2501);
    const keepText = this.add
      .text(width / 2 - 70, btnY, `Keep ${defaultName}`, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '10px',
        color: '#1a0a2e',
      })
      .setOrigin(0.5)
      .setDepth(2502);

    const renameBg = this.add
      .rectangle(width / 2 + 70, btnY, 120, 40, 0x2c1856, 1)
      .setStrokeStyle(2, 0xc0a0e6, 1)
      .setInteractive({ useHandCursor: true })
      .setDepth(2501);
    const renameText = this.add
      .text(width / 2 + 70, btnY, 'Rename', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#ffffff',
      })
      .setOrigin(0.5)
      .setDepth(2502);

    const items = [dim, panel, title, body, keepBg, keepText, renameBg, renameText];
    this.stepUI?.add(items);

    const teardown = (): void => {
      for (const it of items) it.destroy();
    };

    keepBg.on('pointerdown', () => {
      teardown();
      void this.advance();
    });
    renameBg.on('pointerdown', () => {
      teardown();
      // Open the existing HTML naming modal. onSubmit fires renameCat
      // then advances.
      const otherCats = (this.playerState?.ownedCats ?? []).filter((c) => c.id !== seatedInstance.id);
      const modal = new CatNamingModal(this, {
        defaultName,
        existingCats: otherCats,
        onSubmit: (name) => {
          // Optimistic local update first so the live preview reflects
          // the name immediately, then persist server-side (fire-and-
          // forget — advance even if the rename request fails).
          if (this.playerState) {
            const live = this.playerState.ownedCats.find((c) => c.id === seatedInstance.id);
            if (live) live.name = name;
          }
          this.renderSeatedCatNameLabel();
          renameCat(seatedInstance.id, name).catch((e) =>
            console.warn('[tutorial] renameCat failed (advancing anyway)', e),
          );
          void this.advance();
        },
      });
      void modal;
    });
  }

  // -----------------------------------------------------------------------
  // Private — live stage preview (persists across step transitions)
  // -----------------------------------------------------------------------

  /** Render the picked stage's background behind the overlay. Uses the
   *  thumb texture (eager-loaded) immediately; lazy-loads the full bg
   *  and swaps to the higher-res version when it arrives.  */
  private applyLiveStageBg(stageId: BackgroundId): void {
    this.stageBgId = stageId;
    const entry = BACKGROUND_CATALOG[stageId];
    if (!entry) return;
    const { width, height } = this.scale;

    // Prefer the full bg if cached; fall back to the thumb (always
    // loaded). Same fallback chain the BackgroundManager uses.
    const fullKey = entry.backdropKey;
    const thumbKey = `${fullKey}-thumb`;
    const initialKey = this.textures.exists(fullKey)
      ? fullKey
      : this.textures.exists(thumbKey)
        ? thumbKey
        : null;
    if (!initialKey) return;

    // Tear down any previous stage bg before drawing.
    this.stageBg?.destroy();
    this.stageBg = this.add
      .image(width / 2, height / 2, initialKey)
      .setDisplaySize(width, height)
      .setDepth(-150);

    // Lazy-load the full version if we started with the thumb.
    if (initialKey !== fullKey) {
      void loadBgIfMissing(this, stageId).then(() => {
        // Stale-completion guard — bail if the user picked a different
        // stage while this one was loading.
        if (this.stageBgId !== stageId || !this.stageBg) return;
        this.stageBg.setTexture(fullKey);
        this.stageBg.setDisplaySize(width, height);
      }).catch(() => { /* fallback rect stays */ });
    }
  }

  /** Auto-equip a freshly-pulled cosmetic on the live seated cat and
   *  render the visual immediately. Server-side equip fires fire-and-
   *  forget — visual updates synchronously so the player sees the
   *  cosmetic land at the moment the box-open animation finishes. */
  private async autoEquipCosmetic(cosmeticId: string, instanceId: string): Promise<void> {
    const seatedCatInstance = this.playerState?.ownedCats.find((c) => c.breed === this.seatedCatBreed);
    if (!seatedCatInstance) return;
    const cosEntry = COSMETIC_CATALOG.find((c) => c.id === cosmeticId);
    if (!cosEntry) return;
    const slot = cosEntry.slot;

    // Server-side equip — fire-and-forget. Local visual is what the
    // player notices; server state can lag a moment.
    equipCosmetic(seatedCatInstance.id, slot, instanceId).catch((e) =>
      console.warn('[tutorial] equipCosmetic failed (visual still applied)', e),
    );

    // Visual: effects use the cat-effects.ts apply() pattern; static
    // cosmetics stack a sprite at the seated cat's position.
    const effectEntry = CAT_EFFECT_BY_ID[cosmeticId];
    if (effectEntry && this.seatedCat) {
      // Tear down any previous effect before applying the new one.
      this.activeEffectHandle?.destroy();
      this.activeEffectHandle = effectEntry.apply(this, this.seatedCat, this.seatedCat.scaleX);
      return;
    }

    // Static cosmetic — render as a stacked sprite at the cat's anchor.
    if (!this.seatedCat) return;
    const renderId = cosEntry.sourceFrame?.match(/^cosmetic_(c\d+)_/)?.[1] ?? cosmeticId;
    const frame = `cosmetic_${renderId}_idle_00`;
    const sprite = this.add
      .sprite(this.seatedCat.x, this.seatedCat.y, AssetKeys.Atlas.Cosmetics, frame)
      .setOrigin(0.5, 1)
      .setScale(this.seatedCat.scaleX)
      .setDepth(-90);
    // Play the cosmetic's idle anim so it bobs with the cat (Image 30:
    // "the cosmetic is not animating with the body for this hat").
    // Cat entity does this lazily per-cosmetic; the orchestrator stacks
    // raw sprites so it has to bootstrap the loop itself.
    const cosmeticAnimKey = this.ensureCosmeticIdleAnim(renderId);
    if (cosmeticAnimKey) sprite.play(cosmeticAnimKey, true);
    if (cosEntry.tint) {
      sprite.setTint(parseInt(cosEntry.tint.replace('#', ''), 16));
    }
    this.equippedCosmeticSprites.push(sprite);
  }

  /** Render the picked cat in the middle of the canvas, ABOVE the
   *  picker cards. Per Tim's drawn-overlay feedback: preview moved up
   *  and scale reduced so it fits between Butters' feet (y≈220) and
   *  the picker cards (centerY 420 → top ≈ 361). Plays the breed's
   *  idle animation so the tail wags instead of holding a still
   *  frame — Image 27 feedback "do the same for the new band member
   *  cat" (mirroring the Butters animation fix). */
  private applyLiveCat(breed: CatBreed): void {
    this.seatedCatBreed = breed;
    this.seatedCat?.destroy();
    const { width } = this.scale;
    const x = width / 2;
    // Per Tim image 16: 'make him bigger here same size as when hes
    // putting on cosmetics make his nametag the same size as butter's
    // when hes big'. Scale back to 1.7 (matches narrator Butters); y
    // lifts from original 325 to 275 so the cat sits higher but still
    // reads as a proper merch-position visual.
    const y = 275;
    this.seatedCat = this.add
      .sprite(x, y, AssetKeys.Atlas.Cats, `${breed}_idle_00`)
      .setOrigin(0.5, 1)
      .setScale(1.7)
      .setDepth(-100);
    this.seatedCat.play(`${breed}_idle`, true);
    this.renderSeatedCatNameLabel();
  }

  /** Render/refresh the cat's name as a label below the seated sprite.
   *  Reads the current name from playerState.ownedCats so it picks up
   *  the renamed value after the name-choice modal closes. Called from
   *  every method that creates / moves the seated cat sprite. */
  private renderSeatedCatNameLabel(): void {
    this.seatedCatNameLabel?.destroy();
    if (!this.seatedCat) return;
    const seatedInstance = this.seatedCatBreed
      ? this.playerState?.ownedCats.find((c) => c.breed === this.seatedCatBreed)
      : undefined;
    const name = seatedInstance?.name ?? this.seatedCatBreed;
    if (!name) return;
    // Game.seatCats style (Courier New, white with black stroke) but
    // font size scales with the cat's current scale per Tim Image 31:
    // "nametag size should be proportional to their body size always."
    // Reference: 10px at the standard Game.seatCats scale of 1.4 — so
    // the merch cat (scale 2.7) gets ~19px and the stage cat (1.4)
    // stays at the canonical 10px.
    const nameFontPx = Math.round(10 * this.seatedCat.scaleX / 1.4);
    // At hero scale (merch-intro Mochi etc.) drop the canvas resolution
    // and NEAREST-filter the texture so the nametag looks pixelated to
    // match the pixel-art cat. Stage scale (≈1.4) keeps the original
    // crisp render — the canvas is too small to pixelate readably.
    const heroPixelate = this.seatedCat.scaleX >= 2;
    this.seatedCatNameLabel = this.add
      .text(this.seatedCat.x, this.seatedCat.y + 4, name.toUpperCase(), {
        fontFamily: '"Courier New", monospace',
        fontStyle: 'bold',
        fontSize: `${nameFontPx}px`,
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 3,
        ...(heroPixelate ? { resolution: 0.5 } : {}),
      })
      .setOrigin(0.5, 0)
      .setDepth(-90);
    if (heroPixelate) {
      this.seatedCatNameLabel.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
    }
  }

  /** Mocked hamburger drawer + hamburger icon (top-right). Renders a
   *  miniature version of the real in-game drawer (icon + label +
   *  description per row) styled to match exactly. `highlight` picks
   *  which row gets the yellow border + 'you are here' subtitle. */
  /** Dispatch a play-tutorial sub-phase. Gameplay phases (0-5) hand
   *  off to Game scene with the matching mini-chart. Phase 6 (outro
   *  menu mock) stays in the orchestrator since it's a non-gameplay
   *  beat. */
  private runPlayTutorialPhase(phase: number): void {
    const cfg = TUTORIAL_PHASE_CONFIGS[phase] ?? null;
    if (cfg) {
      this.scene.start(SceneKeys.Game, {
        playerState: this.playerState,
        tutorialPhase: phase,
        noteFallMs: cfg.noteFallMsOverride ?? TUTORIAL_NOTE_FALL_MS,
      });
      return;
    }
    if (phase === 6) {
      this.renderOutroPhase();
      return;
    }
    // Out-of-range phase — advance OUT of play-tutorial to next step.
    console.warn('[tutorial] unexpected non-gameplay phase', phase);
    void this.advance();
  }

  /** Phase 6 of play-tutorial — outro with PUT ON A SHOW highlighted in
   *  the menu mock so the player sees where to head next. Next button
   *  advances OUT of play-tutorial to editor-tour-intro. */
  private renderOutroPhase(): void {
    this.renderHamburgerMock('PUT ON A SHOW');
    const lines = getTutorialDialogue('play-tutorial');
    const line = lines[6] ?? '';
    this.overlay = new TutorialCatOverlay(this);
    this.overlay.show(line, {
      continueLabel: 'Continue →',
      onContinue: () => {
        if (this.busy) return;
        void this.advance();
      },
    });
    this.renderSkipLinkIfUnlocked();
  }

  private renderHamburgerMock(highlight: 'SET STAGE' | 'REHEARSE' | 'PUT ON A SHOW' | 'MERCH' | 'CATCH A SHOW' | 'REWARDS' | 'SETTINGS'): void {
    const { width, height } = this.scale;

    // Drawer dimensions sized to fit the canvas with margin — Tim:
    // 'MAKE THE MENU LOOK SMALLER AND FITS IN THE SCREEN HAVING
    //  WHITESPACE NOT CROWDING ANYTHING OR OVERLAPPING'.
    // Sits between Butters' bubble (top ~200) and the Continue button
    // (mid ~520) with breathing room on both sides.
    const drawerW = width - 40;
    const drawerH = 270;
    const drawerX = width / 2;
    const drawerY = 350;
    void height;
    const drawerBg = this.add
      .rectangle(drawerX, drawerY, drawerW, drawerH, 0x261540, 1)
      .setStrokeStyle(2, 0xc678ff, 1)
      .setDepth(1000);
    this.hamburgerObjects.push(drawerBg);

    // Header — "MENU" + a close-X on the right (decorative — clicking
    // it just advances since Continue does the same).
    const headerY = drawerY - drawerH / 2 + 18;
    const header = this.add
      .text(drawerX - drawerW / 2 + 16, headerY, 'MENU', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '13px',
        color: '#c0a0e6',
      })
      .setOrigin(0, 0.5)
      .setDepth(1001);
    const closeIcon = this.add
      .text(drawerX + drawerW / 2 - 18, headerY, 'ⓧ', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '14px',
        color: '#c0a0e6',
      })
      .setOrigin(1, 0.5)
      .setDepth(1001);
    this.hamburgerObjects.push(header, closeIcon);

    // Menu items — same shape as Decorate.ts buildHud.
    const items: Array<{ label: string; description: string; icon: string }> = [
      { label: 'SET STAGE',     description: 'Dress the band, light the room', icon: '😺' },
      { label: 'REHEARSE',      description: 'Pawractice makes purrfect',      icon: '🎵' },
      { label: 'PUT ON A SHOW', description: 'Cook up your next hit',          icon: '🎼' },
      { label: 'CATCH A SHOW',  description: 'Front row for fellow artists',   icon: '🎪' },
      { label: 'MERCH',         description: 'Fresh drops at the merch table', icon: '🛒' },
      { label: 'REWARDS',       description: 'Goodies on the way',             icon: '🎁' },
      { label: 'SETTINGS',      description: 'Tune effects + audio to taste',  icon: '⚙️' },
    ];

    // 7 items + header (~36) + footer (~14) in drawerH=270 leaves
    // ~220 for items: 7 × 28 + 6 × 3 = 214. Fits with a few px slack.
    const itemStartY = drawerY - drawerH / 2 + 36;
    const itemH = 28;
    const itemGap = 3;
    items.forEach((item, i) => {
      const itemY = itemStartY + i * (itemH + itemGap);
      const isHi = item.label === highlight;
      const cellBg = this.add
        .rectangle(drawerX, itemY + itemH / 2, drawerW - 24, itemH, isHi ? 0x4a2c7a : 0x2c1856, 1)
        .setStrokeStyle(2, isHi ? 0xffd34d : 0xc0a0e6, isHi ? 1 : 0.4)
        .setDepth(1001);
      const iconText = this.add
        .text(drawerX - drawerW / 2 + 22, itemY + itemH / 2, item.icon, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontSize: '14px',
          color: '#ffffff',
        })
        .setOrigin(0.5)
        .setDepth(1002);
      const labelText = this.add
        .text(drawerX - drawerW / 2 + 44, itemY + 4, isHi ? `★ ${item.label}` : item.label, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '9px',
          color: isHi ? '#ffd34d' : '#ffffff',
        })
        .setOrigin(0, 0)
        .setDepth(1002);
      // Per Tim image 4: highlighted row keeps its real subtitle ("Dress
      // the band, light the room" etc.) — the old "you are here" override
      // hid the description and made the mock feel under-informed.
      const descText = this.add
        .text(drawerX - drawerW / 2 + 44, itemY + 16, item.description, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontSize: '7px',
          color: isHi ? '#ffd34d' : '#c0a0e6',
        })
        .setOrigin(0, 0)
        .setDepth(1002);
      this.hamburgerObjects.push(cellBg, iconText, labelText, descText);
    });

    // Footer hint.
    const footerY = drawerY + drawerH / 2 - 14;
    const footer = this.add
      .text(drawerX, footerY, 'tap outside to close', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '9px',
        color: '#6f5a91',
      })
      .setOrigin(0.5)
      .setDepth(1001);
    this.hamburgerObjects.push(footer);

    // Hamburger icon top-right — visual hint that this menu lives
    // behind the ☰ button in the real game. Depth above the tutorial-
    // cat overlay (2000) so it stays visible.
    const iconX = width - 24;
    const iconY = 28;
    const iconBg = this.add
      .rectangle(iconX, iconY, 32, 32, 0xffd34d, 1)
      .setStrokeStyle(2, 0x1a0a2e, 1)
      .setDepth(2500);
    const iconLabel = this.add
      .text(iconX, iconY, '☰', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '16px',
        color: '#1a0a2e',
      })
      .setOrigin(0.5)
      .setDepth(2501);
    this.hamburgerObjects.push(iconBg, iconLabel);
  }

  /** Transition the orchestrator's live preview from the merch layout
   *  (one big cat lower-center) to the "ready to rehearse" stage —
   *  matches the real Game scene's seat positions: player cat at the
   *  center seat (lane 1), small Butters at the left seat (lane 0),
   *  right seat empty. Plus 3 lanes drawn underneath so the player
   *  sees the actual playfield they're about to rehearse on.
   *  Persistent across play-tutorial beats. */
  private switchToRehearsalStage(): void {
    if (!this.seatedCat) return;
    const { width, height } = this.scale;
    // Match Game.seatCats EXACTLY: catY scales with the canvas, not raw
    // design coords. Tim's Image 30 feedback ("the cat seems to be
    // floating"): raw 184 sat too high in iPhone viewports because the
    // lanes scaled but the cat didn't. Applying scaleY pins the cat to
    // the cat-stage band the same way the real Game scene does.
    const scaleY = height / L.DESIGN_H;
    const stageY = (L.TOP_HUD_H + L.CAT_STAGE_H * 0.78) * scaleY;
    const stageScale = 1.4;
    const centerX = L.laneCenterX(1, width);

    // Animate the move — tween cat + cosmetics from current pos/scale
    // to the center seat for a smooth transition (Tim feedback:
    // "any time the cats are moving from one section to another try to
    // add a little animation to make that transition smooth"). Hide
    // the name label for the duration so it doesn't lag behind the
    // tweening sprite; re-render at the end position on completion.
    this.seatedCatNameLabel?.destroy();
    this.seatedCatNameLabel = undefined;
    const cosmetics = [...this.equippedCosmeticSprites];
    this.tweens.add({
      targets: [this.seatedCat, ...cosmetics],
      x: centerX,
      y: stageY,
      scale: stageScale,
      duration: 360,
      ease: 'Cubic.Out',
      onComplete: () => {
        this.renderSeatedCatNameLabel();
      },
    });

    // Effect handle: tear down — it's anchored to the previous cat
    // position. Won't re-apply during the tutorial rehearsal beats; the
    // real Game scene re-applies it when the rehearsal actually starts.
    this.activeEffectHandle?.destroy();
    this.activeEffectHandle = undefined;

    // Draw the 3-lane playfield underneath the seats. Mirrors
    // Game.drawLanes (rhythm-bar texture + fuzzball target per lane),
    // but tinted with the default LANE_COLORS so a missing-seat lane
    // still reads (we don't have full per-cat lane-tint resolution at
    // this point in the tutorial).
    this.tearDownStageLanes();
    this.drawStageLanes();

    // Per Tim image 6: the orchestrator preview no longer seats a small
    // stage Butters at lane 0. The narrator/overlay Butters is the only
    // visible Butters during stage-set-confirm / rehearsal-intro — a
    // duplicate read as "two Butters". When play-tutorial runs in Game
    // scene, seatTutorialButters there handles the lane-0 seat.
    this.stageButters?.destroy();
    this.stageButters = undefined;
    this.stageButtersGlasses?.destroy();
    this.stageButtersGlasses = undefined;
    this.stageButtersNameLabel?.destroy();
    this.stageButtersNameLabel = undefined;
  }

  /** Tear down the 3-lane rhythm-bar visuals seeded by drawStageLanes.
   *  Safe to call when nothing is rendered. */
  private tearDownStageLanes(): void {
    for (const gfx of this.stageLaneGfx) gfx.destroy();
    this.stageLaneGfx = [];
  }

  /** Tear down the editor-tour mock. Safe to call when nothing is rendered. */
  private tearDownEditorMock(): void {
    for (const obj of this.editorMockObjects) obj.destroy();
    this.editorMockObjects = [];
  }

  /** Replant Mochi at her stage seat + draw the lanes when orchestrator
   *  boots into a step past stage-set-confirm. No tween — the tween
   *  already played the first time the player saw stage-set-confirm;
   *  this is a "she's already there" presence guarantee for outro
   *  beats where the orchestrator was just re-started by scene.start
   *  returning from Game scene. */
  private ensureStageRigForCurrentStep(): void {
    if (!this.playerState) return;
    if (this.seatedCat) return;
    const currentIdx = TUTORIAL_STEP_ORDER.indexOf(this.currentStep);
    const stageSetIdx = TUTORIAL_STEP_ORDER.indexOf('stage-set-confirm');
    if (currentIdx < stageSetIdx) return;

    // Resolve the seated center cat's breed from playerState.
    const centerInstanceId = this.playerState.seatedCats?.['seat-center'];
    if (!centerInstanceId) return;
    const ownedCat = this.playerState.ownedCats.find((c) => c.id === centerInstanceId);
    if (!ownedCat) return;

    this.seatedCatBreed = ownedCat.breed;
    const { width, height } = this.scale;
    const scaleY = height / L.DESIGN_H;
    const stageY = (L.TOP_HUD_H + L.CAT_STAGE_H * 0.78) * scaleY;
    const stageScale = 1.4;
    const centerX = L.laneCenterX(1, width);

    this.seatedCat = this.add
      .sprite(centerX, stageY, AssetKeys.Atlas.Cats, `${ownedCat.breed}_idle_00`)
      .setOrigin(0.5, 1)
      .setScale(stageScale)
      .setDepth(-100);
    this.seatedCat.play(`${ownedCat.breed}_idle`, true);
    this.renderSeatedCatNameLabel();

    this.tearDownStageLanes();
    this.drawStageLanes();
    this.stageRigBuilt = true;
  }

  /** Toggle the persistent stage rig's visibility — used to hide the
   *  seated cat + lanes during editor-tour so the venue bg shows clean
   *  through the editor mock's lane washes (the real ChartEditor has no
   *  cats above the grid). Restored on every other step's renderStep. */
  private setStageRigVisible(visible: boolean): void {
    this.seatedCat?.setVisible(visible);
    this.seatedCatNameLabel?.setVisible(visible);
    for (const sprite of this.equippedCosmeticSprites) sprite.setVisible(visible);
    for (const gfx of this.stageLaneGfx) {
      const node = gfx as Phaser.GameObjects.GameObject & { setVisible?: (v: boolean) => void };
      node.setVisible?.(visible);
    }
  }

  /** Render a chart-editor mock behind Butters during the editor-tour
   *  beats. Mirrors the actual ChartEditor visuals at smaller scale —
   *  yellow PUT ON A SHOW title strip up top, lane washes tinted by
   *  the seated cats (resolveLaneTintsFromSeatedCats so the middle
   *  lane matches the player's picked starter cat), real fuzz-ball
   *  ball + letters atlas frames for tap notes, real tube texture for
   *  holds/slides, and the same 2×2 bottom-strip layout (CLEAR · BACK
   *  TO TOP · PAGES · REHEARSE) as ChartEditor.
   *
   *  `demoCount` cumulative visible demo notes (1=tap, 2=+hold, 3=+slide).
   *  `highlightRehearse` puts a red pulse stroke on REHEARSE for the
   *  "when you're ready, press rehearse" beat. */
  private renderEditorMock(demoCount: number, highlightRehearse = false): void {
    this.tearDownEditorMock();
    this.setStageRigVisible(false);
    const { width, height } = this.scale;

    // Full-canvas layout per Tim image 7. Dimensions match ChartEditor
    // CANONICALLY: HEADER_BANNER_H 42, PAGE_NAV_ROW_H 36, BOTTOM_STRIP_H
    // 78. Note constants from Note.configure used directly (ball 54×54,
    // TAIL_WIDTH 44, SLIDE_TUBE_THICKNESS 64, TAIL_CAP_HEIGHT 32) so the
    // mock's ball-to-tube and ball-to-tail ratios are identical to in-
    // game — slide is wider than the ball, tail is slightly narrower
    // than the ball, exactly as players see in real charts.
    const startY = 50;
    const HEADER_BANNER_H = 42;
    const PAGE_NAV_H = 36;
    const BOTTOM_STRIP_H = 78;
    const gridTop = startY + HEADER_BANNER_H;
    const gridBottom = height - BOTTOM_STRIP_H - PAGE_NAV_H;
    const gridH = gridBottom - gridTop;
    const cols = 3;
    const cellW = width / cols;

    // Note constants — canonical from Note.configure.
    const BALL_SIZE = 54;
    const TAIL_WIDTH = 44;
    const SLIDE_TUBE_THICKNESS = 64;
    const TAIL_CAP_HEIGHT = 32;

    // ── HEADER BANNER (canonical dims: HEADER_BANNER_H 42, font 13px) ─
    const banner = this.add
      .rectangle(0, startY, width, HEADER_BANNER_H, 0x1a0a2e, 1)
      .setOrigin(0, 0)
      .setDepth(50);
    const seam = this.add
      .rectangle(0, startY + HEADER_BANNER_H - 1, width, 1, 0xc0a0e6, 0.4)
      .setOrigin(0, 0)
      .setDepth(51);
    const backChipBg = this.add
      .rectangle(24, startY + HEADER_BANNER_H / 2, 36, 24, 0x2c1856, 1)
      .setStrokeStyle(1, 0xc0a0e6, 0.6)
      .setDepth(51);
    const backChipTxt = this.add
      .text(24, startY + HEADER_BANNER_H / 2, '◀', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#ffd34d',
      })
      .setOrigin(0.5)
      .setDepth(52);
    const songTitle = this.add
      .text(width / 2, startY + HEADER_BANNER_H / 2, 'THE QUIET BETWEEN NOTES', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '13px',
        color: '#ffd34d',
        stroke: '#0b041a',
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(52);
    this.editorMockObjects.push(banner, seam, backChipBg, backChipTxt, songTitle);

    // ── LANE WASHES (real tints, no backdrop — bg shows through) ──
    const resolvedTints = resolveLaneTintsFromSeatedCats(this.playerState);
    const tints: readonly [number, number, number] = resolvedTints
      ?? [LANE_COLORS[0]!, LANE_COLORS[1]!, LANE_COLORS[2]!];
    for (let c = 0; c < cols; c++) {
      const cx = (c + 0.5) * cellW;
      const wash = this.add
        .rectangle(cx, gridTop + gridH / 2, cellW - 2, gridH, liftTowardWhite(tints[c]!, LANE_BRIGHTNESS_LIFT), 0.55)
        .setDepth(50);
      this.editorMockObjects.push(wash);
    }

    // ── GRID LINES (16 rows = 2 pages of 8) + column separators ──
    const rows = 16;
    const rowH = gridH / rows;
    for (let r = 1; r < rows; r++) {
      const y = gridTop + r * rowH;
      const line = this.add
        .line(0, 0, 0, y, width, y, 0x0b041a, 0.3)
        .setOrigin(0, 0)
        .setDepth(51);
      this.editorMockObjects.push(line);
    }
    for (let c = 1; c < cols; c++) {
      const x = c * cellW;
      const line = this.add
        .line(0, 0, x, gridTop, x, gridBottom, 0x0b041a, 0.3)
        .setOrigin(0, 0)
        .setDepth(51);
      this.editorMockObjects.push(line);
    }

    // ── PAGE BREAK MARKERS (canonical alpha 0.85) ────────────────
    const midY = gridTop + (rows / 2) * rowH;
    const pageChipStyle = {
      fontFamily: 'Pixeloid Sans, sans-serif',
      fontStyle: 'bold',
      fontSize: '11px',
      color: '#1a0a2e',
      backgroundColor: '#ffd34d',
      padding: { x: 6, y: 1 },
    } as const;
    const pageTopLine = this.add
      .rectangle(width / 2, gridTop, width - 12, 2, 0xffd34d, 0.85)
      .setDepth(52);
    const pageMidLine = this.add
      .rectangle(width / 2, midY, width - 12, 2, 0xffd34d, 0.85)
      .setDepth(52);
    const pageTopChip = this.add
      .text(width / 2, gridTop, 'PAGE 1', pageChipStyle)
      .setOrigin(0.5)
      .setDepth(53);
    const pageMidChip = this.add
      .text(width / 2, midY, 'PAGE 2', pageChipStyle)
      .setOrigin(0.5)
      .setDepth(53);
    this.editorMockObjects.push(pageTopLine, pageMidLine, pageTopChip, pageMidChip);

    const colCenterX = (col: number) => (col + 0.5) * cellW;
    const rowCenterY = (row: number) => gridTop + (row + 0.5) * rowH;

    // ── DEMO NOTES — canonical dimensions exactly ──────────────
    // Tap: ball + letters at BALL_SIZE (54×54), same as Note.configure.
    if (demoCount >= 1) {
      const cx = colCenterX(1);
      const cy = rowCenterY(2);
      const tapBall = this.add
        .image(cx, cy, AssetKeys.Image.MeowcertElementBallWhite)
        .setTint(tints[1]!)
        .setDisplaySize(BALL_SIZE, BALL_SIZE)
        .setDepth(54);
      const tapLetters = this.add
        .image(cx, cy, AssetKeys.Image.MeowcertElementLetters)
        .setDisplaySize(BALL_SIZE, BALL_SIZE)
        .setDepth(55);
      this.editorMockObjects.push(tapBall, tapLetters);
    }

    // Hold: per Tim image-10 follow-up — ball + letters at the BOTTOM,
    // tail extending UP. Mirrors the editor's "drag UP from the tap to
    // extend" convention. TailBody (no caps) covers the body, TailCap
    // closes the top (rotated to mate with the body). The head (with
    // ps letters) sits at the bottom anchor.
    if (demoCount >= 2) {
      const xLane = colCenterX(1);
      const yTop = rowCenterY(5);   // tail-end (visual top of capsule)
      const yBot = rowCenterY(9);   // head anchor
      const bodyHeight = Math.max(0, yBot - yTop - TAIL_CAP_HEIGHT);
      const bodyMidY = yTop + TAIL_CAP_HEIGHT + bodyHeight / 2;
      const tailBody = this.add
        .tileSprite(xLane, bodyMidY, TAIL_WIDTH, bodyHeight, AssetKeys.Image.TailBody)
        .setTint(tints[1]!)
        .setDepth(53);
      const tailCap = this.add
        .image(xLane, yTop + TAIL_CAP_HEIGHT / 2, AssetKeys.Image.TailCap)
        .setTint(tints[1]!)
        .setDisplaySize(TAIL_WIDTH, TAIL_CAP_HEIGHT)
        .setDepth(53);
      const head = this.add
        .image(xLane, yBot, AssetKeys.Image.MeowcertElementBallWhite)
        .setTint(tints[1]!)
        .setDisplaySize(BALL_SIZE, BALL_SIZE)
        .setDepth(54);
      const headLetters = this.add
        .image(xLane, yBot, AssetKeys.Image.MeowcertElementLetters)
        .setDisplaySize(BALL_SIZE, BALL_SIZE)
        .setDepth(55);
      this.editorMockObjects.push(tailBody, tailCap, head, headLetters);
    }

    // Slide: same setDisplaySize(THICKNESS, tubeLen) → setRotation(PI/2)
    // order Note.configure uses, with SLIDE_TUBE_THICKNESS 64 (wider
    // than BALL_SIZE 54 — slide reads as a fat connector, not a pencil).
    if (demoCount >= 3) {
      const yMid = rowCenterY(13);
      const xStart = colCenterX(0);
      const xEnd = colCenterX(2);
      const tubeLen = xEnd - xStart;
      const slideTube = this.add
        .image((xStart + xEnd) / 2, yMid, AssetKeys.Image.MeowcertTubeWhite)
        .setDisplaySize(SLIDE_TUBE_THICKNESS, tubeLen)
        .setRotation(Math.PI / 2)
        .setTint(tints[0]!)
        .setDepth(53);
      const headStart = this.add
        .image(xStart, yMid, AssetKeys.Image.MeowcertElementBallWhite)
        .setTint(tints[0]!)
        .setDisplaySize(BALL_SIZE, BALL_SIZE)
        .setDepth(54);
      const headStartLetters = this.add
        .image(xStart, yMid, AssetKeys.Image.MeowcertElementLetters)
        .setDisplaySize(BALL_SIZE, BALL_SIZE)
        .setDepth(55);
      const slideArrow = this.add
        .text(xEnd, yMid, '▶', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '20px',
          color: '#ffffff',
          stroke: '#1a0a2e',
          strokeThickness: 3,
        })
        .setOrigin(0.5)
        .setDepth(55);
      this.editorMockObjects.push(slideTube, headStart, headStartLetters, slideArrow);
    }

    // Double slide (slide-and-return) — sits BETWEEN the hold and the
    // single slide per Tim image 18 ('make double slide note here' —
    // he circled the empty band at row ~10-11). Distinguished from the
    // single slide by ◀ on the LEFT and ▶ on the RIGHT (both ends
    // marked), large 26px text so the gesture reads at a glance.
    if (demoCount >= 4) {
      const yMid = rowCenterY(10);
      const xStart = colCenterX(0);
      const xEnd = colCenterX(2);
      const tubeLen = xEnd - xStart;
      const slideTube = this.add
        .image((xStart + xEnd) / 2, yMid, AssetKeys.Image.MeowcertTubeWhite)
        .setDisplaySize(SLIDE_TUBE_THICKNESS, tubeLen)
        .setRotation(Math.PI / 2)
        .setTint(tints[1]!)
        .setDepth(53);
      const headStart = this.add
        .image(xStart, yMid, AssetKeys.Image.MeowcertElementBallWhite)
        .setTint(tints[1]!)
        .setDisplaySize(BALL_SIZE, BALL_SIZE)
        .setDepth(54);
      const headStartLetters = this.add
        .image(xStart, yMid, AssetKeys.Image.MeowcertElementLetters)
        .setDisplaySize(BALL_SIZE, BALL_SIZE)
        .setDepth(55);
      const arrowStyle = {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '26px',
        color: '#ffffff',
        stroke: '#1a0a2e',
        strokeThickness: 4,
      } as const;
      const leftArrow = this.add
        .text(xStart - BALL_SIZE / 2 - 6, yMid, '◀', arrowStyle)
        .setOrigin(1, 0.5)
        .setDepth(55);
      const rightArrow = this.add
        .text(xEnd, yMid, '▶', arrowStyle)
        .setOrigin(0.5)
        .setDepth(55);
      this.editorMockObjects.push(slideTube, headStart, headStartLetters, leftArrow, rightArrow);
    }

    // ── PAGE NAV ROW (canonical: arrow 36×28, font 14, label 12) ─
    const pageNavY = gridBottom + PAGE_NAV_H / 2;
    const arrowW = 36;
    const arrowH = 28;
    const arrowGap = 60;
    const arrowL = this.add
      .rectangle(width / 2 - arrowGap, pageNavY, arrowW, arrowH, 0x2c1856, 1)
      .setStrokeStyle(1, 0xc0a0e6, 0.7)
      .setDepth(52);
    const arrowLTxt = this.add
      .text(width / 2 - arrowGap, pageNavY, '◀', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '14px',
        color: '#ffd34d',
      })
      .setOrigin(0.5)
      .setDepth(53);
    const pageNavLabel = this.add
      .text(width / 2, pageNavY, '1 / 8', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#ffffff',
      })
      .setOrigin(0.5)
      .setDepth(53);
    const arrowR = this.add
      .rectangle(width / 2 + arrowGap, pageNavY, arrowW, arrowH, 0x2c1856, 1)
      .setStrokeStyle(1, 0xc0a0e6, 0.7)
      .setDepth(52);
    const arrowRTxt = this.add
      .text(width / 2 + arrowGap, pageNavY, '▶', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '14px',
        color: '#ffd34d',
      })
      .setOrigin(0.5)
      .setDepth(53);
    this.editorMockObjects.push(arrowL, arrowLTxt, pageNavLabel, arrowR, arrowRTxt);

    // ── BOTTOM STRIP (canonical: btnH 30, rowGap 6) ─────────────
    const stripY = gridBottom + PAGE_NAV_H;
    const strip = this.add
      .rectangle(0, stripY, width, BOTTOM_STRIP_H, 0x0b041a, 0.95)
      .setOrigin(0, 0)
      .setDepth(53);
    this.editorMockObjects.push(strip);

    const sideMargin = 10;
    const colGap = 6;
    const rowGap = 6;
    const btnH = 30;
    const btnW = (width - sideMargin * 2 - colGap) / 2;
    const leftX = sideMargin + btnW / 2;
    const rightX = sideMargin + btnW + colGap + btnW / 2;
    const topRowY = stripY + 5 + btnH / 2;
    const botRowY = topRowY + btnH + rowGap;

    const drawSecondary = (x: number, y: number, label: string, fontSize: string) => {
      const bg = this.add
        .rectangle(x, y, btnW, btnH, 0x2c1856, 1)
        .setStrokeStyle(1, 0xc678ff, 0.7)
        .setDepth(54);
      const txt = this.add
        .text(x, y, label, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize,
          color: '#c0a0e6',
        })
        .setOrigin(0.5)
        .setDepth(55);
      this.editorMockObjects.push(bg, txt);
    };

    drawSecondary(leftX, topRowY, 'CLEAR', '12px');
    drawSecondary(rightX, topRowY, 'BACK TO TOP', '11px');
    drawSecondary(leftX, botRowY, 'PAGES: ON', '12px');

    const rehearseStroke = highlightRehearse ? 0xff5050 : 0x0b041a;
    const rehearseStrokeW = highlightRehearse ? 3 : 1;
    const rehearseBg = this.add
      .rectangle(rightX, botRowY, btnW, btnH, 0xffd34d, 1)
      .setStrokeStyle(rehearseStrokeW, rehearseStroke, 1)
      .setDepth(54);
    const rehearseTxt = this.add
      .text(rightX, botRowY, 'REHEARSE', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '13px',
        color: '#1a0a2e',
      })
      .setOrigin(0.5)
      .setDepth(55);
    this.editorMockObjects.push(rehearseBg, rehearseTxt);

    if (highlightRehearse) {
      this.tweens.add({
        targets: rehearseBg,
        scaleX: 1.06,
        scaleY: 1.06,
        duration: 540,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.InOut',
      });
    }
  }

  /** Register a cosmetic's idle anim lazily — the Cat entity does this
   *  per-cosmetic internally, but the orchestrator renders raw sprites
   *  for Butters' glasses on the stage and needs to bootstrap the
   *  anim itself. Returns the anim key on success, '' if no frames. */
  private ensureCosmeticIdleAnim(cosmeticRenderId: string): string {
    const key = `cosmetic_${cosmeticRenderId}_idle`;
    if (this.anims.exists(key)) return key;
    const atlas = this.textures.get(AssetKeys.Atlas.Cosmetics);
    const prefix = `cosmetic_${cosmeticRenderId}_idle_`;
    const frames = atlas
      .getFrameNames()
      .filter((n) => n.startsWith(prefix))
      .sort()
      .map((frame) => ({ key: AssetKeys.Atlas.Cosmetics, frame }));
    if (frames.length === 0) return '';
    this.anims.create({ key, frames, frameRate: 7, repeat: -1 });
    return key;
  }

  /** Draw the 3 lanes + hit targets behind the seated cats, matching
   *  Game.drawLanes' geometry so the tutorial preview reads as the
   *  actual playfield. Per-lane tints follow the seated cat at that
   *  lane (Butters on lane 0, player cat on lane 1, empty seat 2
   *  inherits from the nearest occupied lane) — Image 30 feedback:
   *  "the lanes for the tutorial also need to match the color of the
   *  lane cat." Falls back to LANE_COLORS if neither seat is filled. */
  private drawStageLanes(): void {
    const { width, height } = this.scale;
    const scaleY = height / L.DESIGN_H;
    const laneTopY = L.LANE_TOP_Y * scaleY;
    const laneH = (L.LANE_BOTTOM_Y - L.LANE_TOP_Y) * scaleY;
    const hitLineY = L.HIT_LINE_Y * scaleY;
    const inner = width - L.LANE_GUTTER_PX * 2;
    const colW = (inner - L.LANE_GAP_PX * (L.LANE_COUNT - 1)) / L.LANE_COUNT;

    // Resolve the per-lane tint trio from the actual cats on stage in
    // the tutorial: Butters on the LEFT seat (cat13), player cat on the
    // CENTER seat (this.seatedCatBreed), right seat empty. Empty seats
    // inherit the color of the nearest occupied lane so the right lane
    // shows the player cat's tint instead of a stranger color.
    const laneTints: (number | null)[] = [
      CAT_COLOR_BY_BREED['cat13'] ?? null,
      this.seatedCatBreed ? (CAT_COLOR_BY_BREED[this.seatedCatBreed] ?? null) : null,
      null,
    ];
    for (let i = 0; i < 3; i++) {
      if (laneTints[i] !== null) continue;
      for (let d = 1; d < 3; d++) {
        const right = i + d, left = i - d;
        if (right < 3 && laneTints[right] !== null) { laneTints[i] = laneTints[right]; break; }
        if (left >= 0 && laneTints[left] !== null) { laneTints[i] = laneTints[left]; break; }
      }
    }

    for (let i = 0; i < L.LANE_COUNT; i++) {
      const cx = L.laneCenterX(i as 0 | 1 | 2, width);
      const color = laneTints[i] ?? L.LANE_COLORS[i]!;
      const bar = this.add.image(cx, laneTopY + laneH / 2, AssetKeys.Image.RhythmBarBackgroundWhite);
      bar.displayWidth = laneH;
      bar.displayHeight = colW;
      bar.setRotation(-Math.PI / 2);
      bar.setTint(liftTowardWhite(color, LANE_BRIGHTNESS_LIFT));
      bar.setAlpha(0.78);
      bar.setDepth(-120);
      this.stageLaneGfx.push(bar);

      const target = this.add.image(cx, hitLineY, AssetKeys.Image.MeowcertTargetWhite);
      target.setDisplaySize(72, 72);
      target.setTint(color);
      target.setDepth(-110);
      this.stageLaneGfx.push(target);
    }
  }

  /** Reposition the seated cat (and any stacked cosmetic sprites +
   *  active effect) for the merch beats — bigger + lower so the
   *  player can clearly see cosmetic pulls land on him. Per Tim:
   *  "move the player's cat down and him bigger while we get
   *   cosmetics for him." */
  private switchToMerchLayout(): void {
    if (!this.seatedCat) return;
    // Tim: 'cat can be more to the center and just slightly bigger'.
    // y=460 → 430 (lifts the cat into the empty middle zone) +
    // scale 2.2 → 2.7 (bigger silhouette).
    const merchY = 430;
    const merchScale = 2.7;
    // Tween instead of snap — Tim wants smooth transitions between
    // sections. Hide the name label during the tween; re-render at
    // the end position so it stays anchored to the sprite cleanly.
    this.seatedCatNameLabel?.destroy();
    this.seatedCatNameLabel = undefined;
    const cosmetics = [...this.equippedCosmeticSprites];
    this.tweens.add({
      targets: [this.seatedCat, ...cosmetics],
      y: merchY,
      scale: merchScale,
      duration: 360,
      ease: 'Cubic.Out',
      onComplete: () => {
        this.renderSeatedCatNameLabel();
      },
    });
    // Active effect is a particle emitter tied to the prior cat
    // position — tear it down so it doesn't continue spawning at the
    // old anchor. Re-applies on the next box-effect pull.
    this.activeEffectHandle?.destroy();
    this.activeEffectHandle = undefined;
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
    this.previousStep = this.currentStep;
    this.currentStep = next;
    this.dialogueIndex = 0;

    // Layout swap on transition into the merch section — bigger cat,
    // lower position so the cosmetic + effect pulls land prominently
    // on him. Stays in this layout through box-effect; the next layout
    // swap happens when we transition into rehearsal-intro (TBD).
    if (next === 'merch-intro') {
      this.switchToMerchLayout();
    }

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
