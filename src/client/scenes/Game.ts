import { Scene, Scenes, GameObjects, Sound, Time } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { AssetKeys } from '@/constants/assets';
import { Balance } from '@/constants/balance';
import { Cat } from '@/entities/cat';
import { ScoreSystem } from '@/systems/score-system';
import { MeowBarSystem } from '@/systems/meow-bar-system';
import { RhythmSystem } from '@/systems/rhythm-system';
import { InteractionSystem } from '@/systems/interaction-system';
import { CatSelectionSystem } from '@/systems/cat-selection-system';
import { syncCoins } from '@/services/state-client';
import type { CatAnimationState, CatBreed, CatModel, InteractionType } from '@/types/game';
import type { PlayerState } from '@/../shared/state';

// Seat coordinates (fractions of canvas width/height). Cats are anchored at
// origin (0.5, 1) so the y value is where the cat's feet touch the surface.
// Order: [0] left ledge, [1] roof, [2] right ledge.
//
// Tip: set DEBUG_LOG_SEAT_CLICKS below to true, then shift+click anywhere
// in the running game and the console prints the exact { x, y } at that
// point — copy/paste it here to dial in seats by eye.
const CAT_SEAT_POSITIONS: { x: number; y: number }[] = [
  { x: 0.134, y: 0.305 }, // left ledge
  { x: 0.445, y: 0.243 }, // roof
  { x: 0.756, y: 0.4 },   // right ledge
];

const DEBUG_LOG_SEAT_CLICKS = true;

// Fallback breeds used only if the player has no owned cats yet (shouldn't
// normally happen since Welcome guarantees at least one cat). Kept as a
// safety net so the scene never renders an empty house.
const FALLBACK_BREEDS: CatBreed[] = ['cat1', 'cat2', 'cat3'];

const RESTING_ANIMATION_POOL: CatAnimationState[] = [
  'idle',
  'lick',
  'sleep',
  'stretch',
];

const INTERACTION_BUTTON_DEFS: { type: InteractionType; label: string }[] = [
  { type: 'pet', label: 'Pet' },
  { type: 'chinScratch', label: 'Chin Scratch' },
  { type: 'bellyRub', label: 'Belly Rub' },
];

// Lane layout
const LANE_COUNT = 3;
// Lane centers are spaced by exactly the bar height so the rhythm bar
// backgrounds touch and no game background shows between them.
const PSPSPS_BAR_HEIGHT = 56;
const LANE_SPACING = PSPSPS_BAR_HEIGHT;
// Bottom lane sits flush near the bottom of the screen so the stack of
// three bars anchors the bottom of the playfield.
const BOTTOM_LANE_Y_FROM_BOTTOM = 28;
// Bars span the full width of the canvas so pspsps elements can travel
// from screen edge to screen edge.
const PSPSPS_BAR_WIDTH_FRACTION = 1.0;
const PSPSPS_TARGET_DISPLAY_SIZE = 52;
const PSPSPS_ELEMENT_DISPLAY_WIDTH = 48;
const PSPSPS_ELEMENT_DISPLAY_HEIGHT = 44;
// Tap-zone vertical half-height around each lane center. Slightly bigger
// than LANE_SPACING / 2 so a tap that lands right between two lanes still
// resolves on the closer one without dead-zoning the gap.
const LANE_TAP_TOLERANCE = LANE_SPACING / 2 + 4;

// Per-lane color palette. Index 0 = bottom lane, last index = top lane.
// Three tints per lane:
//   - bar: the soft pastel background tint of the rhythm bar
//   - element: the body color of the floating pspsps balls (the letters
//     stay white because they're a separate sprite layer)
//   - target: the fuzzball catcher on the right — paler than the elements
//     so it reads as a "brighter" sibling of the same color
// 0xffffff means "no tint" (multiplies the texture by white = unchanged).
interface LaneColor {
  bar: number;
  element: number;
  target: number;
}

const LANE_COLORS: LaneColor[] = [
  // bottom — yellow
  { bar: 0xfff3b0, element: 0xffd84a, target: 0xfff5d0 },
  // middle — original (natural orange)
  { bar: 0xffffff, element: 0xffffff, target: 0xfff5d8 },
  // top — pink
  { bar: 0xffb0c8, element: 0xff6b9d, target: 0xffd6e2 },
];

// When the meow bar fills, the petting handoff takes over: one cat
// tweens to center, three buttons (Pet / Chin Scratch / Belly Rub)
// appear, the player picks one and either wins coins or gets hissed at.
const INTERACTION_ENABLED = true;

interface PspspsLane {
  index: number;
  system: RhythmSystem;
  barBg: GameObjects.Image;
  target: GameObjects.Image;
  targetBaseScale: number;
  // Each floating element is a Container holding a tinted ball + a white-letters
  // overlay so we can recolor the body without touching the "PS" text.
  elementSprites: Map<string, GameObjects.Container>;
  centerY: number;
  color: LaneColor;
}

export class Game extends Scene {
  private playerState: PlayerState | null = null;

  private cats: Cat[] = [];
  private score!: ScoreSystem;
  private meow!: MeowBarSystem;
  private interaction!: InteractionSystem;
  private selector!: CatSelectionSystem;

  private lanes: PspspsLane[] = [];
  private spawnTimer: Time.TimerEvent | null = null;

  // Meow bar
  private meowBarOutline!: GameObjects.Image;
  private meowBarFill!: GameObjects.Image;
  private meowBarBounds = { left: 0, top: 0, width: 0, height: 0, radius: 0 };

