import { GameObjects, Scene } from 'phaser';

export interface MenuRow {
  icon: string;
  label: string;
  action: string;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  priceCoins?: number;
}

export interface DecorMenuArgs {
  isPlaced: boolean;
  displayName: string;
}

export function buildDecorMenu(args: DecorMenuArgs): MenuRow[] {
  return [
    args.isPlaced
      ? { icon: '📤', label: 'Take down', action: 'takedown', primary: true }
      : { icon: '📍', label: 'Place in scene', action: 'place', primary: true },
    { icon: '💰', label: 'Sell', action: 'sell', priceCoins: 25 },
    { icon: '🎁', label: 'Gift (soon)', action: 'gift', disabled: true },
  ];
}

export interface CatMenuArgs {
  isSeated: boolean;
  displayName: string;
}

export function buildCatMenu(args: CatMenuArgs): MenuRow[] {
  return [
    args.isSeated
      ? { icon: '👔', label: 'Dress up', action: 'dressup', primary: true }
      : { icon: '📍', label: 'Seat in scene', action: 'seat', primary: true },
    args.isSeated
      ? { icon: '📤', label: 'Take to bench', action: 'unseat' }
      : { icon: '👔', label: 'Dress up', action: 'dressup' },
    { icon: '🎁', label: 'Gift (soon)', action: 'gift', disabled: true },
    { icon: '🏠', label: 'Rehome', action: 'rehome', danger: true },
  ];
}

/**
 * Reusable popover for tap-on-tray-item menus. Single-active enforcement
 * is the caller's responsibility (call open/close as a pair). Scene-level
 * pointerdown to close-on-tap-outside is the caller's responsibility.
 */
export class ContextMenu {
  private container: GameObjects.Container | null = null;

  constructor(private scene: Scene) {}

  isOpen(): boolean {
    return this.container !== null;
  }

  open(
    x: number,
    y: number,
    rows: MenuRow[],
    onSelect: (action: string) => void,
    opts: { vAlign?: 'center' | 'top' } = {}
  ): void {
    this.close();

    const rowH = 30;
    const w = 160;
    const h = rows.length * rowH + 8;
    const margin = 12;
    const sceneW = this.scene.scale.width;
    const sceneH = this.scene.scale.height;

    // Anchor the menu BESIDE the tap point — to the right by default, or to
    // the left if it would clip the right edge of the canvas. Vertically
    // anchor either centered on `y` (default) or with the menu's TOP at `y`
    // when `opts.vAlign === 'top'`. Then clamp into screen.
    let leftX = x + margin;
    if (leftX + w > sceneW - 6) leftX = x - margin - w;
    if (leftX < 6) leftX = 6;

    let topY = opts.vAlign === 'top' ? y : y - h / 2;
    if (topY < 50) topY = 50;
    if (topY + h > sceneH - 8) topY = sceneH - 8 - h;

    this.container = this.scene.add.container(leftX, topY).setDepth(200);

    const bg = this.scene.add
      .rectangle(0, 0, w, h, 0x2c1856, 0.98)
      .setOrigin(0, 0);
    bg.setStrokeStyle(1, 0xffd34d, 1);
    this.container.add(bg);

    rows.forEach((row, i) => {
      const ry = 4 + i * rowH;
      const rowBg = this.scene.add
        .rectangle(2, ry, w - 4, rowH - 2, row.primary ? 0xffd34d : 0x000000, row.primary ? 0.18 : 0)
        .setOrigin(0, 0)
        .setInteractive({ useHandCursor: !row.disabled });

      const icon = this.scene.add
        .text(14, ry + rowH / 2, row.icon, {
          fontSize: '13px',
        })
        .setOrigin(0.5);

      const labelColor = row.disabled ? '#666' : row.danger ? '#ff8a8a' : row.primary ? '#ffd34d' : '#ffffff';
      const label = this.scene.add
        .text(30, ry + rowH / 2, row.label, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontSize: '11px',
          fontStyle: row.primary ? 'bold' : 'normal',
          color: labelColor,
        })
        .setOrigin(0, 0.5);

      this.container!.add([rowBg, icon, label]);

      if (row.priceCoins !== undefined) {
        const price = this.scene.add
          .text(w - 8, ry + rowH / 2, `+${row.priceCoins}`, {
            fontFamily: 'Pixeloid Sans, sans-serif',
            fontSize: '10px',
            color: '#ffd34d',
          })
          .setOrigin(1, 0.5);
        this.container!.add(price);
      }

      if (!row.disabled) {
        rowBg.on('pointerdown', (_p: unknown, _lx: unknown, _ly: unknown, event: Phaser.Types.Input.EventData) => {
          event.stopPropagation();
          onSelect(row.action);
          this.close();
        });
      }
    });

    // Subtle fade-in
    this.container.setAlpha(0);
    this.scene.tweens.add({
      targets: this.container,
      alpha: 1,
      duration: 150,
      ease: 'Quad.easeOut',
    });
  }

  close(): void {
    if (this.container) {
      this.container.destroy(true);
      this.container = null;
    }
  }

  destroy(): void {
    this.close();
  }
}
