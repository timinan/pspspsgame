import { Scene, GameObjects } from 'phaser';

export interface DrawerItem {
  label: string;
  description: string;
  icon: string;
  /** Stable scene key used to highlight the item matching the current
   *  scene as "you are here" — its onTap becomes a no-op so the player
   *  doesn't restart the scene they're already on. */
  key?: string;
  onTap: () => void;
}

interface TopHudOptions {
  /** Drawer entries — shown when ☰ is tapped. Omit / empty to hide the
   *  hamburger button entirely (useful for scenes where the drawer would
   *  just point at sibling navigation that's already obvious). */
  items?: DrawerItem[];
  /** Show score / coins / hits on the left? Defaults to true. */
  showStats?: boolean;
  /** Show the coins slot inside the stats row. Defaults to true — set
   *  false in scenes where coins are a distraction (Tim's rule:
   *  Game/Rehearse hides coins, only Merch + Set Stage show them). */
  showCoins?: boolean;
  /** Bump the hits/accuracy stack up to a larger size — used in editor
   *  test-mode rehearsal where the author needs the running count
   *  legible at arm's length. */
  bigStats?: boolean;
  /** Scene key for the current scene — used to mark the matching
   *  drawer entry as the active page. */
  currentKey?: string;
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
  private hitsCountText: GameObjects.Text | null = null;
  private hitsPercentText: GameObjects.Text | null = null;
  private hamburgerBg: GameObjects.Rectangle | null = null;
  private hamburgerText: GameObjects.Text | null = null;
  private drawerOpen = false;
  private drawerScrim: GameObjects.Rectangle | null = null;
  private drawerPanel: GameObjects.Container | null = null;
  private items: DrawerItem[] = [];
  private currentKey?: string;
  private modeContainer: GameObjects.Container | null = null;