  // Interaction state
  private interactionActive = false;
  private activeCat: Cat | null = null;
  private interactionButtons: GameObjects.Container | null = null;
  private interactionDim: GameObjects.Rectangle | null = null;
  // Timing-bar mini-game state — only meaningful while interactionActive.
  private interactionTimeLeftMs = 0;
  private interactionMarkerFraction = 0; // 0..1
  private interactionMarkerDirection: 1 | -1 = 1;
  // Layout cached so update() and event handlers can reference it.
  private interactionBarLeft = 0;
  private interactionBarWidth = 0;
  private interactionBarCenterY = 0;
  private interactionBarHeight = 28;
  // Which action button is currently being held — only when this is set does
  // the marker animate and the bar render. Released = resolve at marker pos.
  private interactionHeldType: InteractionType | null = null;
  private interactionPointerUpHandler: (() => void) | null = null;
  private interactionMarker: GameObjects.Rectangle | null = null;
  private interactionTimerText: GameObjects.Text | null = null;
  private interactionBarGfx: GameObjects.Graphics | null = null;

  // HUD
  private coins = 0;
  private hudScoreText!: GameObjects.Text;
  private hudCoinsText!: GameObjects.Text;
  private hudBestText!: GameObjects.Text;
  private hudComboText!: GameObjects.Text;

  // Combo streak — consecutive successful taps. Resets to 0 on a tap that
  // earns no points. Drives the score multiplier (see Balance.comboTiers).
  private combo = 0;

  // Best-score persistence (localStorage). When the current run exceeds
  // it, the HUD flashes a NEW BEST! banner once per session.
  private bestScore = 0;
  private bestBeatenThisSession = false;

  // Particle texture key — generated programmatically in create() so we
  // don't need a real asset file. Used by the per-lane hit emitters.
  private static readonly PARTICLE_TEXTURE = 'particle-dot';

  // Music + sfx
  private music: Sound.BaseSound | null = null;
  private pspspsSfx: Sound.BaseSound | null = null;
  private musicStarted = false;

  constructor() {
    super(SceneKeys.Game);
  }

  init(data: { playerState?: PlayerState | null }): void {
    // Resume from a paused Game (returning from Boxes/Collection) doesn't
    // re-fire init — only fresh starts do. So only set playerState here if
    // we actually got one; otherwise keep whatever the prior session had.
    if (data?.playerState !== undefined) {
      this.playerState = data.playerState;
    }
  }

  create() {
    // Background fills the canvas
    const bg = this.add.image(0, 0, AssetKeys.Image.GameBackground).setOrigin(0, 0);
    bg.displayWidth = this.scale.width;
    bg.displayHeight = this.scale.height;

    // Programmatically build a tiny round white texture for hit particles.
    // setTint() will color it per-lane at emit time so no asset is needed.
    if (!this.textures.exists(Game.PARTICLE_TEXTURE)) {
      const pgfx = this.add.graphics();
      pgfx.fillStyle(0xffffff, 1);
      pgfx.fillCircle(4, 4, 4);
      pgfx.generateTexture(Game.PARTICLE_TEXTURE, 8, 8);
      pgfx.destroy();
    }

    // Best score: prefer the server's value (synced across devices). Fall
    // back to the legacy localStorage value if we somehow ended up here
    // without a state, then upgrade to the server's value as soon as we
    // sync. Coin count is server-authoritative — start from state.
    this.bestScore = this.playerState?.bestScore ?? this.loadBestScore();
    this.coins = this.playerState?.coins ?? 0;

    // Systems
    this.score = new ScoreSystem();
    this.meow = new MeowBarSystem();
    this.interaction = new InteractionSystem();
    this.selector = new CatSelectionSystem();

    // Pre-create the pspsps sfx instance so we can replay it fast on every hit
    this.pspspsSfx = this.sound.add(AssetKeys.Audio.Pspsps, { volume: 0.7 });

    // TEMP — only seat one cat on the right ledge for now. The HUD banner
    // sits at the top-left and was overlapping the left-ledge cat; we'll
    // resize / move the banner later and reintroduce the other seats.
    const shuffledRest = [...RESTING_ANIMATION_POOL].sort(() => Math.random() - 0.5);
    const seatedBreeds = this.pickSeatedBreeds();
    const breed = seatedBreeds[0];
    if (breed) {
      const seatIndex = 2; // right ledge
      const seat = CAT_SEAT_POSITIONS[seatIndex]!;
      const resting = shuffledRest[0]!;
      const equipped = this.playerState?.equippedCosmetics[breed];
      const model: CatModel = {
        id: 'seat-0',
        breed,
        animation: resting,
        restingAnimation: resting,
        x: seat.x * 100,
        y: seat.y * 100,
        ...(equipped !== undefined ? { equippedCosmetic: equipped } : {}),
      };
      const cat = new Cat(this, model);
      cat.setPosition(seat.x * this.scale.width, seat.y * this.scale.height);
      this.cats.push(cat);
    }

    this.createLanes();
    this.createMeowBar();
    this.createHud();
    this.createNavButtons();
    this.setupInput();

    // One spawn check tick fans out to all lanes.
    this.spawnTimer = this.time.addEvent({
      delay: Balance.tickDurationMs,
      loop: true,
      callback: () => {
        for (const lane of this.lanes) lane.system.spawnTick();
      },
    });

    this.events.once(Scenes.Events.SHUTDOWN, () => this.cleanup());
  }

  override update(_time: number, delta: number): void {
    if (this.interactionActive) {
      // Petting mini-game runs here — rhythm system is fully paused so the
      // combo doesn't break behind the dim overlay.
      this.advancePettingInteraction(delta);
    } else {
      const meowPct = this.meow.getProgress() / Balance.meowBarMax;
      const speedMult =
        1 + meowPct * (Balance.pspspsSpeedMultiplierAtFullMeow - 1);
      let missedThisFrame = 0;
      for (const lane of this.lanes) {
        lane.system.setSpeedMultiplier(speedMult);
        missedThisFrame += lane.system.advance(delta);
        this.syncLaneElements(lane);
      }
      if (missedThisFrame > 0 && this.combo > 0) {
        this.combo = 0;
      }
    }
    this.updateMeowBar();
    this.updateHud();
  }

