import { Scene } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { AssetKeys } from '@/constants/assets';
import * as L from '@/constants/scene-layout';
import { liftTowardWhite, LANE_BRIGHTNESS_LIFT } from '@/entities/note-colors';
import { CAT_COLOR_BY_BREED } from '@/constants/cat-colors';
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
  /** BUTTERS nametag below the small stage Butters — same scaled style
   *  as the player cat's nametag. Added per Tim Image 31. */
  private stageButtersNameLabel: Phaser.GameObjects.Text | undefined;

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
    const { width, height } = this.scale;

    // Persistent backdrop — sits below everything and stays for the
    // whole scene lifecycle. Stage bg (when picked) layers on top of
    // this; otherwise this is the only thing visible behind the
    // overlay.
    this.backdropFallback = this.add
      .rectangle(0, 0, width, height, 0x261540, 1)
      .setOrigin(0, 0)
      .setDepth(-200);

    // Show the first venue (the first card in the upcoming pick-stage
    // picker) as the intro bg so Butters never appears on an empty
    // purple backdrop AND the bg matches what the player is about to
    // see in the picker — NOT whatever activeBackground is on the
    // playerState (which can be a stale dev seed). Tim's feedback:
    // "it should be selecting the first background that is in the
    //  next sections picker not the first background we have".
    const initialBg = STARTER_STAGES[0];
    if (initialBg) {
      this.applyLiveStageBg(initialBg);
    }

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
        continueLabel: 'Open box →',
        onContinue: () => {
          if (this.busy) return;
          void this.runBoxOpen(boxId);
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
      this.renderHamburgerMock('REHEARSE');
      this.overlay = new TutorialCatOverlay(this);
      this.overlay.show(line, {
        continueLabel: 'Continue →',
        onContinue: () => {
          if (this.busy) return;
          this.busy = true;
          this.switchToRehearsalStage();
          this.busy = false;
          void this.advance();
        },
      });
      this.renderSkipLinkIfUnlocked();
      return;
    }

    // stage-set-confirm: same hamburger menu pattern as rehearsal-intro
    // but PUT ON A SHOW highlighted — that's the gateway Butters is
    // saying you can come back to any time.
    if (this.currentStep === 'stage-set-confirm') {
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
    const y = 325; // bottom-anchored — sprite fills ~218–325 at scale 1.7
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
    this.seatedCatNameLabel = this.add
      .text(this.seatedCat.x, this.seatedCat.y + 4, name.toUpperCase(), {
        fontFamily: '"Courier New", monospace',
        fontStyle: 'bold',
        fontSize: `${nameFontPx}px`,
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5, 0)
      .setDepth(-90);
  }

  /** Mocked hamburger drawer + hamburger icon (top-right). Renders a
   *  miniature version of the real in-game drawer (icon + label +
   *  description per row) styled to match exactly. `highlight` picks
   *  which row gets the yellow border + 'you are here' subtitle. */
  private renderHamburgerMock(highlight: 'SET STAGE' | 'REHEARSE'): void {
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
      { label: 'MERCH',         description: 'Fresh drops at the merch table', icon: '🛒' },
      { label: 'CATCH A SHOW',  description: 'Front row for fellow artists',   icon: '🎪' },
      { label: 'INBOX',         description: 'Who played your shows?',         icon: '📬' },
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
      const descText = this.add
        .text(drawerX - drawerW / 2 + 44, itemY + 16, isHi ? 'you are here' : item.description, {
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

    // Seat a small Butters at the left lane (lane 0) so the player
    // can see who's narrating. Same scale as the player cat per Tim's
    // brief ("butters can also shrink down to be the same size next to
    // the cat sort of where the usual other band member goes").
    this.stageButters?.destroy();
    this.stageButtersGlasses?.destroy();
    const buttersX = L.laneCenterX(0, width);
    this.stageButters = this.add
      .sprite(buttersX, stageY, AssetKeys.Atlas.Cats, 'cat13_idle_00')
      .setOrigin(0.5, 1)
      .setScale(stageScale)
      .setDepth(-100)
      .setAlpha(0);
    this.stageButters.play('cat13_idle', true);
    this.stageButtersGlasses = this.add
      .sprite(buttersX, stageY, AssetKeys.Atlas.Cosmetics, 'cosmetic_c2_idle_00')
      .setOrigin(0.5, 1)
      .setScale(stageScale)
      .setDepth(-90)
      .setAlpha(0);
    // Lazy-register the cosmetic idle anim so the glasses bob with
    // Butters' head instead of holding frame 00 while the cat moves.
    const glassesAnimKey = this.ensureCosmeticIdleAnim('c2');
    if (glassesAnimKey) this.stageButtersGlasses.play(glassesAnimKey, true);
    // BUTTERS nametag below small Butters — same Game.seatCats style
    // as the player cat's nametag, font scaled by stageScale per Tim
    // Image 31 ("butters nametag missing"). Faded in with the sprites.
    this.stageButtersNameLabel?.destroy();
    const nameFontPx = Math.round(10 * stageScale / 1.4);
    this.stageButtersNameLabel = this.add
      .text(buttersX, stageY + 4, 'BUTTERS', {
        fontFamily: '"Courier New", monospace',
        fontStyle: 'bold',
        fontSize: `${nameFontPx}px`,
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5, 0)
      .setDepth(-89)
      .setAlpha(0);
    // Fade Butters + glasses + nametag in alongside the cat tween.
    this.tweens.add({
      targets: [this.stageButters, this.stageButtersGlasses, this.stageButtersNameLabel],
      alpha: 1,
      duration: 360,
      ease: 'Sine.Out',
    });
  }

  /** Tear down the 3-lane rhythm-bar visuals seeded by drawStageLanes.
   *  Safe to call when nothing is rendered. */
  private tearDownStageLanes(): void {
    for (const gfx of this.stageLaneGfx) gfx.destroy();
    this.stageLaneGfx = [];
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