  constructor(private scene: Scene, options: TopHudOptions = {}) {
    this.items = options.items ?? [];
    if (options.currentKey !== undefined) this.currentKey = options.currentKey;
    const showStats = options.showStats !== false;
    const w = scene.scale.width;

    // TopHud sits above EVERYTHING (modals, ready modal, summary) so
    // the hamburger remains tappable regardless of what dialog is open.
    // Tim's rule: hamburger overrides any other menu and can switch at
    // any state. Drawer scrim/panel below run at correspondingly higher
    // depths so they overlay the rest of the scene cleanly when opened.
    this.container = scene.add.container(0, 0).setDepth(2000);

    const strip = scene.add
      .rectangle(0, 0, w, TopHud.HEIGHT, 0x0b041a, 0.78)
      .setOrigin(0, 0);
    const stripBorder = scene.add
      .rectangle(0, TopHud.HEIGHT - 1, w, 1, 0xc0a0e6, 0.25)
      .setOrigin(0, 0);
    this.container.add([strip, stripBorder]);

    if (showStats) {
      // Compact stat layout: leading icon + number, no "Score" / "Best"
      // prefixes. At 5-6 digit numbers the old text was overflowing the
      // hamburger on the right; this keeps the row inside 320 px even
      // with five-digit scores.
      this.scoreText = scene.add
        .text(8, TopHud.HEIGHT / 2, '🎵 0', {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '13px',
          color: '#ffffff',
        })
        .setOrigin(0, 0.5);

      const showCoins = options.showCoins !== false;
      if (showCoins) {
        this.coinsText = scene.add
          .text(112, TopHud.HEIGHT / 2, '🪙 0', {
            fontFamily: 'Pixeloid Sans, sans-serif',
            fontStyle: 'bold',
            fontSize: '13px',
            color: '#ffd34d',
          })
          .setOrigin(0, 0.5);
      }

      // Slot 3: hits + percentage. Two separate Text objects laid out
      // side-by-side (count on the left, percentage on the right) in
      // white so they both read clearly against the dark strip.
      // `bigStats` bumps the size for the editor test-mode rehearsal
      // where the author needs the numbers legible at a glance.
      const hitsLeftX = showCoins ? 196 : 112;
      const hitsFontSize = options.bigStats ? '13px' : '10px';
      const hitsFontStyle = {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: hitsFontSize,
        color: '#ffffff',
      };
      this.hitsCountText = scene.add
        .text(hitsLeftX, TopHud.HEIGHT / 2, '0/0', hitsFontStyle)
        .setOrigin(0, 0.5);
      // Percent sits flush against the hamburger button area — anchor
      // origin to the right edge so it doesn't collide with the ☰.
      const hamburgerLeftEdge = w - 44;
      this.hitsPercentText = scene.add
        .text(hamburgerLeftEdge - 6, TopHud.HEIGHT / 2, '0%', hitsFontStyle)
        .setOrigin(1, 0.5);

      const slotChildren = [this.scoreText, this.hitsCountText, this.hitsPercentText];
      if (this.coinsText) slotChildren.splice(1, 0, this.coinsText);
      this.container.add(slotChildren);
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
  setStats(score: number, coins: number, hits: number, judged: number): void {
    this.scoreText?.setText(`🎵 ${score.toLocaleString()}`);
    if (this.coinsText) this.coinsText.setText(`🪙 ${coins}`);
    const pct = judged > 0 ? Math.round((hits / judged) * 100) : 0;
    this.hitsCountText?.setText(`${hits}/${judged}`);
    this.hitsPercentText?.setText(`${pct}%`);
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
      this.hitsCountText?.setVisible(true);
      this.hitsPercentText?.setVisible(true);
      this.hamburgerBg?.setVisible(true);
      this.hamburgerText?.setVisible(true);
      return;
    }

    // Hide stats but keep hamburger visible in edit/placing modes
    this.scoreText?.setVisible(false);
    this.coinsText?.setVisible(false);
    this.hitsCountText?.setVisible(false);
    this.hitsPercentText?.setVisible(false);

    const w = this.scene.scale.width;
    this.modeContainer = this.scene.add.container(0, 0).setDepth(2000);

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

    // DONE/CANCEL sits to the left of the hamburger (hamburger lives at w-28)
    const btnBg = this.scene.add
      .rectangle(w - btnW / 2 - 56, TopHud.HEIGHT / 2, btnW, 26, btnColor, 1)
      .setInteractive({ useHandCursor: true });
    if (mode === 'placing') {
      btnBg.setStrokeStyle(1, 0xc0a0e6, 0.4);
    }
    const btnLabel = this.scene.add
      .text(w - btnW / 2 - 56, TopHud.HEIGHT / 2, btnText, {
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

    // Scrim + panel both cover the FULL canvas (including the top
    // banner area). Tim's rule: hamburger drawer overlays everything
    // when open. The hamburger button itself sits at TopHud depth 2000,
    // below the scrim (2100), so tapping its spot while open just
    // closes the drawer via the scrim's pointerdown handler.
    this.drawerScrim = this.scene.add
      .rectangle(0, 0, width, height, 0x0b041a, 0)
      .setOrigin(0, 0)
      .setDepth(2100)
      .setInteractive();
    this.drawerScrim.on('pointerdown', () => this.closeDrawer());
    this.scene.tweens.add({ targets: this.drawerScrim, alpha: 0.55, duration: 200 });

    const panelW = Math.min(280, Math.floor(width * 0.78));
    const panel = this.scene.add.container(width, 0).setDepth(2101);
    const panelBg = this.scene.add
      .rectangle(0, 0, panelW, height, 0x2c1856, 1)
      .setOrigin(0, 0);
    panelBg.setStrokeStyle(2, 0xffd34d, 0.35);
    panelBg.setInteractive(); // swallow taps so they don't reach the scrim
    panel.add(panelBg);

    const header = this.scene.add
      .text(28, 24, 'MENU', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '14px',
        color: '#c0a0e6',
        fontStyle: 'bold',
      })
      .setOrigin(0, 0.5);
    panel.add(header);

    // Close ✕ button — top-right of the drawer panel. Standard
    // convention: an explicit close affordance so the player isn't
    // forced to tap outside the panel or stab the hamburger again.
    const closeR = 14;
    const closeX = panelW - 26;
    const closeY = 24;
    const closeBg = this.scene.add
      .circle(closeX, closeY, closeR, 0x0b041a, 0.85)
      .setStrokeStyle(2, 0xc0a0e6, 0.6)
      .setInteractive({ useHandCursor: true });
    const closeText = this.scene.add
      .text(closeX, closeY, '✕', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontStyle: 'bold',
        fontSize: '14px',
        color: '#c0a0e6',
      })
      .setOrigin(0.5);
    closeBg.on('pointerover', () => closeBg.setFillStyle(0x3d2566, 0.95));
    closeBg.on('pointerout', () => closeBg.setFillStyle(0x0b041a, 0.85));
    closeBg.on('pointerdown', () => this.closeDrawer());
    panel.add([closeBg, closeText]);

    // Bigger item layout — Tim's note: lots of space below the menu, so
    // bump font + height. Labels stay one line (wordWrap + maxLines 1),
    // description sits beneath in a slightly smaller font.
    const itemH = 58;
    const itemSpacing = 66;
    const labelWrap = panelW - 32 - 64;
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i]!;
      const isCurrent = !!this.currentKey && item.key === this.currentKey;
      const y = 64 + i * itemSpacing;
      const itemBg = this.scene.add
        .rectangle(16, y, panelW - 32, itemH, isCurrent ? 0x4d2d8c : 0x0b041a, isCurrent ? 0.85 : 0.6)
        .setOrigin(0, 0)
        .setInteractive({ useHandCursor: !isCurrent });
      itemBg.setStrokeStyle(isCurrent ? 2 : 1, isCurrent ? 0xffd34d : 0xc0a0e6, isCurrent ? 1 : 0.3);

      const icon = this.scene.add
        .text(44, y + itemH / 2, item.icon, {
          fontSize: '22px',
        })
        .setOrigin(0.5);

      const labelColor = isCurrent ? '#ffd34d' : '#ffffff';
      const descColor = isCurrent ? '#fff0aa' : '#c0a0e6';
      // Use the "●" prefix instead of suffix so the active-state marker
      // never lands beyond the wrap width and forces "MEOWCERT" onto a
      // truncated second line (Tim caught "PUT ON A" alone in the
      // drawer). Single-line label, no wordWrap — the font is tuned so
      // even the longest label ("PUT ON A MEOWCERT") fits in the slot.
      const labelText = isCurrent ? `● ${item.label}` : item.label;
      const label = this.scene.add
        .text(76, y + 14, labelText, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontStyle: 'bold',
          fontSize: '11px',
          color: labelColor,
        })
        .setOrigin(0, 0);

