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
  /** Y position for the picker row's vertical center. Defaults to
   *  42% of canvas height (legacy intro placement). */
  centerY?: number;
  /** When true (default false), allows re-tapping a different card to
   *  change selection. When false, the first tap is final and the
   *  picker locks after the tap-pulse. */
  allowReselect?: boolean;
  /** Card id to highlight on initial render. Doesn't fire onPick —
   *  caller is expected to manage the initial side-effects. Useful
   *  for "default to the first option" UX. */
  defaultSelectedId?: string;
}

const CARD_FILL = 0x261540;
const CARD_STROKE = 0xc678ff;
const CARD_STROKE_SELECTED = 0xffd34d;
const CARD_FILL_HOVER = 0x382057;
const CARD_FILL_SELECTED = 0x4a2c7a;
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

  private selectedId: string | undefined;
  private cardChromeBySlot: Array<{ card: GameObjects.Rectangle; sprite: GameObjects.Image | GameObjects.Sprite; label: GameObjects.Text; id: string }> = [];

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
    const y = this.opts.centerY ?? height * 0.42;

    this.container = this.scene.add.container(0, 0);
    this.container.setDepth(1500);

    // After build, apply selection chrome so the default-selected
    // card is visually highlighted on first render.
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

      this.cardChromeBySlot.push({ card, sprite, label, id: item.id });

      // Default selected card paint (no onPick fire — caller handles
      // the initial side-effects).
      if (this.opts.defaultSelectedId && item.id === this.opts.defaultSelectedId) {
        this.selectedId = item.id;
      }

      // Selection
      card.on('pointerdown', () => {
        if (this.busy) return;
        const allowReselect = this.opts.allowReselect ?? false;
        if (!allowReselect) {
          this.busy = true;
        }
        // Pulse animation — quick yellow tint + scale punch before
        // firing the callback. Reads as "selected, locking in".
        // Scale-by-multiplier (not absolute) so the sprite's fit-scale
        // is preserved through the pulse.
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
          onComplete: () => {
            this.selectedId = item.id;
            // Repaint card chromes to reflect selection state.
            this.applySelectionChrome();
            this.opts.onPick(item.id);
          },
        });
      });
    });

    // Apply initial selection chrome — paints the default-highlighted
    // card (if any) without firing onPick. Caller wires the initial
    // side-effects after constructing the Picker.
    if (this.selectedId) this.applySelectionChrome();
  }

  /** After a card is tapped, re-paint every card chrome so the selected
   *  one gets the yellow stroke + lighter fill, and the others go back
   *  to defaults. Called automatically by the tap handler. */
  private applySelectionChrome(): void {
    for (const chrome of this.cardChromeBySlot) {
      const isSelected = chrome.id === this.selectedId;
      chrome.card.setStrokeStyle(2, isSelected ? CARD_STROKE_SELECTED : CARD_STROKE, 1);
      chrome.card.setFillStyle(isSelected ? CARD_FILL_SELECTED : CARD_FILL, 1);
    }
  }

  destroy(): void {
    if (this.container) {
      this.scene.tweens.killTweensOf(this.container);
      this.container.destroy(true);
      this.container = undefined;
    }
  }
}
