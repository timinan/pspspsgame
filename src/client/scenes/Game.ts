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
import type { CatBreed, CatModel, InteractionType } from '@/types/game';

const CAT_SEAT_POSITIONS: { x: number; y: number }[] = [
  { x: 0.25, y: 0.6 },
  { x: 0.5, y: 0.5 },
  { x: 0.75, y: 0.62 },
];

const CAT_BREEDS_IN_ORDER: CatBreed[] = ['cat1', 'cat2', 'cat3'];

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
const BOTTOM_LANE_Y_FROM_BOTTOM = 80;
const PSPSPS_BAR_WIDTH_FRACTION = 0.8;
const PSPSPS_TARGET_DISPLAY_SIZE = 52;
const PSPSPS_ELEMENT_DISPLAY_WIDTH = 48;
const PSPSPS_ELEMENT_DISPLAY_HEIGHT = 44;
// Tap-zone vertical half-height around each lane center. Slightly bigger
// than LANE_SPACING / 2 so a tap that lands right between two lanes still
// resolves on the closer one without dead-zoning the gap.
const LANE_TAP_TOLERANCE = LANE_SPACING / 2 + 4;

// Per-lane color palette. Index 0 = bottom lane, last index = top lane.
// Two tints per lane so the bars stay soft/pastel while the floating
// pspsps elements pop with a more saturated version of the same color.
// 0xffffff means "no tint" (multiplies the texture by white = unchanged).
interface LaneColor {
  bar: number;     // bar background + target circle
  element: number; // the floating pspsps balls
}

const LANE_COLORS: LaneColor[] = [
  { bar: 0xfff3b0, element: 0xffd84a }, // bottom — soft yellow / saturated yellow
  { bar: 0xffffff, element: 0xffffff }, // middle — original
  { bar: 0xffb0c8, element: 0xff6b9d }, // top — soft pink / saturated pink
];

// Temporarily off while we tune the rhythm bar in isolation.
// When ready, flip this to true to re-enable the cat-petting mini-game.
const INTERACTION_ENABLED = false;

interface PspspsLane {
  index: number;
  system: RhythmSystem;
  barBg: GameObjects.Image;
  target: GameObjects.Image;
  targetBaseScale: number;
  elementSprites: Map<string, GameObjects.Image>;
  centerY: number;
  color: LaneColor;
}

export class Game extends Scene {
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
  private meowBarFillRect!: GameObjects.Rectangle;

  // Interaction state
  private interactionActive = false;
  private activeCat: Cat | null = null;
  private interactionButtons: GameObjects.Container | null = null;
  private drainTimer: Time.TimerEvent | null = null;

  // HUD
  private coins = 0;
  private hudScoreText!: GameObjects.Text;
  private hudCoinsText!: GameObjects.Text;

  // Music + sfx
  private music: Sound.BaseSound | null = null;
  private pspspsSfx: Sound.BaseSound | null = null;
  private musicStarted = false;

  constructor() {
    super(SceneKeys.Game);
  }