  private advancePettingInteraction(deltaMs: number): void {
    // The round timer always counts down — the 15-second budget is yours
    // to spend however you want, holding or not.
    this.interactionTimeLeftMs -= deltaMs;
    if (this.interactionTimeLeftMs <= 0) {
      this.interactionTimeLeftMs = 0;
      this.updatePettingTimerLabel();
      this.endInteraction();
      return;
    }

    // Marker only moves while a button is being held — the bar is hidden
    // and the marker frozen any other time.
    if (this.interactionHeldType !== null) {
      const speed = 1 / Balance.interactionMarkerTraversalMs;
      this.interactionMarkerFraction +=
        this.interactionMarkerDirection * speed * deltaMs;
      if (this.interactionMarkerFraction >= 1) {
        this.interactionMarkerFraction = 1;
        this.interactionMarkerDirection = -1;
      } else if (this.interactionMarkerFraction <= 0) {
        this.interactionMarkerFraction = 0;
        this.interactionMarkerDirection = 1;
      }
      if (this.interactionMarker) {
        this.interactionMarker.x =
          this.interactionBarLeft +
          this.interactionBarWidth * this.interactionMarkerFraction;
      }
    }
    this.updatePettingTimerLabel();
  }

  private updatePettingTimerLabel(): void {
    if (!this.interactionTimerText) return;
    const seconds = Math.max(0, this.interactionTimeLeftMs) / 1000;
    this.interactionTimerText.setText(`${seconds.toFixed(1)}s`);
  }

  private getComboMultiplier(): number {
    for (const tier of Balance.comboTiers) {
      if (this.combo >= tier.atLeast) return tier.multiplier;
    }
    return 1;
  }

  // -- Lanes --------------------------------------------------------------

  private createLanes(): void {
    const w = this.scale.width;
    const h = this.scale.height;
    const barWidth = w * PSPSPS_BAR_WIDTH_FRACTION;
    const barX = w / 2;
    const barLeft = barX - barWidth / 2;

    for (let i = 0; i < LANE_COUNT; i++) {
      // i = 0 -> bottom lane, larger i -> higher up
      const centerY = h - BOTTOM_LANE_Y_FROM_BOTTOM - i * LANE_SPACING;
      const color = LANE_COLORS[i] ?? { bar: 0xffffff, element: 0xffffff, target: 0xffffff };
      const system = new RhythmSystem();

      const barBg = this.add.image(barX, centerY, AssetKeys.Image.RhythmBarBackground);
      barBg.displayWidth = barWidth;
      barBg.displayHeight = PSPSPS_BAR_HEIGHT;
      barBg.setTint(color.bar);

      // Position the target using the same "stay-inside-the-bar" mapping
      // that the moving elements use (see syncLaneElements). At fraction
      // 0 the sprite's left edge sits at the bar's left edge; at fraction
      // 1 its right edge sits at the bar's right edge. That keeps the
      // visible target aligned with the element it's catching.
      const tgtHalfW = PSPSPS_TARGET_DISPLAY_SIZE / 2;
      const tgtTravelRange = barWidth - PSPSPS_TARGET_DISPLAY_SIZE;
      const targetX =
        barLeft + tgtHalfW + system.getTargetFraction() * tgtTravelRange;
      const target = this.add.image(targetX, centerY, AssetKeys.Image.PspspsTarget);
      target.setDisplaySize(PSPSPS_TARGET_DISPLAY_SIZE, PSPSPS_TARGET_DISPLAY_SIZE);
      target.setTint(color.target);
      const targetBaseScale = target.scaleX;

      this.lanes.push({
        index: i,
        system,
        barBg,
        target,
        targetBaseScale,
        elementSprites: new Map(),
        centerY,
        color,
      });
    }
  }

  private syncLaneElements(lane: PspspsLane): void {
    const w = this.scale.width;
    const barWidth = w * PSPSPS_BAR_WIDTH_FRACTION;
    const barLeft = w / 2 - barWidth / 2;

    // "Stay-inside-the-bar" mapping: fraction 0 puts the sprite's left edge
    // at the bar's left edge, fraction 1 puts its right edge at the bar's
    // right edge. The sprite never overhangs either side.
    const elHalfW = PSPSPS_ELEMENT_DISPLAY_WIDTH / 2;
    const elTravelRange = barWidth - PSPSPS_ELEMENT_DISPLAY_WIDTH;

    const elements = lane.system.getElements();
    const aliveIds = new Set(elements.map((e) => e.id));

    // Drop sprites whose elements no longer exist
    for (const [id, sprite] of lane.elementSprites) {
      if (!aliveIds.has(id)) {
        sprite.destroy();
        lane.elementSprites.delete(id);
      }
    }

    // Add or move sprites to match elements
    for (const el of elements) {
      let sprite = lane.elementSprites.get(el.id);
      if (!sprite) {
        const ball = this.add.image(0, 0, AssetKeys.Image.PspspsElementBall);
        ball.setDisplaySize(PSPSPS_ELEMENT_DISPLAY_WIDTH, PSPSPS_ELEMENT_DISPLAY_HEIGHT);
        ball.setTint(lane.color.element);

        const letters = this.add.image(0, 0, AssetKeys.Image.PspspsElementLetters);
        letters.setDisplaySize(PSPSPS_ELEMENT_DISPLAY_WIDTH, PSPSPS_ELEMENT_DISPLAY_HEIGHT);
        // Letters stay white — no tint applied so the PS reads cleanly over
        // whatever color the ball ends up.

        sprite = this.add.container(0, lane.centerY, [ball, letters]);
        lane.elementSprites.set(el.id, sprite);
      }
      sprite.x = barLeft + elHalfW + el.fraction * elTravelRange;
      sprite.y = lane.centerY;
    }
  }

  private pulseLaneTarget(lane: PspspsLane): void {
    this.tweens.killTweensOf(lane.target);
    lane.target.setScale(lane.targetBaseScale);
    this.tweens.add({
      targets: lane.target,
      scale: lane.targetBaseScale * 1.35,
      duration: 120,
      yoyo: true,
      ease: 'Quad.easeOut',
    });
  }

  // -- Meow bar -----------------------------------------------------------

