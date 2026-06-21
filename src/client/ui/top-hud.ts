import { Scene, GameObjects } from 'phaser';

export interface DrawerItem {
  label: string;
  description: string;
  icon: string;
  onTap: () => void;
}

interface TopHudOptions {
  /** Drawer entries — shown when ☰ is tapped. Omit / empty to hide the
   *  hamburger button entirely (useful for scenes where the drawer would
   *  just point at sibling navigation that's already obvious). */
  items?: DrawerItem[];
  /** Show score / coins / best on the left? Defaults to true. */
  showStats?: boolean;
}

/**
 * Slim 44px top strip with score / coins / best on the left and a
 * hamburger button on the right that slides a drawer in from the right
 * edge. Shared across Game, Boxes, and Collection so the navigation
 * pattern stays consistent and the top-left HUD never overlaps the
 * left-ledge cat anymore.
 */
export class TopHud {
  static readonly HEIGHT = 44;

  private container: GameObjects.Container;
  private scoreText: GameObjects.Text | null = null;
  private coinsText: GameObjects.Text | null = null;
  private bestText: GameObjects.Text | null = null;
  private hamburgerBg: GameObjects.Rectangle | null = null;
  private hamburgerText: GameObjects.Text | null = null;
  private drawerOpen = false;
  private drawerScrim: GameObjects.Rectangle | null = null;
  private drawerPanel: GameObjects.Container | null = null;
  private items: DrawerItem[] = [];
  private modeContainer: GameObjects.Container | null = null;

  constructor(private scene: Scene, options: TopHudOptions = {}) {
    this.items = options.items ?? [];
    const showStats = options.showStats !== false;
    const w = scene.scale.width;

    this.container = scene.add.container(0, 0).setDepth(100);

    const strip = scene.add
      .rectangle(0, 0, w, TopHud.HEIGHT, 0x0b041a, 0.78)
      .setOrigin(0, 0);
    const stripBorder = scene.add
      .rectangle(0, TopHud.HEIGHT - 1, w, 1, 0xc0a0e6, 0.25)
      .setOrigin(0, 0);
    this.container.add([strip, stripBorder]);

    if (showStats) {
      this.scoreText = scene.add
        .text(14, TopHud.HEIGHT / 2, 'Score 0', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '14px',
          color: '#ffffff',
        })
        .setOrigin(0, 0.5);

      this.coinsText = scene.add
        .text(120, TopHud.HEIGHT / 2, '🪙 0', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '14px',
          color: '#ffd34d',
        })
        .setOrigin(0, 0.5);