      const desc = this.scene.add
        .text(76, y + 33, isCurrent ? 'you are here' : item.description, {
          fontFamily: 'Pixeloid Sans, sans-serif',
          fontSize: '10px',
          color: descColor,
          wordWrap: { width: labelWrap },
          maxLines: 1,
        })
        .setOrigin(0, 0);

      panel.add([itemBg, icon, label, desc]);

      if (!isCurrent) {
        itemBg.on('pointerover', () => itemBg.setFillStyle(0xffd34d, 0.18));
        itemBg.on('pointerout', () => itemBg.setFillStyle(0x0b041a, 0.6));
        itemBg.on('pointerdown', () => {
          // Fire the action immediately. scene.start() handles its own teardown.
          this.closeDrawer();
          try {
            item.onTap();
          } catch (err) {
            console.error('[TopHud] drawer item onTap threw:', err);
          }
        });
      } else {
        // "you are here" — tap closes the drawer so the player still gets a
        // tactile response without restarting the current scene.
        itemBg.on('pointerdown', () => this.closeDrawer());
      }
    }

    const hint = this.scene.add
      .text(panelW / 2, height - 24, 'tap outside to close', {
        fontFamily: 'Pixeloid Sans, sans-serif',
        fontSize: '9px',
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

    // Keep `drawerPanel`/`drawerScrim` set during the close animation. If
    // we nulled them here and the close tween was later killed by a scene
    // shutdown (Game.cleanup runs tweens.killAll), the onComplete would
    // never destroy them — they'd survive in scene.displayList as
    // orphaned input-catching ghosts. The tween onComplete nulls each
    // field only on natural completion; the synchronous destroy() path
    // tears them down if the tween dies.
    if (this.drawerPanel) {
      const panel = this.drawerPanel;
      this.scene.tweens.add({
        targets: panel,
        x: width,
        duration: 160,
        ease: 'Quad.easeIn',
        onComplete: () => {
          panel.destroy(true);
          if (this.drawerPanel === panel) this.drawerPanel = null;
        },
      });
    }
    if (this.drawerScrim) {
      const scrim = this.drawerScrim;
      this.scene.tweens.add({
        targets: scrim,
        alpha: 0,
        duration: 160,
        onComplete: () => {
          scrim.destroy();
          if (this.drawerScrim === scrim) this.drawerScrim = null;
        },
      });
    }

    this.hamburgerText?.setText('☰');
    this.hamburgerBg?.setFillStyle(0xffd34d, 1);
    this.hamburgerText?.setColor('#1a0a2e');
  }

  destroy(): void {
    // Belt-and-suspenders teardown — closeDrawer schedules the visual
    // outbound animation, but Game.cleanup runs tweens.killAll which kills
    // that tween before its onComplete fires. The scrim is interactive,
    // so if it survives this scene transition it eats every click in the
    // next scene and the game appears frozen. Force-destroy synchronously.
    if (this.drawerPanel) {
      this.scene.tweens.killTweensOf(this.drawerPanel);
      this.drawerPanel.destroy(true);
      this.drawerPanel = null;
    }
    if (this.drawerScrim) {
      this.scene.tweens.killTweensOf(this.drawerScrim);
      this.drawerScrim.destroy();
      this.drawerScrim = null;
    }
    this.drawerOpen = false;
    this.modeContainer?.destroy(true);
    this.scene.tweens.killTweensOf(this.container);
    this.container.destroy(true);
  }
}