  create() {
    // Background fills the canvas
    const bg = this.add.image(0, 0, AssetKeys.Image.GameBackground).setOrigin(0, 0);
    bg.displayWidth = this.scale.width;
    bg.displayHeight = this.scale.height;

    // Systems
    this.score = new ScoreSystem();
    this.meow = new MeowBarSystem();
    this.interaction = new InteractionSystem();
    this.selector = new CatSelectionSystem();

    // Pre-create the pspsps sfx instance so we can replay it fast on every hit
    this.pspspsSfx = this.sound.add(AssetKeys.Audio.Pspsps, { volume: 0.7 });

    // Spawn the base cats
    for (let i = 0; i < Balance.baseCatsOnScreen; i++) {
      const breed = CAT_BREEDS_IN_ORDER[i % CAT_BREEDS_IN_ORDER.length]!;
      const seat = CAT_SEAT_POSITIONS[i]!;
      const model: CatModel = {
        id: `seat-${i}`,
        breed,
        animation: 'idle',
        x: seat.x * 100,
        y: seat.y * 100,
      };
      const cat = new Cat(this, model);
      cat.setPosition(seat.x * this.scale.width, seat.y * this.scale.height);
      this.cats.push(cat);
    }

    this.createLanes();
    this.createMeowBar();
    this.createHud();
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
    for (const lane of this.lanes) {
      lane.system.advance(delta);
      this.syncLaneElements(lane);
    }
    this.updateMeowBar();
    this.updateHud();
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
      const color = LANE_COLORS[i] ?? { bar: 0xffffff, element: 0xffffff };
      const system = new RhythmSystem();

      const barBg = this.add.image(barX, centerY, AssetKeys.Image.RhythmBarBackground);
      barBg.displayWidth = barWidth;
      barBg.displayHeight = PSPSPS_BAR_HEIGHT;
      barBg.setTint(color.bar);

      const targetX = barLeft + barWidth * system.getTargetFraction();
      const target = this.add.image(targetX, centerY, AssetKeys.Image.PspspsTarget);
      target.setDisplaySize(PSPSPS_TARGET_DISPLAY_SIZE, PSPSPS_TARGET_DISPLAY_SIZE);
      target.setTint(color.bar);
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
        sprite = this.add.image(0, lane.centerY, AssetKeys.Image.PspspsElement);
        sprite.setDisplaySize(PSPSPS_ELEMENT_DISPLAY_WIDTH, PSPSPS_ELEMENT_DISPLAY_HEIGHT);
        sprite.setTint(lane.color.element);
        lane.elementSprites.set(el.id, sprite);
      }
      sprite.x = barLeft + barWidth * el.fraction;
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
    // Sit above the top-most rhythm lane with a bit of breathing room.
    const topLaneY = h - BOTTOM_LANE_Y_FROM_BOTTOM - (LANE_COUNT - 1) * LANE_SPACING;
    const barY = topLaneY - 50;

    this.meowBarOutline = this.add.image(w / 2, barY, AssetKeys.Image.MeowBarOutline);
    this.meowBarOutline.displayWidth = barWidth;
    this.meowBarOutline.displayHeight = 32;

    this.meowBarFill = this.add.image(w / 2 - barWidth / 2, barY, AssetKeys.Image.MeowBarFill);
    this.meowBarFill.setOrigin(0, 0.5);
    this.meowBarFill.displayWidth = barWidth;
    this.meowBarFill.displayHeight = 32;

