import { Scene, GameObjects } from 'phaser';

/**
 * 1-of-3 picker — side-by-side cards with a sprite + label. The
 * tutorial's pick-stage + pick-cat steps both use this component;
 * the only thing that differs per use-site is the textureKey of each
 * card.
 *
 * Selection is one-shot — tapping a card calls onPick(id) and is
 * expected to be torn down by the caller (via picker.destroy()) when
 * the orchestrator advances.
 *
 * Visual: each card is a rounded purple rectangle with the sprite
 * inside + the label below. Tapped card briefly tints yellow + pulses
 * before the onPick callback fires (visual confirmation matches the
 * box-open animation's pre-reveal tease).
 */

interface PickerItem<T> {
  id: T;
  /** Texture key to render in the card (theme thumb key for stages,
   *  cat atlas frame for cats). */
  imageKey: string;
  /** Optional atlas frame name. When supplied the textureKey is the
   *  atlas; when omitted the imageKey is a standalone texture. */
  frame?: string;
  label: string;
}

interface PickerOptions<T> {
  items: ReadonlyArray<PickerItem<T>>;
  onPick: (id: T) => void;
  /** Override the card width — useful for narrow viewports. Defaults
   *  to fill-the-canvas-minus-margins. */
  cardW?: number;
  cardH?: number;
}

const CARD_FILL = 0x261540;
const CARD_STROKE = 0xc678ff;
const CARD_FILL_HOVER = 0x382057;
const LABEL_COLOR = '#ffffff';
const PULSE_TINT = 0xffd34d;

export class Picker<T extends string> {
  private container: GameObjects.Container | undefined;
  private scene: Scene;
  private opts: PickerOptions<T>;
  private busy = false;

  constructor(scene: Scene, opts: PickerOptions<T>) {
    this.scene = scene;
    this.opts = opts;
    this.build();
  }

  private build(): void {
    const { width, height } = this.scene.scale;
    const items = this.opts.items;
    if (items.length === 0) return;

    const margin = 12;
    const gap = 8;
    const cardW = this.opts.cardW ?? Math.floor((width - margin * 2 - gap * (items.length - 1)) / items.length);
    const cardH = this.opts.cardH ?? Math.floor(cardW * 1.35);
    const totalW = cardW * items.length + gap * (items.length - 1);
    const startX = (width - totalW) / 2;
    const y = height * 0.42;

    this.container = this.scene.add.container(0, 0);
    this.container.setDepth(1500);

    items.forEach((item, i) => {
      const x = startX + i * (cardW + gap);

      const card = this.scene.add
        .rectangle(x + cardW / 2, y, cardW, cardH, CARD_FILL, 1)
        .setStrokeStyle(2, CARD_STROKE, 1)
        .setInteractive({ useHandCursor: true });
      this.container!.add(card);

      // Sprite — fills the top ~80% of the card. Aspect-preserved fit:
      // scale so the source fully fits inside spriteW × spriteH WITHOUT
      // stretching. Cat atlas frames are 91 × 64 (landscape) and would
      // squish vertically if forced into a portrait card via the
      // previous setDisplaySize call — Tim flagged this in feedback.
      const spriteY = y - cardH * 0.1;
      const spriteW = cardW - 16;
      const spriteH = cardH * 0.75;
      let sprite: GameObjects.Image | GameObjects.Sprite;
      if (item.frame) {
        sprite = this.scene.add.sprite(x + cardW / 2, spriteY, item.imageKey, item.frame);
      } else {
        sprite = this.scene.add.image(x + cardW / 2, spriteY, item.imageKey);
      }
      const sourceW = sprite.width;
      const sourceH = sprite.height;
      const fitScale = Math.min(spriteW / sourceW, spriteH / sourceH);
      sprite.setScale(fitScale);
      this.container!.add(sprite);

      // Label
      const label = this.scene.add
        .text(x + cardW / 2, y + cardH / 2 - 14, item.label, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '10px',
          color: LABEL_COLOR,
          align: 'center',
          wordWrap: { width: cardW - 12 },
        })
        .setOrigin(0.5, 0.5);
      this.container!.add(label);

      // Hover affordance
      card.on('pointerover', () => {
        if (this.busy) return;
        card.setFillStyle(CARD_FILL_HOVER, 1);
      });
      card.on('pointerout', () => {
        if (this.busy) return;
        card.setFillStyle(CARD_FILL, 1);
      });

      // Selection
      card.on('pointerdown', () => {
        if (this.busy) return;
        this.busy = true;
        // Pulse animation — quick yellow tint + scale punch before
        // firing the callback. Reads as "selected, locking in".
        // Scale-by-multiplier (not absolute) so the sprite's fit-scale
        // is preserved through the pulse.
        card.setFillStyle(PULSE_TINT, 1);
        const cardOrigScale = card.scaleX;
        const spriteOrigScale = sprite.scaleX;
        const labelOrigScale = label.scaleX;
        this.scene.tweens.add({
          targets: { t: 1 },
          t: 1.06,
          duration: 120,
          yoyo: true,
          onUpdate: (tw) => {
            const t = (tw.getValue() ?? 1) as number;
            card.setScale(cardOrigScale * t);
            sprite.setScale(spriteOrigScale * t);
            label.setScale(labelOrigScale * t);
          },
          onComplete: () => this.opts.onPick(item.id),
        });
      });
    });
  }

  destroy(): void {
    if (this.container) {
      this.scene.tweens.killTweensOf(this.container);
      this.container.destroy(true);
      this.container = undefined;
    }
  }
}
