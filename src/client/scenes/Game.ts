import { Scene, Scenes } from 'phaser';
import { SceneKeys } from '@/constants/scenes';
import { AssetKeys } from '@/constants/assets';
import { Balance } from '@/constants/balance';
import { Cat } from '@/entities/cat';
import { ScoreSystem } from '@/systems/score-system';
import { MeowBarSystem } from '@/systems/meow-bar-system';
import { RhythmSystem } from '@/systems/rhythm-system';
import { InteractionSystem } from '@/systems/interaction-system';
import { CatSelectionSystem } from '@/systems/cat-selection-system';
import type { CatBreed, CatModel } from '@/types/game';

const CAT_SEAT_POSITIONS: { x: number; y: number }[] = [
  { x: 0.25, y: 0.6 },
  { x: 0.5, y: 0.5 },
  { x: 0.75, y: 0.62 },
];

const CAT_BREEDS_IN_ORDER: CatBreed[] = ['cat1', 'cat2', 'cat3'];

export class Game extends Scene {
  private cats: Cat[] = [];
  private score!: ScoreSystem;
  private meow!: MeowBarSystem;
  private rhythm!: RhythmSystem;
  private interaction!: InteractionSystem;
  private selector!: CatSelectionSystem;

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
    this.rhythm = new RhythmSystem(this.time.now);
    this.interaction = new InteractionSystem();
    this.selector = new CatSelectionSystem();

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

    // Touch the systems once so TS sees them as "used" until later tasks wire them in.
    // (Will be replaced by real input wiring in Task 16.)
    void this.score;
    void this.rhythm;
    void this.interaction;
    void this.selector;
    void this.meow;

    this.events.once(Scenes.Events.SHUTDOWN, () => this.cleanup());
  }

  private cleanup(): void {
    for (const c of this.cats) c.destroy();
    this.cats = [];
  }
}