    this.meowBarFillRect = this.add
      .rectangle(w / 2 - barWidth / 2, barY, 0, 40, 0xffffff)
      .setOrigin(0, 0.5);
    this.meowBarFillRect.setVisible(false);
    const mask = this.meowBarFillRect.createGeometryMask();
    this.meowBarFill.setMask(mask);
  }

  private updateMeowBar(): void {
    if (!this.meowBarFillRect) return;
    const w = this.scale.width;
    const barWidth = w * 0.6;
    const pct = this.meow.getProgress() / Balance.meowBarMax;
    this.meowBarFillRect.width = barWidth * pct;
  }

  // -- HUD ----------------------------------------------------------------

  private createHud(): void {
    this.hudScoreText = this.add.text(16, 16, 'Score: 0', {
      fontFamily: 'sans-serif',
      fontSize: '18px',
      color: '#ffffff',
    });
    this.hudCoinsText = this.add.text(16, 40, '🪙 0', {
      fontFamily: 'sans-serif',
      fontSize: '18px',
      color: '#ffd34d',
    });
  }

  private updateHud(): void {
    this.hudScoreText?.setText(`Score: ${this.score.get()}`);
    this.hudCoinsText?.setText(`🪙 ${this.coins}`);
  }

  // -- Input + scoring ----------------------------------------------------

  private setupInput(): void {
    this.input.on(
      'pointerdown',
      (pointer: { x: number; y: number }) => {
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
      this.score.add(result.pointsAwarded);
      this.meow.onScoreChanged(this.score.get());
      this.pspspsSfx?.play();
      this.pulseLaneTarget(lane);
      this.flashScore(lane, result.pointsAwarded, result.perfectHits > 0);
    }

    if (this.meow.isFull()) {
      if (INTERACTION_ENABLED) {
        this.beginInteraction();
      } else {
        // Cycle the meow bar so it keeps showing progress without triggering
        // the (currently buggy) cat-petting handoff.
        this.meow.reset();
      }
    }
  }

  private flashScore(lane: PspspsLane, points: number, isPerfect: boolean): void {
    const label = isPerfect ? `PERFECT +${points}` : `+${points}`;
    // Perfect always reads green so the bonus is unmistakable; partial hits
    // tint to match the lane that scored (using the saturated element color
    // so it's clearly visible).
    const laneHex = `#${lane.color.element.toString(16).padStart(6, '0')}`;
    const color = isPerfect ? '#00ff88' : laneHex;
    const text = this.add
      .text(lane.target.x, lane.centerY - 40, label, {
        fontFamily: 'sans-serif',
        fontSize: '22px',
        color,
        stroke: '#000000',
        strokeThickness: 3,
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

    this.tweens.add({
      targets: this.activeCat.sprite,
      x: this.scale.width / 2,
      y: this.scale.height / 2 + 40,
      scale: 2,
      duration: 400,
      ease: 'Quad.easeOut',
    });
    this.activeCat.setAnimation('meow');

    this.spawnInteractionButtons();

    this.drainTimer = this.time.addEvent({
      delay: Balance.tickDurationMs,
      loop: true,
      callback: () => {
        this.meow.drainTick();
        if (this.meow.isEmpty()) {
          this.endInteraction();
        }
      },
    });
  }

  private spawnInteractionButtons(): void {
    const w = this.scale.width;
    const h = this.scale.height;
    const container = this.add.container(0, 0);
    this.interactionButtons = container;

    const startX = w / 2 - 160;
    for (let i = 0; i < INTERACTION_BUTTON_DEFS.length; i++) {
      const def = INTERACTION_BUTTON_DEFS[i]!;
      const x = startX + i * 160;
      const y = h - 80;
      const chance = InteractionSystem.chanceFor(def.type);

      const bg = this.add.rectangle(x, y, 140, 56, 0x222222, 0.85);
      bg.setStrokeStyle(2, 0xffffff);
      bg.setInteractive({ useHandCursor: true });

      const label = this.add
        .text(x, y - 8, def.label, {
          fontFamily: 'sans-serif',
          fontSize: '16px',
          color: '#ffffff',
        })
        .setOrigin(0.5);

      const chanceText = this.add
        .text(x, y + 14, `${Math.round(chance * 100)}%`, {
          fontFamily: 'sans-serif',
          fontSize: '12px',
          color: '#ffd34d',
        })
        .setOrigin(0.5);

      bg.on('pointerdown', () => this.resolveInteraction(def.type));
      container.add([bg, label, chanceText]);
    }
  }

  private resolveInteraction(type: InteractionType): void {
    if (!this.activeCat) return;
    const result = this.interaction.resolve(type);

    if (result.outcome === 'success') {
      this.coins += result.coinsAwarded;
      this.activeCat.setAnimation('happy');
    } else {
      this.activeCat.setAnimation('hiss');
    }

    const feedback = this.add
      .text(
        this.scale.width / 2,
        this.scale.height / 2 - 100,
        result.outcome === 'success' ? `+${result.coinsAwarded} coins` : 'Hiss!',
        {
          fontFamily: 'sans-serif',
          fontSize: '24px',
          color: result.outcome === 'success' ? '#00ff88' : '#ff4444',
        },
      )
      .setOrigin(0.5);
    this.tweens.add({
      targets: feedback,
      alpha: 0,
      y: feedback.y - 40,
      duration: 800,
      onComplete: () => feedback.destroy(),
    });

    this.time.delayedCall(800, () => this.endInteraction());
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
        duration: 400,
        onComplete: () => {
          cat.setAnimation('idle');
        },
      });
      this.activeCat = null;
    }

    this.interactionButtons?.destroy(true);
    this.interactionButtons = null;
    this.drainTimer?.remove();
    this.drainTimer = null;
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
    this.drainTimer?.remove();
    this.drainTimer = null;
    this.spawnTimer?.remove();
    this.spawnTimer = null;
    this.interactionButtons?.destroy(true);
    this.interactionButtons = null;
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