  private createMeowBar(): void {
    const w = this.scale.width;
    const h = this.scale.height;
    const barWidth = w * 0.6;
    const barDisplayHeight = 48; // chunkier so the interior is comfortable
    // Sit above the top-most rhythm lane with a comfortable gap so the
    // meow bar doesn't kiss the top of the rhythm lane stack.
    const topLaneY = h - BOTTOM_LANE_Y_FROM_BOTTOM - (LANE_COUNT - 1) * LANE_SPACING;
    const barY = topLaneY - 60;

    // The interior of the outline image (where it's transparent inside the
    // border) measured in pixels: bbox of black pixels is x 6–145, y 8–21 in
    // a 148×30 image, so the interior is x 8–143, y 10–19. As fractions of
    // the image: ~5.4% inset on the left, ~2.7% on the right, ~33.3% on the
    // top, ~33.3% on the bottom. We size the track + fill to that interior
    // so neither bleeds past the black border at any scale.
    const interiorLeftFrac = 8 / 148;
    const interiorRightFrac = 4 / 148;
    const interiorTopFrac = 10 / 30;
    const interiorBottomFrac = 10 / 30;

    const interiorWidth = barWidth * (1 - interiorLeftFrac - interiorRightFrac);
    const interiorHeight =
      barDisplayHeight * (1 - interiorTopFrac - interiorBottomFrac);
    const interiorLeft =
      w / 2 - barWidth / 2 + barWidth * interiorLeftFrac;
    const interiorTop =
      barY - barDisplayHeight / 2 + barDisplayHeight * interiorTopFrac;

    this.meowBarBounds = {
      left: interiorLeft,
      top: interiorTop,
      width: interiorWidth,
      height: interiorHeight,
      radius: interiorHeight / 2,
    };

    // Two layers stacked under the outline frame:
    //   1) White track — drawn once across the full interior. Visible in
    //      the empty portion of the bar.
    //   2) Cat-tail fill asset — displayWidth grows with progress so the
    //      tail extends across the bar from the left as the meter fills.
    //      The asset is now trimmed to its content rows (148×10 instead of
    //      148×30) so it fills the bar's vertical interior with no
    //      transparent gaps above or below the tail pixels.
    const track = this.add.graphics();
    track.fillStyle(0xffffff, 0.95);
    track.fillRoundedRect(
      this.meowBarBounds.left,
      this.meowBarBounds.top,
      this.meowBarBounds.width,
      this.meowBarBounds.height,
      this.meowBarBounds.radius,
    );

    this.meowBarFill = this.add.image(
      this.meowBarBounds.left,
      this.meowBarBounds.top + this.meowBarBounds.height / 2,
      AssetKeys.Image.MeowBarFill,
    );
    this.meowBarFill.setOrigin(0, 0.5);
    this.meowBarFill.displayWidth = 0;
    this.meowBarFill.displayHeight = this.meowBarBounds.height;

    // Outline (rounded frame) drawn last so it crisps up the bar edges.
    this.meowBarOutline = this.add.image(w / 2, barY, AssetKeys.Image.MeowBarOutline);
    this.meowBarOutline.displayWidth = barWidth;
    this.meowBarOutline.displayHeight = barDisplayHeight;
  }

  private updateMeowBar(): void {
    if (!this.meowBarFill) return;
    const pct = this.meow.getProgress() / Balance.meowBarMax;
    this.meowBarFill.displayWidth = pct * this.meowBarBounds.width;
  }

  // -- HUD ----------------------------------------------------------------

  private createHud(): void {
    // Chunky rounded-pill banner in the top-left so the score reads as a
    // real UI element instead of floating text in the corner. Dark purple
    // with a soft white border, sized to comfortably hold score / best /
    // coins stacked vertically.
    const bannerX = 12;
    const bannerY = 12;
    const bannerW = 168;
    const bannerH = 80;
    const bannerR = 14;

    const banner = this.add.graphics();
    banner.fillStyle(0x261540, 0.85);
    banner.fillRoundedRect(bannerX, bannerY, bannerW, bannerH, bannerR);
    banner.lineStyle(2, 0xffffff, 0.35);
    banner.strokeRoundedRect(bannerX, bannerY, bannerW, bannerH, bannerR);

    this.hudScoreText = this.add.text(bannerX + 12, bannerY + 6, 'Score 0', {
      fontFamily: 'Pixeloid Sans, sans-serif',
      fontStyle: 'bold',
      fontSize: '20px',
      color: '#ffffff',
    });
    this.hudScoreText.setOrigin(0, 0);

    this.hudBestText = this.add.text(bannerX + 12, bannerY + 34, `Best ${this.bestScore.toLocaleString()}`, {
      fontFamily: 'Pixeloid Sans, sans-serif',
      fontSize: '12px',
      color: '#c0a0e6',
    });
    this.hudCoinsText = this.add.text(bannerX + 12, bannerY + 54, '🪙 0', {
      fontFamily: 'Pixeloid Sans, sans-serif',
      fontSize: '16px',
      color: '#ffd34d',
    });

    // Combo sits below the score banner as plain bold text — no pill
    // background — so it reads as a status indicator without competing
    // visually with the banner.
    this.hudComboText = this.add
      .text(bannerX + bannerW / 2, bannerY + bannerH + 8, '', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '20px',
        color: '#ff8fbf',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5, 0)
      .setVisible(false);
  }

  private updateHud(): void {
    this.hudScoreText?.setText(`Score ${this.score.get().toLocaleString()}`);
    this.hudBestText?.setText(`Best ${this.bestScore.toLocaleString()}`);
    this.hudCoinsText?.setText(`🪙 ${this.coins}`);
    const multiplier = this.getComboMultiplier();
    if (multiplier > 1) {
      this.hudComboText.setText(`${multiplier}× COMBO  (${this.combo})`);
      this.hudComboText.setVisible(true);
    } else {
      this.hudComboText.setVisible(false);
    }
  }

  // -- Juice + celebrations -----------------------------------------------

