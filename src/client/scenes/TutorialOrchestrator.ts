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
      // up top per Tim's feedback.
      this.overlay.show(line, { bubbleY: 170 });
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
          setBackground(stageId as BackgroundId).catch((e) =>
            console.warn('[tutorial] setBackground failed (preview only)', e),
          );
          this.pendingPickerSelection = stageId;
          this.renderConfirmButton();
        },
      });
      // Per Tim: default to the first venue highlighted + shown as bg
      // on entry. Subsequent taps swap; Confirm advances.
      const defaultStage = STARTER_STAGES[0];
      if (defaultStage) {
        this.applyLiveStageBg(defaultStage);
        setBackground(defaultStage).catch(() => {});
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
          this.applyLiveCat(breed as CatBreed);
          // Server write — seat in middle. Fire-and-forget; advance
          // happens on Confirm.
          seedStarterCat(breed as CatBreed).catch((e) =>
            console.warn('[tutorial] seedStarterCat failed (preview only)', e),
          );
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
    // position.
    const continueLabel = hasMoreDialogue ? 'Next →' : 'Continue →';
    this.overlay = new TutorialCatOverlay(this);
    this.overlay.show(line, {
      continueLabel,
      hero: this.currentStep === 'intro',
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
          this.confirmButton?.destroy(true);
          this.confirmButton = undefined;
          // Tear the picker down NOW so it doesn't sit under the
          // name-choice modal / next step's UI. (stepUI would clear it
          // on the next renderStep anyway, but during the cat-pick
          // showNameChoice we don't transition steps — the modal
          // overlays the existing picker if we don't kill it here.)
          this.picker?.destroy();
          this.picker = undefined;
          if (this.currentStep === 'pick-cat') {
            // Cat-pick has the name-or-keep modal as a gate before
            // advancing to merch-intro.
            const breed = this.seatedCatBreed;
            if (breed) this.showNameChoice(breed);
            else void this.advance();
          } else {
            void this.advance();
          }
        },
      });
    });
    this.confirmButton = container;
    this.stepUI?.add(container);
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
    if (cosEntry.tint) {
      sprite.setTint(parseInt(cosEntry.tint.replace('#', ''), 16));
    }
    this.equippedCosmeticSprites.push(sprite);
  }

  /** Render the picked cat in the middle of the canvas, ABOVE the
   *  picker cards. Per Tim's drawn-overlay feedback: preview moved up
   *  and scale reduced so it fits between Butters' feet (y≈220) and
   *  the picker cards (centerY 420 → top ≈ 361). */
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
    this.seatedCatNameLabel = this.add
      .text(this.seatedCat.x, this.seatedCat.y + 8, name.toUpperCase(), {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#ffffff',
        stroke: '#1a0a2e',
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
    this.stepUI?.add(drawerBg);

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
    this.stepUI?.add([header, closeIcon]);

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
      this.stepUI?.add([cellBg, iconText, labelText, descText]);
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
    this.stepUI?.add(footer);

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
    this.stepUI?.add([iconBg, iconLabel]);
  }

  /** Transition the orchestrator's live preview from the merch layout
   *  (one big cat lower-center) to the "ready to rehearse" stage — a
   *  Decorate-style row of 3 seats with the player's cat in the
   *  middle and the outer 2 empty per Tim's brief: "set the stage how
   *  it would normally be with the bg and cats in their usual position
   *  placed in the center for now and other 2 lanes empty." Tears down
   *  the drawer mock + Butters overlay so play-tutorial-intro renders
   *  on top of the staged scene. */
  private switchToRehearsalStage(): void {
    if (!this.seatedCat) return;
    // Decorate-style center-seat position. Cat sits roughly where the
    // real game seats the middle cat (~y=210 design-px-bottom at the
    // Game scene's 1.4× seated scale).
    const stageY = 235;
    const stageScale = 1.4;
    this.seatedCat.setY(stageY);
    this.seatedCat.setScale(stageScale);
    for (const cs of this.equippedCosmeticSprites) {
      cs.setPosition(this.seatedCat.x, stageY);
      cs.setScale(stageScale);
    }
    // Effect: tear down + leave to re-apply (the player's effect rides
    // on the cat instance; the actual rehearsal scene re-renders).
    this.activeEffectHandle?.destroy();
    this.activeEffectHandle = undefined;
    this.renderSeatedCatNameLabel();
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
    this.seatedCat.setY(merchY);
    this.seatedCat.setScale(merchScale);
    // Stacked cosmetic sprites ride the same anchor.
    for (const cs of this.equippedCosmeticSprites) {
      cs.setPosition(this.seatedCat.x, merchY);
      cs.setScale(merchScale);
    }
    // Active effect is a particle emitter tied to the prior cat
    // position — tear it down so it doesn't continue spawning at the
    // old anchor. Re-applies on the next box-effect pull.
    this.activeEffectHandle?.destroy();
    this.activeEffectHandle = undefined;
    this.renderSeatedCatNameLabel();
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