      this.bestText = scene.add
        .text(212, TopHud.HEIGHT / 2, 'Best 0', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontSize: '11px',
          color: '#c0a0e6',
        })
        .setOrigin(0, 0.5);

      this.container.add([this.scoreText, this.coinsText, this.bestText]);
    }

    if (this.items.length > 0) {
      const hamX = w - 28;
      const hamY = TopHud.HEIGHT / 2;
      this.hamburgerBg = scene.add
        .rectangle(hamX, hamY, 30, 30, 0xffd34d, 1)
        .setInteractive({ useHandCursor: true });
      this.hamburgerText = scene.add
        .text(hamX, hamY, '☰', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '18px',
          color: '#1a0a2e',
        })
        .setOrigin(0.5);
      this.container.add([this.hamburgerBg, this.hamburgerText]);
      this.hamburgerBg.on('pointerdown', () => this.toggleDrawer());
    }
  }

  /** Push score / coins / best updates. Call from the scene's update loop. */
  setStats(score: number, coins: number, best: number): void {
    this.scoreText?.setText(`Score ${score.toLocaleString()}`);
    this.coinsText?.setText(`🪙 ${coins}`);
    this.bestText?.setText(`Best ${best.toLocaleString()}`);
  }

  /** Just the coins — handy for Boxes where score isn't tracked. */
  setCoins(coins: number): void {
    this.coinsText?.setText(`🪙 ${coins}`);
  }

  /** Switch TopHud into one of three modes:
   *   - 'default': stats + hamburger drawer
   *   - 'edit':    "🏠 EDITING HOME" + green DONE button
   *   - 'placing': "📍 PLACING [item]" + grey CANCEL button
   */
  setMode(
    mode: 'default' | 'edit' | 'placing',
    opts?: { itemName?: string; onDone?: () => void; onCancel?: () => void }
  ): void {
    this.modeContainer?.destroy(true);
    this.modeContainer = null;

    if (mode === 'default') {
      this.scoreText?.setVisible(true);
      this.coinsText?.setVisible(true);
      this.bestText?.setVisible(true);
      this.hamburgerBg?.setVisible(true);
      this.hamburgerText?.setVisible(true);
      return;
    }

    // Hide normal HUD
    this.scoreText?.setVisible(false);
    this.coinsText?.setVisible(false);
    this.bestText?.setVisible(false);
    this.hamburgerBg?.setVisible(false);
    this.hamburgerText?.setVisible(false);

    const w = this.scene.scale.width;
    this.modeContainer = this.scene.add.container(0, 0).setDepth(100);

    const labelText = mode === 'edit'
      ? '🏠 EDITING HOME'
      : `📍 PLACING ${opts?.itemName ?? 'item'}`;

    const label = this.scene.add
      .text(14, TopHud.HEIGHT / 2, labelText, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '12px',
        color: '#ffd34d',
      })
      .setOrigin(0, 0.5);
    this.modeContainer.add(label);

    const btnText = mode === 'edit' ? 'DONE' : 'CANCEL';
    const btnColor = mode === 'edit' ? 0x4dffb4 : 0x2c1856;
    const btnTextColor = mode === 'edit' ? '#0b041a' : '#c0a0e6';
    const btnW = mode === 'edit' ? 48 : 60;

    const btnBg = this.scene.add
      .rectangle(w - btnW / 2 - 12, TopHud.HEIGHT / 2, btnW, 26, btnColor, 1)
      .setInteractive({ useHandCursor: true });
    if (mode === 'placing') {
      btnBg.setStrokeStyle(1, 0xc0a0e6, 0.4);
    }
    const btnLabel = this.scene.add
      .text(w - btnW / 2 - 12, TopHud.HEIGHT / 2, btnText, {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '11px',
        color: btnTextColor,
      })
      .setOrigin(0.5);

    this.modeContainer.add([btnBg, btnLabel]);

    const handler = mode === 'edit' ? opts?.onDone : opts?.onCancel;
    if (handler) {
      btnBg.on('pointerdown', handler);
    }
  }

  isDrawerOpen(): boolean { return this.drawerOpen; }

  toggleDrawer(): void {
    if (this.drawerOpen) this.closeDrawer();
    else this.openDrawer();
  }

  private openDrawer(): void {
    if (this.drawerOpen || this.items.length === 0) return;
    this.drawerOpen = true;

    const { width, height } = this.scene.scale;

    this.drawerScrim = this.scene.add
      .rectangle(0, TopHud.HEIGHT, width, height - TopHud.HEIGHT, 0x0b041a, 0)
      .setOrigin(0, 0)
      .setDepth(200)
      .setInteractive();
    this.drawerScrim.on('pointerdown', () => this.closeDrawer());
    this.scene.tweens.add({ targets: this.drawerScrim, alpha: 0.55, duration: 200 });

    const panelW = Math.min(280, Math.floor(width * 0.78));
    const panel = this.scene.add.container(width, TopHud.HEIGHT).setDepth(201);
    const panelBg = this.scene.add
      .rectangle(0, 0, panelW, height - TopHud.HEIGHT, 0x2c1856, 1)
      .setOrigin(0, 0);
    panelBg.setStrokeStyle(2, 0xffd34d, 0.35);
    panelBg.setInteractive(); // swallow taps so they don't reach the scrim
    panel.add(panelBg);

    const header = this.scene.add
      .text(panelW / 2, 22, 'MENU', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '11px',
        color: '#c0a0e6',
        fontStyle: 'bold',
      })
      .setOrigin(0.5, 0);
    panel.add(header);

    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i]!;
      const y = 56 + i * 64;
      const itemBg = this.scene.add
        .rectangle(16, y, panelW - 32, 52, 0x0b041a, 0.6)
        .setOrigin(0, 0)
        .setInteractive({ useHandCursor: true });
      itemBg.setStrokeStyle(1, 0xc0a0e6, 0.3);

      const icon = this.scene.add
        .text(40, y + 26, item.icon, {
          fontSize: '20px',
        })
        .setOrigin(0.5);

      const label = this.scene.add
        .text(68, y + 14, item.label, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '15px',
          color: '#ffffff',
        })
        .setOrigin(0, 0);

      const desc = this.scene.add
        .text(68, y + 32, item.description, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontSize: '10px',
          color: '#c0a0e6',
        })
        .setOrigin(0, 0);

      panel.add([itemBg, icon, label, desc]);

      itemBg.on('pointerover', () => itemBg.setFillStyle(0xffd34d, 0.18));
      itemBg.on('pointerout', () => itemBg.setFillStyle(0x0b041a, 0.6));
      itemBg.on('pointerdown', () => {
        // Schedule the action AFTER the drawer closes so the destination
        // scene starts on a clean slate.
        this.closeDrawer();
        this.scene.time.delayedCall(180, () => item.onTap());
      });
    }

    const hint = this.scene.add
      .text(panelW / 2, height - TopHud.HEIGHT - 28, 'tap outside to close', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '10px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);
    panel.add(hint);

    this.drawerPanel = panel;
    this.scene.tweens.add({
      targets: panel,
      x: width - panelW,
      duration: 200,
      ease: 'Quad.easeOut',
    });

    // ☰ morphs into × so the close affordance reads
    this.hamburgerText?.setText('×');
    this.hamburgerBg?.setFillStyle(0x2c1856, 0.85);
    this.hamburgerText?.setColor('#ffffff');
  }

  closeDrawer(): void {
    if (!this.drawerOpen) return;
    this.drawerOpen = false;

    const { width } = this.scene.scale;

    if (this.drawerPanel) {
      const panel = this.drawerPanel;
      this.drawerPanel = null;
      this.scene.tweens.add({
        targets: panel,
        x: width,
        duration: 160,
        ease: 'Quad.easeIn',
        onComplete: () => panel.destroy(true),
      });
    }
    if (this.drawerScrim) {
      const scrim = this.drawerScrim;
      this.drawerScrim = null;
      this.scene.tweens.add({
        targets: scrim,
        alpha: 0,
        duration: 160,
        onComplete: () => scrim.destroy(),
      });
    }

    this.hamburgerText?.setText('☰');
    this.hamburgerBg?.setFillStyle(0xffd34d, 1);
    this.hamburgerText?.setColor('#1a0a2e');
  }

  destroy(): void {
    this.closeDrawer();
    this.modeContainer?.destroy(true);
    this.scene.tweens.killTweensOf(this.container);
    this.container.destroy(true);
  }
}