  private pulseScoreText(): void {
    if (!this.hudScoreText) return;
    this.tweens.killTweensOf(this.hudScoreText);
    this.hudScoreText.setScale(1);
    this.tweens.add({
      targets: this.hudScoreText,
      scale: 1.18,
      duration: 90,
      yoyo: true,
      ease: 'Quad.easeOut',
    });
  }

  private emitHitParticles(
    x: number,
    y: number,
    color: number,
    quantity: number,
  ): void {
    const emitter = this.add.particles(x, y, Game.PARTICLE_TEXTURE, {
      speed: { min: 90, max: 240 },
      angle: { min: 0, max: 360 },
      scale: { start: 1.4, end: 0 },
      alpha: { start: 1, end: 0 },
      lifespan: { min: 280, max: 600 },
      tint: color,
      quantity,
      emitting: false,
    });
    emitter.setDepth(900);
    emitter.explode(quantity);
    // Particles finish their lifespan on their own; tear down the emitter
    // after the longest possible lifetime so we don't leak.
    this.time.delayedCall(800, () => emitter.destroy());
  }

  private maybeCelebrateComboMilestone(
    previousCombo: number,
    nextCombo: number,
    lane: PspspsLane,
  ): void {
    // Trigger when crossing the at-least threshold of any tier going up.
    for (const tier of Balance.comboTiers) {
      if (previousCombo < tier.atLeast && nextCombo >= tier.atLeast) {
        this.showComboMilestone(tier.multiplier, lane);
        return;
      }
    }
  }

  private showComboMilestone(multiplier: number, lane: PspspsLane): void {
    const text = this.add
      .text(this.scale.width / 2, this.scale.height * 0.42, `${multiplier}× COMBO!`, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '42px',
        color: '#ff6b9d',
        stroke: '#000000',
        strokeThickness: 6,
      })
      .setOrigin(0.5)
      .setScale(0.3)
      .setDepth(2000);

    this.tweens.add({
      targets: text,
      scale: 1.1,
      duration: 200,
      ease: 'Back.easeOut',
      onComplete: () => {
        this.tweens.add({
          targets: text,
          alpha: 0,
          duration: 500,
          delay: 300,
          ease: 'Cubic.easeIn',
          onComplete: () => text.destroy(),
        });
      },
    });

    this.cameras.main.shake(180, 0.005);
    this.emitHitParticles(lane.target.x, lane.target.y, lane.color.element, 24);
  }

  private maybeFlashNewBest(): void {
    if (this.bestBeatenThisSession) return;
    if (this.score.get() <= this.bestScore) return;
    this.bestBeatenThisSession = true;
    this.showNewBestBanner();
  }

  private showNewBestBanner(): void {
    const text = this.add
      .text(this.scale.width / 2, this.scale.height * 0.36, 'NEW BEST!', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '56px',
        color: '#ffd34d',
        stroke: '#000000',
        strokeThickness: 8,
      })
      .setOrigin(0.5)
      .setScale(0.3)
      .setDepth(2000);

    this.tweens.add({
      targets: text,
      scale: 1.05,
      duration: 240,
      ease: 'Back.easeOut',
      onComplete: () => {
        this.tweens.add({
          targets: text,
          alpha: 0,
          y: text.y - 50,
          duration: 700,
          delay: 850,
          onComplete: () => text.destroy(),
        });
      },
    });
  }

  private pickSeatedBreeds(): CatBreed[] {
    const owned = this.playerState?.ownedCats ?? [];
    const seatCount = Math.min(Balance.baseCatsOnScreen, CAT_SEAT_POSITIONS.length);
    if (owned.length === 0) {
      return FALLBACK_BREEDS.slice(0, seatCount);
    }
    if (owned.length <= seatCount) return [...owned];
    const shuffled = [...owned].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, seatCount);
  }

  private createNavButtons(): void {
    // Two pill buttons stacked just under the score banner. Tapping pauses
    // the current run and launches the target scene on top — closing it
    // resumes Game exactly where it left off (combo, meow meter, lanes
    // all preserved). The state.coins we earned before navigating is
    // synced before we leave so the server has an up-to-date picture.
    const buttons: { label: string; sceneKey: string; accent: number }[] = [
      { label: 'BOXES', sceneKey: SceneKeys.Boxes, accent: 0xffd34d },
      { label: 'COLLECTION', sceneKey: SceneKeys.Collection, accent: 0xc678ff },
    ];

    const startY = 110; // below the existing HUD banner
    const x = 96;
    buttons.forEach((cfg, idx) => {
      const y = startY + idx * 38;
      const bg = this.add.rectangle(x, y, 144, 32, 0x261540, 0.92);
      bg.setStrokeStyle(2, cfg.accent);
      bg.setInteractive({ useHandCursor: true });
      this.add
        .text(x, y, cfg.label, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '14px',
          color: '#ffffff',
        })
        .setOrigin(0.5);
      bg.on('pointerdown', () => {
        if (this.interactionActive) return;
        void this.navigateTo(cfg.sceneKey);
      });
    });
  }

  private async navigateTo(sceneKey: string): Promise<void> {
    // Sync earned coins first so the destination scene's HUD reflects
    // the right balance. TEMP — using scene.start instead of
    // launch+pause; the resume hand-off wasn't reliably re-applying
    // equipped cosmetics. Cost: the in-progress run (combo / meow meter)
    // resets when shopping. Re-introduce pause/resume once we sort out
    // why RESUME's data payload wasn't landing in the listener.
    const handoffState = await this.syncCoinsToServer();
    this.scene.start(sceneKey, { playerState: handoffState });
  }

  private async syncCoinsToServer(): Promise<PlayerState | null> {
    const baselineCoins = this.playerState?.coins ?? 0;
    const delta = this.coins - baselineCoins;
    try {
      const updated = await syncCoins(delta, this.bestScore);
      this.playerState = updated;
      this.coins = updated.coins;
      return updated;
    } catch (e) {
      console.warn('[game] syncCoins failed', e);
      return this.playerState;
    }
  }

  private loadBestScore(): number {
    try {
      const stored = window.localStorage.getItem('pspsps:bestScore');
      const parsed = stored ? parseInt(stored, 10) : 0;
      return Number.isFinite(parsed) ? parsed : 0;
    } catch {
      return 0;
    }
  }

  private saveBestScore(score: number): void {
    try {
      window.localStorage.setItem('pspsps:bestScore', score.toString());
    } catch {
      // localStorage may be unavailable in some sandboxes — non-fatal.
    }
  }

  // -- Input + scoring ----------------------------------------------------

  private setupInput(): void {
    // Track shift via Phaser's keyboard system rather than the pointer
    // event's modifier — more reliable across iframes / browsers.
    const shiftKey = this.input.keyboard?.addKey('SHIFT');

    this.input.on(
      'pointerdown',
      (pointer: { x: number; y: number }) => {
        const shiftHeld = shiftKey?.isDown ?? false;

        if (DEBUG_LOG_SEAT_CLICKS) {
          // Always log a pointerdown so we can diagnose what's reaching
          // the handler. If shift is held, also drop a red dot at the
          // detected click position to verify the canvas pointer mapping.
          const x = Number((pointer.x / this.scale.width).toFixed(3));
          const y = Number((pointer.y / this.scale.height).toFixed(3));
          const tag = shiftHeld ? '[seat]' : '[click]';
          console.log(
            `${tag} { x: ${x}, y: ${y} },  // canvas=${Math.round(this.scale.width)}x${Math.round(this.scale.height)} pointer=${Math.round(pointer.x)},${Math.round(pointer.y)} shift=${shiftHeld}`,
          );

          if (shiftHeld) {
            const dot = this.add.circle(pointer.x, pointer.y, 10, 0xff3366, 1);
            dot.setStrokeStyle(2, 0xffffff);
            dot.setDepth(1000); // stay on top of everything
            this.tweens.add({
              targets: dot,
              alpha: 0,
              duration: 4000,
              onComplete: () => dot.destroy(),
            });
            return;
          }
        }

        this.startMusicOnFirstGesture();
        const lane = this.findLaneAtY(pointer.y);
        if (lane) this.onLaneTap(lane);
      },
    );

    // Keyboard helpers for desktop dev: 1 = top lane, 2 = middle, 3 = bottom
    // (visual top-down reading order, regardless of the array index).
    const keyToLane: Record<string, number> = {
      ONE: LANE_COUNT - 1,
      TWO: LANE_COUNT - 2,
      THREE: LANE_COUNT - 3,
    };
    for (const [key, index] of Object.entries(keyToLane)) {
      if (index < 0) continue;
      this.input.keyboard?.on(`keydown-${key}`, () => {
        this.startMusicOnFirstGesture();
        const lane = this.lanes[index];
        if (lane) this.onLaneTap(lane);
      });
    }
  }

  private findLaneAtY(y: number): PspspsLane | null {
    let closest: PspspsLane | null = null;
    let minDist = Infinity;
    for (const lane of this.lanes) {
      const dist = Math.abs(y - lane.centerY);
      if (dist < minDist) {
        minDist = dist;
        closest = lane;
      }
    }
    return minDist <= LANE_TAP_TOLERANCE ? closest : null;
  }

  private onLaneTap(lane: PspspsLane): void {
    if (this.interactionActive) return;

    const result = lane.system.tap();
    if (result.pointsAwarded > 0) {
      const previousCombo = this.combo;
      this.combo += 1;
      const multiplier = this.getComboMultiplier();
      const totalPoints = result.pointsAwarded * multiplier;
      this.score.add(totalPoints);
      this.meow.onScoreChanged(this.score.get());

      // Audio + visual juice for the hit itself.
      this.pspspsSfx?.play();
      this.pulseLaneTarget(lane);
      this.pulseScoreText();
      this.flashScore(lane, totalPoints, result.perfectHits > 0, multiplier);

      // Tier the shake + particles so PERFECTs and combos feel chunkier.
      const isPerfect = result.perfectHits > 0;
      const shakeDuration = isPerfect ? 90 : 50;
      const shakeIntensity = isPerfect ? 0.0028 : 0.0014;
      this.cameras.main.shake(shakeDuration, shakeIntensity);
      const particleCount = isPerfect ? 18 : 10;
      this.emitHitParticles(
        lane.target.x,
        lane.target.y,
        lane.color.element,
        particleCount,
      );

      // Bigger celebrations on crossing 5×/15×/30× thresholds.
      this.maybeCelebrateComboMilestone(previousCombo, this.combo, lane);

      // High-score watch: flash NEW BEST! once and persist whenever the
      // running score crosses the stored best.
      this.maybeFlashNewBest();
      if (this.score.get() > this.bestScore) {
        this.bestScore = this.score.get();
        this.saveBestScore(this.bestScore);
      }
    } else {
      // Missed tap (clicked a lane with nothing on the target) — break the
      // streak so the multiplier can't be banked risk-free.
      this.combo = 0;
    }

    if (this.meow.isFull() && INTERACTION_ENABLED) {
      this.beginInteraction();
    }
    // When the interaction handoff is disabled we just let the bar sit at
    // 100% until we flip the flag back on — no more cycling.
  }

  private flashScore(
    lane: PspspsLane,
    points: number,
    isPerfect: boolean,
    multiplier: number,
  ): void {
    const comboPrefix = multiplier > 1 ? `${multiplier}x ` : '';
    const baseLabel = isPerfect ? 'PERFECT' : '';
    const label = `${comboPrefix}${baseLabel ? baseLabel + ' ' : ''}+${points}`;
    // Perfect always reads green so the bonus is unmistakable; partial hits
    // tint to match the lane that scored (using the saturated element color
    // so it's clearly visible).
    const laneHex = `#${lane.color.element.toString(16).padStart(6, '0')}`;
    const color = isPerfect ? '#00ff88' : laneHex;
    // Bold for PERFECT or any combo (>1x) — those moments deserve to pop.
    const useBold = isPerfect || multiplier > 1;
    // Spawn at the horizontal center of the lane (which equals the screen
    // center since lanes span the full width). Always readable, never
    // clipped by the right edge — and the lane's centerY keeps it linked
    // to whichever lane actually scored.
    const text = this.add
      .text(this.scale.width / 2, lane.centerY - 40, label, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: useBold ? 'bold' : 'normal',
        fontSize: '24px',
        color,
        stroke: '#000000',
        strokeThickness: 4,
      })
      .setOrigin(0.5);
    this.tweens.add({
      targets: text,
      alpha: 0,
      y: text.y - 30,
      duration: 600,
      onComplete: () => text.destroy(),
    });
  }

  // -- Petting interaction ------------------------------------------------

  private beginInteraction(): void {
    if (this.interactionActive) return;
    this.interactionActive = true;

    const chosenModel = this.selector.pickActive(this.cats.map((c) => c.model));
    this.activeCat = this.cats.find((c) => c.model.id === chosenModel.id) ?? null;
    if (!this.activeCat) return;

    const w = this.scale.width;
    const h = this.scale.height;
    // Dim ONLY the rhythm-lane region so the cat above stays visible and
    // the interaction UI can sit on top of the dimmed lanes below.
    const lanesTop = h - BOTTOM_LANE_Y_FROM_BOTTOM - LANE_COUNT * LANE_SPACING - PSPSPS_BAR_HEIGHT / 2;
    // Interaction UI lives in the dimmed-lane area:
    //   - countdown text at the top of the dim region
    //   - timing bar just below it (hidden until a button is held)
    //   - three petting buttons near the bottom of the dim region
    const buttonRowY = h - BOTTOM_LANE_Y_FROM_BOTTOM - PSPSPS_BAR_HEIGHT;
    const barCenterY = lanesTop + 60;
    const barW = Math.min(w * 0.7, 460);
    const barH = 28;
    const barLeft = w / 2 - barW / 2;

    this.interactionBarLeft = barLeft;
    this.interactionBarWidth = barW;
    this.interactionBarCenterY = barCenterY;
    this.interactionBarHeight = barH;
    this.interactionTimeLeftMs = Balance.interactionRoundDurationMs;
    this.interactionMarkerFraction = 0;
    this.interactionMarkerDirection = 1;
    this.interactionHeldType = null;

    // Dim covers exactly the rhythm-lane region — the cat house art above
    // stays untouched so the active cat reads clearly.
    this.interactionDim = this.add
      .rectangle(0, lanesTop, w, h - lanesTop, 0x000000, 0.68)
      .setOrigin(0, 0)
      .setDepth(500);

    // Active cat tweens forward but stays well above the dim region so it
    // doesn't get blocked by the buttons or bar.
    const catFeetY = lanesTop - 24;
    this.tweens.add({
      targets: this.activeCat.sprite,
      x: w / 2,
      y: catFeetY,
      scale: 1.6,
      duration: 360,
      ease: 'Quad.easeOut',
    });
    this.activeCat.sprite.setDepth(550);
    this.activeCat.setAnimation('meow');

    // Bar is always visible (red by default — the whole thing reads as
    // "miss zone" until you press an action and a green window opens up).
    // Marker only appears while a button is held.
    this.interactionBarGfx = this.add.graphics().setDepth(550);
    this.redrawTimingBar(null);
    this.interactionMarker = this.add
      .rectangle(barLeft, barCenterY, 6, barH + 16, 0xffd84a)
      .setDepth(560)
      .setStrokeStyle(2, 0x000000)
      .setVisible(false);

    this.spawnTimingBarButtons(buttonRowY);

    // Countdown text at top of dim region — always visible.
    this.interactionTimerText = this.add
      .text(w / 2, lanesTop + 14, '15.0s', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '20px',
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 4,
      })
      .setOrigin(0.5, 0)
      .setDepth(610);

    // Listen for ANY pointerup while the interaction is live — if a button
    // was being held, that's when we resolve the attempt. Doing this at the
    // scene level handles cases where the player drags off the button
    // before releasing.
    this.interactionPointerUpHandler = () => {
      if (this.interactionHeldType !== null) {
        const type = this.interactionHeldType;
        this.interactionHeldType = null;
        this.endActionHold();
        this.resolveInteraction(type);
      }
    };
    this.input.on('pointerup', this.interactionPointerUpHandler);
  }

  private redrawTimingBar(activeType: InteractionType | null): void {
    if (!this.interactionBarGfx) return;
    const gfx = this.interactionBarGfx;
    const left = this.interactionBarLeft;
    const width = this.interactionBarWidth;
    const height = this.interactionBarHeight;
    const top = this.interactionBarCenterY - height / 2;

    gfx.clear();
    // Red everywhere by default — the whole bar reads as "miss zone"
    // until the player presses an action and the green window opens up
    // sized to that specific action.
    gfx.fillStyle(0xe53935, 1);
    gfx.fillRoundedRect(left, top, width, height, 6);

    if (activeType !== null) {
      const zone = Balance.interactionZones[activeType];
      const greenW = width * zone;
      gfx.fillStyle(0x4caf50, 1);
      gfx.fillRoundedRect(left + (width - greenW) / 2, top + 2, greenW, height - 4, 4);
    }

    gfx.lineStyle(2, 0xffffff, 0.9);
    gfx.strokeRoundedRect(left, top, width, height, 6);
  }

  private startActionHold(type: InteractionType): void {
    if (!this.interactionActive || this.interactionHeldType !== null) return;
    this.interactionHeldType = type;
    this.interactionMarkerFraction = 0;
    this.interactionMarkerDirection = 1;
    this.redrawTimingBar(type);
    if (this.interactionMarker) {
      this.interactionMarker.x = this.interactionBarLeft;
      this.interactionMarker.setVisible(true);
    }
  }

  private endActionHold(): void {
    this.redrawTimingBar(null);
    this.interactionMarker?.setVisible(false);
  }

  private spawnTimingBarButtons(buttonRowY: number): void {
    const w = this.scale.width;
    const container = this.add.container(0, 0).setDepth(600);
    this.interactionButtons = container;

    const btnW = 110;
    const btnH = 52;
    const gap = 14;
    const totalW =
      INTERACTION_BUTTON_DEFS.length * btnW +
      (INTERACTION_BUTTON_DEFS.length - 1) * gap;
    const startX = w / 2 - totalW / 2 + btnW / 2;

    // Color-match each button to its zone color so players can connect
    // the action to the band on the bar.
    const buttonAccent: Record<InteractionType, number> = {
      pet: 0x4caf50,
      chinScratch: 0xffb300,
      bellyRub: 0xe53935,
    };

    for (let i = 0; i < INTERACTION_BUTTON_DEFS.length; i++) {
      const def = INTERACTION_BUTTON_DEFS[i]!;
      const x = startX + i * (btnW + gap);
      const reward = InteractionSystem.rewardFor(def.type);

      const bg = this.add.rectangle(x, buttonRowY, btnW, btnH, 0x261540, 0.92);
      bg.setStrokeStyle(3, buttonAccent[def.type]);
      bg.setInteractive({ useHandCursor: true });

      const label = this.add
        .text(x, buttonRowY - 10, def.label, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '14px',
          color: '#ffffff',
        })
        .setOrigin(0.5);

      const rewardText = this.add
        .text(x, buttonRowY + 12, `+${reward}🪙`, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontSize: '12px',
          color: '#ffd34d',
        })
        .setOrigin(0.5);

      bg.on('pointerdown', () => this.startActionHold(def.type));
      container.add([bg, label, rewardText]);
    }
  }

  private resolveInteraction(type: InteractionType): void {
    if (!this.activeCat || !this.interactionActive) return;
    const result = this.interaction.resolve(type, this.interactionMarkerFraction);

    if (result.outcome === 'success') {
      this.coins += result.coinsAwarded;
      // cat1/2/3 don't have a 'happy' frame set in the atlas (only cat5/6
      // do). Using 'lick' as the success animation since it reads as
      // affectionate and works across all breeds we ship with.
      this.activeCat.setAnimation('lick');
      // Bounce back to 'meow' after a short beat so the player can keep
      // racking up successes within the same round.
      this.time.delayedCall(500, () => {
        if (this.interactionActive && this.activeCat) {
          this.activeCat.setAnimation('meow');
        }
      });
    } else {
      this.activeCat.setAnimation('hiss');
      this.interactionTimeLeftMs -= Balance.interactionMissPenaltyMs;
      this.time.delayedCall(450, () => {
        if (this.interactionActive && this.activeCat) {
          this.activeCat.setAnimation('meow');
        }
      });
    }

    const feedback = this.add
      .text(
        this.scale.width / 2,
        this.interactionTimerText
          ? this.interactionTimerText.y + 28
          : this.scale.height / 2,
        result.outcome === 'success'
          ? `+${result.coinsAwarded}🪙`
          : `Miss! -1s`,
        {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '20px',
          color: result.outcome === 'success' ? '#00ff88' : '#ff4444',
          stroke: '#000000',
          strokeThickness: 4,
        },
      )
      .setOrigin(0.5)
      .setDepth(620);
    this.tweens.add({
      targets: feedback,
      alpha: 0,
      y: feedback.y - 36,
      duration: 700,
      onComplete: () => feedback.destroy(),
    });
  }

  private endInteraction(): void {
    if (!this.interactionActive) return;
    this.interactionActive = false;

    if (this.activeCat) {
      const cat = this.activeCat;
      const seatX = (cat.model.x / 100) * this.scale.width;
      const seatY = (cat.model.y / 100) * this.scale.height;
      this.tweens.add({
        targets: cat.sprite,
        x: seatX,
        y: seatY,
        scale: 1,
        duration: 380,
        onComplete: () => {
          // Return to whatever the cat was doing before being picked up
          // and drop back into the normal cat-house depth layer.
          cat.sprite.setDepth(0);
          cat.setAnimation(cat.model.restingAnimation);
        },
      });
      this.activeCat = null;
    }

    this.interactionButtons?.destroy(true);
    this.interactionButtons = null;
    this.interactionDim?.destroy();
    this.interactionDim = null;
    this.interactionMarker?.destroy();
    this.interactionMarker = null;
    this.interactionTimerText?.destroy();
    this.interactionTimerText = null;
    this.interactionBarGfx?.destroy();
    this.interactionBarGfx = null;
    this.interactionHeldType = null;
    if (this.interactionPointerUpHandler) {
      this.input.off('pointerup', this.interactionPointerUpHandler);
      this.interactionPointerUpHandler = null;
    }
    this.meow.reset();
  }

  // -- Music --------------------------------------------------------------

  private startMusicOnFirstGesture(): void {
    if (this.musicStarted) return;
    this.musicStarted = true;
    this.music = this.sound.add(AssetKeys.Audio.Background, { loop: true, volume: 0.4 });
    this.music.play();
  }

  // -- Cleanup ------------------------------------------------------------

  private cleanup(): void {
    this.spawnTimer?.remove();
    this.spawnTimer = null;
    this.interactionButtons?.destroy(true);
    this.interactionButtons = null;
    this.interactionDim?.destroy();
    this.interactionDim = null;
    this.interactionMarker?.destroy();
    this.interactionMarker = null;
    this.interactionTimerText?.destroy();
    this.interactionTimerText = null;
    this.interactionBarGfx?.destroy();
    this.interactionBarGfx = null;
    if (this.interactionPointerUpHandler) {
      this.input.off('pointerup', this.interactionPointerUpHandler);
      this.interactionPointerUpHandler = null;
    }
    this.music?.stop();
    this.music = null;
    for (const lane of this.lanes) {
      for (const sprite of lane.elementSprites.values()) sprite.destroy();
      lane.elementSprites.clear();
    }
    this.lanes = [];
    for (const c of this.cats) c.destroy();
    this.cats = [];
  }
}
